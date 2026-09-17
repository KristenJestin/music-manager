/**
 * Step 1 — `resolve`. Where a source becomes rows.
 *
 * One `import_tracks` per **entry**, with its duration, its tags and whatever the source said
 * about it kept verbatim. Nothing is downloaded.
 *
 * Two kinds of source arrive here, and the difference between them stops at this file:
 *
 *  - **a URL** — the toolbox's `extract`, yt-dlp, one entry per video. What this step has
 *    always done;
 *  - **a folder** (`file://…`) — `services/folder-source.ts`, one entry per audio file, listed
 *    app-side and probed by the toolbox in one request. The entries stop being videos and
 *    become files; everything after this step reads the same columns and cannot tell.
 *
 * Idempotent by construction: if the entries are already there, the step re-reads them and
 * says so. Re-running it after a `--force` refresh replaces the raw payloads without
 * disturbing anything a later step wrote (the mapping, the download path, the fingerprint),
 * because those columns are matched on the entry id, not on the row.
 */
import { eq } from "drizzle-orm";
import { stripReleaseTypePrefix } from "@mm/domain";
import {
  imports,
  importTracks,
  type ImportKind,
  type SourceGap,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { cookieJar } from "#/server/services/cookies.ts";
import { listFolder, type FolderListing } from "#/server/services/folder-source.ts";
import { folderPathOf } from "#/server/services/import-source.ts";
import { admit, refusalOf, sourceRulesOf } from "#/server/services/source-rules.ts";
import type { ExtractEntry, ExtractResult } from "#/server/toolbox/client.ts";
import type { StepResult } from "../machine.ts";
import type { StepContext } from "../context.ts";

/** A URL that points at a channel rather than at a video or a playlist. */
const CHANNEL = /youtube\.com\/(?:channel\/|c\/|user\/|@)/i;

/** The gaps a listing reported, normalised — an older toolbox image sends no field at all. */
export function gapsOf(extract: ExtractResult): readonly SourceGap[] {
  return (extract.unreadable ?? []).map((gap) => ({
    position: gap.position ?? null,
    id: gap.id ?? null,
    reason: gap.reason ?? null,
    code: gap.code,
  }));
}

/** How many entries the source said it had: the ones that came back, plus the ones that did not. */
export function listedCount(extract: ExtractResult): number {
  return extract.entries.length + gapsOf(extract).length;
}

/**
 * What the URL turned out to be.
 *
 * The distinction that matters downstream is `album` vs `playlist`: an album gets one release
 * and one folder, a playlist is a bag of singles. YouTube Music sets the `album` tag on every
 * entry of an album playlist, so a strong majority agreeing on one album name is the signal.
 *
 * **A gap in the listing must not change the answer.** The test for a lone video is made
 * against what the source *listed* — the entries plus the ones the toolbox could not read —
 * because a two-track single whose first video is private is still not one video, and calling
 * it a `single` would send it down the isolated-video path, where the admission rules refuse
 * outright instead of skipping. The album majority is still measured against what actually
 * came back: nothing can be claimed about an entry nobody read, and pretending an unread entry
 * disagrees would demote albums for a reason that has nothing to do with the music.
 */
export function classify(url: string, extract: ExtractResult): ImportKind {
  /*
   * **A folder is not a fifth kind.**
   *
   * `IMPORT_KINDS` stays `album | single | playlist | channel`, and a folder is classified by
   * the same rule as a playlist: one release when the files agree on an album, a bag of
   * singles when they do not. A new enum value would cost a Drizzle migration and would make
   * every `switch` on `kind` in the product — `place`'s folder template, `confirm`'s gate,
   * `match`'s album-versus-recording branch, the Console's chips, `/api/v1`'s filters — wrong
   * by omission, in exchange for restating something `imports.url` already says by carrying a
   * `file://` scheme. The *kind* is a statement about the shape of the music; the **source
   * scheme** is a statement about where it came from, and those are two different facts.
   *
   * The signal is better here than on YouTube, incidentally: an album tag written by whatever
   * tagged these files is a deliberate statement, where YouTube Music's is inferred.
   */
  if (CHANNEL.test(url)) return "channel";
  if (extract.kind === "video" || listedCount(extract) <= 1) return "single";

  const albums = extract.entries.map((entry) => (entry.album ?? "").trim()).filter((a) => a !== "");
  if (albums.length === 0) return "playlist";
  const counts = new Map<string, number>();
  for (const album of albums) counts.set(album, (counts.get(album) ?? 0) + 1);
  const best = Math.max(...counts.values());
  return best / extract.entries.length >= 0.7 ? "album" : "playlist";
}

/**
 * The URL a single entry is downloaded from.
 *
 * A fixture entry carries a realistic-looking `webpage_url` — that is the point of the
 * recording — but the toolbox in fixtures mode refuses anything that is not a `fixture://`
 * URL, and rightly so: fixtures mode must be provably offline. So a fixture playlist is
 * addressed entry by entry with `fixture://<name>?<params>#<index>`, keeping the query string
 * because that is what carries the scenario switches (`?fp=mismatch`).
 */
function entryUrl(entry: ExtractEntry, sourceUrl: string): string {
  if (sourceUrl.toLowerCase().startsWith("fixture://")) {
    const [base] = sourceUrl.split("#");
    return `${base ?? sourceUrl}#${String(entry.index)}`;
  }
  if (entry.webpage_url !== null && entry.webpage_url !== undefined) return entry.webpage_url;
  return `https://youtu.be/${entry.id}`;
}

export async function resolveStep(ctx: StepContext): Promise<StepResult> {
  const existing = await ctx.tracks();
  if (existing.length > 0 && ctx.job.options.force !== true) {
    return {
      status: "done",
      message: `${String(existing.length)} video(s) already resolved`,
      data: { videos: existing.length, reused: true },
    };
  }

  /*
   * A folder, or a URL. The only branch in the step, and it ends here.
   *
   * `listFolder` refuses a folder outside `adoptSourceRoots` before it reads a name, with the
   * same `realpath`-then-contain check that refuses a single adopted file. A refusal is thrown
   * rather than returned because it is not a step that failed on a source — it is a
   * configuration answer, identical every time it is retried, and `runStep` records the thrown
   * error on the row exactly as it records a returned one.
   */
  const folder = folderPathOf(ctx.job.url);
  const listing: FolderListing | null =
    folder === null
      ? null
      : await listFolder(folder, {
          paths: ctx.paths,
          settings: ctx.settings,
          toolbox: ctx.toolbox,
        });
  // The same session the download step will use: a resolve that authenticates differently
  // would pass the bot check and then hand the download a URL it cannot fetch.
  const extract: ExtractResult =
    listing ?? (await ctx.toolbox.extract(ctx.job.url, cookieJar(ctx.settings)));

  for (const file of listing?.skipped ?? []) {
    await ctx.say("resolve.skipped", `${file.name}: ${file.reason}`, {
      level: "warn",
      data: { file: file.name, reason: file.reason, code: file.code },
    });
  }

  /*
   * What the source listed and could not hand over.
   *
   * Journalled **before** the admission rules and before anything else can fail, and in the
   * same shape as `resolve.skipped` beside it, because the two answer the same question from
   * the operator — "why is this album short?" — and the answers are different: one entry was
   * refused by a rule he set, the other could not be read at all. A gap is a `warn`, never an
   * error: the import is proceeding, and the nineteen entries beside it are the point.
   *
   * **And deliberately not an Inbox item.** The question came up when `inbox_dismissals`
   * landed: "19 of 20 entries" reads like something a person could answer once. It is not,
   * for three reasons that hold together.
   *
   * The memory that makes an answer durable is scoped, on purpose, to the four types a
   * nightly walk of the library *rebuilds* (`DISMISSIBLE_TYPES` in
   * `services/inbox-dismissals.ts`). A gap is import-scoped: `resolve` runs once per import,
   * and the only thing that runs it again is an operator typing `mm retry`. There is nothing
   * here to stop asking, because nothing asks twice.
   *
   * There is also no verb. `dismiss` and `ignore` are the only answers a card could offer —
   * the entry is gone from the source and no button here brings it back, and `mm adopt` wants
   * a track row that a gap never became. A card whose whole content is *OK* is a queue entry
   * that costs more than it carries, and `mm retry --failed-step resolve` raises twenty of
   * them in one command, into the queue `fix-scan-dismissals` was written to keep short.
   *
   * Finally it is not lost by staying out. The gap is a column (`imports.unreadable`), a
   * permanent callout on the import page naming every missing entry, a count in the wizard
   * before Start and one in the URL test box — four places that outlive this journal line.
   * What would change the answer is the gap becoming *actionable*: keep a placeholder track
   * for the missing entry, give `mm adopt` something to fill, and the question is worth
   * asking.
   */
  const gaps = gapsOf(extract);
  for (const gap of gaps) {
    const where = gap.position === null ? "An entry" : `Entry ${String(gap.position)}`;
    const which = gap.id === null ? "" : ` (${gap.id})`;
    await ctx.say("resolve.unreadable", `${where}${which}: ${gap.reason ?? "could not be read"}`, {
      level: "warn",
      data: { position: gap.position, videoId: gap.id, code: gap.code, reason: gap.reason },
    });
  }

  const noun = listing === null ? "videos" : "files";
  if (extract.entries.length === 0) {
    return {
      status: "failed",
      message: `The URL resolved to no ${noun}.`,
      error: {
        code: "INVALID_INPUT",
        message: `The URL resolved to no ${noun}.`,
        hint: "Check the link, or try it in a browser — it may be private or region-locked.",
        action: "Find alternative",
      },
    };
  }

  const kind = classify(ctx.job.url, extract);

  /*
   * The admission rules, applied here because this is the first and only place that has seen
   * the descriptions — and applied *after* `classify`, because `requireAlbum` is a rule about
   * an isolated video and "isolated" is precisely what `classify` just decided.
   *
   * Two behaviours from one verdict, which is the whole reason `admit` returns a reason and a
   * code rather than a boolean:
   *
   *  - a **lone video** is refused outright. Somebody pasted one link and is watching; an
   *    import that quietly resolved to nothing would leave them guessing, so the step fails
   *    with the typed error that names the rule.
   *  - an **entry inside a playlist** is skipped, with a journal line saying which video and
   *    why. The row is not written at all rather than written as `state: "skipped"`: `match`
   *    re-roles whatever rows exist and `download` filters on role rather than on state, so a
   *    refused video kept as a row would be scored, mapped, and eventually downloaded — the
   *    opposite of what the rule asked for.
   */
  const rules = sourceRulesOf(ctx.settings);
  const isolated = kind === "single";
  const skipped: { videoId: string; title: string; reason: string; code: string }[] = [];
  const admitted: ExtractEntry[] = [];
  for (const entry of extract.entries) {
    /*
     * **The admission rules do not apply to a folder**, and it is not an oversight.
     *
     * Both of them are statements about a YouTube upload: `officialUploadsOnly` looks for the
     * "Provided to YouTube by" line a distributor writes in a *description*, and `requireAlbum`
     * for a YouTube Music album tag. A file on the owner's own disk has neither and never
     * could, so applying them here would refuse every folder import the moment either rule is
     * on — for failing to be a video. The rules exist to filter what a *source* offers us; a
     * folder is not offering anything, it is the owner's own music.
     */
    const verdict =
      listing === null
        ? admit(entry, rules, { isolated })
        : { accept: true, reason: "", code: null };
    if (verdict.accept) {
      admitted.push(entry);
      continue;
    }
    if (isolated) throw refusalOf(verdict, ctx.job.url);
    skipped.push({
      videoId: entry.id,
      title: entry.title,
      reason: verdict.reason,
      code: verdict.code ?? "INVALID_INPUT",
    });
  }

  for (const entry of skipped) {
    await ctx.say("resolve.skipped", `${entry.title}: ${entry.reason}`, {
      level: "warn",
      data: { videoId: entry.videoId, reason: entry.reason },
    });
  }

  if (admitted.length === 0) {
    return {
      status: "failed",
      message: `Every one of the ${String(extract.entries.length)} video(s) was refused by the import rules.`,
      error: {
        // The code of the first refusal rather than a fixed one: every entry of a listing is
        // refused by the same rule today, and a hard-coded code would start lying the day
        // that stops being true.
        code: skipped[0]?.code ?? "INVALID_INPUT",
        message: `None of the ${String(extract.entries.length)} video(s) behind this URL passed the import rules.`,
        hint:
          "The journal above names each one and why. “Official uploads only” and “Require an " +
          "album” are in Settings › Watched sources.",
        action: "Change the rule",
        details: { url: ctx.job.url, refused: skipped.length },
      },
    };
  }

  /*
   * `OLAK5uy_…` playlists come back titled "Album - Love Is Dead": YouTube names the *kind* of
   * release in front of the release. Stored as-is it is what the wizard shows, what the album
   * hint falls back to and what the folder would be named, so it is dropped on the way in.
   */
  const rawTitle = extract.title ?? admitted[0]?.title ?? null;
  const title = rawTitle === null ? null : stripReleaseTypePrefix(rawTitle);
  const known = new Map(existing.map((row) => [row.videoId, row]));

  for (const entry of admitted) {
    const raw = entry as unknown as Record<string, unknown>;
    const found = known.get(entry.id);
    if (found === undefined) {
      await ctx.db.insert(importTracks).values({
        id: newId("importTrack"),
        importId: ctx.job.id,
        position: entry.index,
        videoId: entry.id,
        url: entryUrl(entry, ctx.job.url),
        sourceTitle: entry.title,
        sourceDuration: entry.duration ?? null,
        uploader: entry.uploader ?? null,
        raw,
      });
    } else {
      await ctx.db
        .update(importTracks)
        .set({
          position: entry.index,
          sourceTitle: entry.title,
          sourceDuration: entry.duration ?? null,
          uploader: entry.uploader ?? null,
          raw,
          updatedAt: new Date(),
        })
        .where(eq(importTracks.id, found.id));
    }
  }

  /*
   * A release every file already agrees on is not a hint, it is the answer.
   *
   * An existing library's files were tagged by *something* — Picard, this application's v1, or
   * this one — and a `MUSICBRAINZ_ALBUMID` shared by a majority of them names the exact record
   * the owner already decided this was, years ago. Pinning it is the same thing `--release`
   * does, so it is written into the same place and `match` needs no new branch; and it loses
   * to `--release` and to an existing pin, because a person saying which record it is always
   * wins over a file saying so.
   */
  const hinted =
    listing?.releaseMbidHint !== null &&
    listing?.releaseMbidHint !== undefined &&
    ctx.job.options.releaseMbid === undefined &&
    ctx.job.releaseMbid === null
      ? listing.releaseMbidHint
      : null;
  if (hinted !== null) {
    await ctx.say("resolve.release-hint", `The files agree they are release ${hinted}.`, {
      data: { releaseMbid: hinted, source: "MUSICBRAINZ_ALBUMID" },
    });
  }

  await ctx.db
    .update(imports)
    .set({
      kind,
      title,
      artist: extract.uploader ?? admitted[0]?.uploader ?? null,
      // Rewritten on every run, including a `--force` re-read: an entry that came back this
      // time must stop being reported as missing, and one that has since died must start.
      unreadable: gaps as SourceGap[],
      ...(hinted === null
        ? {}
        : {
            // `releaseMbidFromTags` marks it as an inference rather than an assertion, which is
            // what lets `match` fall back to the files' own tags if MusicBrainz cannot produce
            // the release — where a release somebody *typed* would rightly block and ask.
            options: { ...ctx.job.options, releaseMbid: hinted, releaseMbidFromTags: true },
          }),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, ctx.job.id));

  const refused = skipped.length === 0 ? "" : `, ${String(skipped.length)} refused by the rules`;
  const unreadable =
    listing === null || listing.skipped.length === 0
      ? ""
      : `, ${String(listing.skipped.length)} file(s) skipped`;
  /*
   * "19 of 20 entries; 1 could not be read" — the sentence the owner needed and did not have.
   *
   * It leads the message rather than trailing it, because the count is the first thing anyone
   * checks against the listing they can see in a browser, and a short album that does not say
   * it is short is what sent twenty live playlists to the failed pile.
   */
  const head =
    gaps.length === 0
      ? `${String(admitted.length)} ${noun === "files" ? "file" : "video"}(s)`
      : `${String(admitted.length)} of ${String(listedCount(extract))} entries; ` +
        `${String(gaps.length)} could not be read`;
  return {
    status: "done",
    message: `${head}, kind ${kind}${refused}${unreadable}`,
    data: {
      videos: admitted.length,
      kind,
      title,
      ...(listing === null ? {} : { folder: listing.folder, files: admitted.length }),
      ...(hinted === null ? {} : { releaseMbid: hinted }),
      ...(skipped.length === 0 ? {} : { refused: skipped }),
      ...(gaps.length === 0 ? {} : { listed: listedCount(extract), unreadable: gaps }),
      ...(listing === null || listing.skipped.length === 0
        ? {}
        : { unreadableFiles: listing.skipped }),
    },
  };
}
