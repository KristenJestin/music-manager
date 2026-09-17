/**
 * Step 2 — `match` (app). The real one, as of P05.
 *
 * P03 shipped this as a stub that could only *apply* a mapping somebody else had decided.
 * What replaces it does the work of `docs/04-pipeline-et-matching.md` § Algorithme de
 * présélection: it searches MusicBrainz, scores the candidates with the engine of
 * `@mm/domain/matching`, proposes a 1:1 mapping, and writes all of it down.
 *
 * Three properties are load-bearing, and none of them is about scoring:
 *
 *  - **It never decides.** The result carries a preselection and the reasons for it. `confirm`
 *    is still the only step that commits, and it still blocks without `--yes` or fixtures mode
 *    whatever the score says — decision 002, and `docs/04`: "Le seuil « safe » […] ne saute
 *    pas la confirmation."
 *  - **It blocks only when a decision is genuinely required.** An ambiguous release or an
 *    ambiguous recording parks the job in `awaiting_review`, because choosing wrongly there
 *    changes what gets downloaded. Uncovered tracks and extra videos raise an Inbox item and
 *    let the job continue: they are notices, and the album imports fine without them.
 *  - **It stays idempotent, in both directions.** Re-running it re-searches (out of the cache,
 *    so free), re-scores deterministically, rewrites the same rows, and refreshes the same
 *    Inbox items rather than piling up duplicates — *and* closes the ones it no longer raises.
 *    Only the second half is recent: `openInboxItem` never closed anything, so an album
 *    re-matched onto a release that covers every track kept its "six tracks have no video"
 *    flag for ever, and half a review queue was notices about mappings that no longer existed.
 *
 * The two escape hatches of P03 survive untouched and take priority, because they are what
 * lets somebody import a record the matcher gets wrong: `--mapping <file.json>` supplies the
 * whole answer, and `--release <mbid>` pins the release and lets the mapping be computed
 * against it.
 */
import { and, eq, inArray } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import type {
  MappingResult,
  MatchTrack,
  MatchVideo,
  MbRelease,
  RecordingCandidate,
  ReleaseCandidate,
} from "@mm/domain";
import {
  albumHints,
  creditName,
  flattenTracks,
  mapping as mappingEngine,
  yearOf,
} from "@mm/domain";
import { imports, inboxItems, type ImportTrack, type InboxType } from "#/server/db/schema/index.ts";
import { isFolderSource } from "#/server/services/import-source.ts";
import {
  closeSupersededItems,
  openInboxItem,
  type OpenInboxOptions,
} from "#/server/services/inbox.ts";
import type { Database } from "#/server/db/client.ts";
import {
  cassetteGateway,
  liveGateway,
  withOutage,
  type MbGateway,
} from "#/server/services/matching.gateway.ts";
import { cassetteNameOf, loadCassette } from "#/server/services/matching.cassettes.ts";
import {
  configFromSettings,
  describeFallback,
  matchAlbum,
  matchSingle,
  type MatchBudget,
} from "#/server/services/matching.service.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import type { StepResult } from "../machine.ts";
import { updateTrack, type StepContext } from "../context.ts";

/** A mapping supplied from outside — the CLI's `--mapping`, or a fixture. */
export interface SuppliedMapping {
  /**
   * `null` is "import without MusicBrainz" (P07a).
   *
   * The wizard's step 2 offers it for a source MusicBrainz genuinely does not have — a live
   * set, a bootleg, an artist who never registered. The mapping is then the source's own
   * order, the document is built from the YouTube tags alone, and the album is flagged
   * `untagged` in the library so it can be found and finished later. Nothing else in the
   * pipeline changes; a release simply never gets persisted on the job.
   */
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid?: string | null;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly year?: number | null;
  /** Total tracks on the release, so `uncovered_tracks` can be detected. */
  readonly trackTotal?: number;
  readonly tracks: readonly {
    /** Index of the video in the source listing. */
    readonly position: number;
    readonly trackPosition: number;
    readonly mediumPosition?: number;
    readonly trackMbid?: string;
    /** `null` when the import has no MusicBrainz release behind it. */
    readonly recordingMbid: string | null;
    readonly trackTitle: string;
    readonly confidence?: number;
  }[];
}

/* ------------------------------------------------------------------ */
/* the questions this step owns                                        */
/* ------------------------------------------------------------------ */

/**
 * The four item types `match` raises, and therefore the four it is allowed to close.
 *
 * A `fingerprint_mismatch` or a `job_failed` on the same import belongs to another step and is
 * left exactly where it is; so is anything a person has already answered.
 */
const MATCH_ITEMS: readonly InboxType[] = [
  "ambiguous_release",
  "ambiguous_recording",
  "uncovered_tracks",
  "extra_videos",
];

/** Open an item and remember that this run asked it. */
async function raise(raised: Set<string>, options: OpenInboxOptions, db: Database): Promise<void> {
  const item = await openInboxItem(options, db);
  raised.add(item.id);
}

/** Where a supplied mapping is parked between `mm import --mapping` and this step. */
export function mappingFromOptions(job: {
  options: Record<string, unknown>;
}): SuppliedMapping | null {
  const supplied = job.options["mapping"];
  return supplied === undefined || supplied === null ? null : (supplied as SuppliedMapping);
}

/* ------------------------------------------------------------------ */
/* the videos, as the engine wants them                                */
/* ------------------------------------------------------------------ */

/**
 * One `import_tracks` row as a `MatchVideo`.
 *
 * The YouTube Music tags come out of the verbatim `raw` payload `resolve` kept. Reading them
 * here rather than promoting them to columns is deliberate: they are source data, they belong
 * to whatever yt-dlp decided to call them this month, and the matcher is the only thing that
 * cares.
 */
export function toMatchVideo(row: ImportTrack): MatchVideo {
  const raw = row.raw;
  const text = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  const year = raw["release_year"];
  const fingerprintMbid = row.acoustidMbid;

  return {
    id: row.videoId,
    index: row.position,
    title: row.sourceTitle,
    durationSeconds: row.sourceDuration,
    uploader: row.uploader,
    ytTrack: text("track"),
    ytArtist: text("artist"),
    ytAlbum: text("album"),
    ytReleaseYear: typeof year === "number" ? year : null,
    description: text("description"),
    // Normally empty at `match` time — `fingerprint` runs after `download`. It is read anyway
    // so that re-running `match` on a job that already fingerprinted uses what was learned.
    ...(fingerprintMbid === null
      ? {}
      : { acoustid: [{ recordingMbid: fingerprintMbid, score: 1 }] }),
  };
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

/** Write one proposed mapping onto the import's rows. */
async function persistMapping(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  proposal: MappingResult,
): Promise<{ mapped: number; extras: number }> {
  const byVideoId = new Map(rows.map((row) => [row.videoId, row]));
  let mapped = 0;
  let extras = 0;

  for (const line of proposal.lines) {
    const row = byVideoId.get(line.videoId);
    if (row === undefined) continue;
    if (line.trackN === null) {
      await updateTrack(ctx, row.id, {
        role: "extra",
        trackMbid: null,
        recordingMbid: null,
        trackTitle: null,
        trackPosition: null,
        mediumPosition: null,
        confidence: null,
      });
      extras += 1;
      continue;
    }
    await updateTrack(ctx, row.id, {
      role: "mapped",
      trackMbid: line.trackMbid,
      recordingMbid: line.recordingMbid,
      trackTitle: line.trackTitle,
      trackPosition: line.trackN,
      mediumPosition: line.mediumPosition ?? 1,
      confidence: line.confidence,
    });
    mapped += 1;
  }
  return { mapped, extras };
}

/**
 * Write the chosen release onto the import itself.
 *
 * `releaseGroupId: undefined` means **"I do not know"** and leaves the column alone;
 * only an explicit `null` clears it. That distinction is the third test report's §4: a
 * supplied mapping carries no release group, the old code turned its absence into a `null`,
 * and `place` copied that `null` onto `library_albums`. The album then lost the Cover Art
 * Archive release-group fallback, and its quality report had nothing to point at.
 */
async function persistRelease(
  ctx: StepContext,
  release: {
    id: string;
    releaseGroupId?: string | null;
    title?: string;
    artist?: string;
    year?: number | null;
  },
): Promise<void> {
  await ctx.db
    .update(imports)
    .set({
      releaseMbid: release.id,
      ...(release.releaseGroupId === undefined ? {} : { releaseGroupMbid: release.releaseGroupId }),
      ...(release.title === undefined || release.title === "" ? {} : { title: release.title }),
      ...(release.artist === undefined || release.artist === "" ? {} : { artist: release.artist }),
      ...(release.year === undefined || release.year === null ? {} : { year: release.year }),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, ctx.job.id));
}

/**
 * The two notices: videos nobody wanted, tracks nobody covered.
 *
 * Both carry a preselected answer that keeps the import going, because both describe a
 * situation the user can perfectly well accept. Neither blocks.
 */
async function raiseNotices(
  ctx: StepContext,
  proposal: MappingResult,
  releaseMbid: string | null,
): Promise<void> {
  if (proposal.extraVideos.length > 0) {
    const count = proposal.extraVideos.length;
    await raise(
      ctx.raised,
      {
        type: "extra_videos",
        importId: ctx.job.id,
        title: `${String(count)} video(s) outside the tracklist`,
        summary: proposal.extraVideos.map((video) => video.title).join(", "),
        payload: {
          videos: proposal.extraVideos.map((video) => ({
            id: video.videoId,
            position: video.index,
            title: video.title,
            durationSeconds: video.durationSeconds,
            why: video.why,
          })),
        },
        preselected: { action: "ignore" },
      },
      ctx.db,
    );
  }

  if (proposal.uncoveredTracks.length > 0) {
    const count = proposal.uncoveredTracks.length;
    // Over the whole release, not over the uncovered subset: six gaps that all sit on disc 2
    // still need to say so.
    const discs = new Set<number>(proposal.uncoveredTracks.map((track) => track.mediumPosition));
    for (const line of proposal.lines) {
      if (line.mediumPosition !== null) discs.add(line.mediumPosition);
    }
    const multiDisc = discs.size > 1;
    await raise(
      ctx.raised,
      {
        type: "uncovered_tracks",
        importId: ctx.job.id,
        title: `${String(count)} track(s) of the release have no video`,
        /*
         * The disc is part of the name of a track. A two-disc record has two track 1s, so
         * "1. High Life, 1. One More Time" reads as a duplicate rather than as two discs.
         */
        summary: proposal.uncoveredTracks
          .map((track) =>
            multiDisc
              ? `${String(track.mediumPosition)}-${String(track.position)}. ${track.title}`
              : `${String(track.position)}. ${track.title}`,
          )
          .join(", "),
        payload: {
          releaseMbid,
          tracks: proposal.uncoveredTracks.map((track) => ({
            position: track.position,
            mediumPosition: track.mediumPosition,
            title: track.title,
            recordingMbid: track.recordingMbid,
            lengthSeconds: track.lengthSeconds,
          })),
        },
        preselected: { action: "import anyway" },
      },
      ctx.db,
    );
  }
}

/* ------------------------------------------------------------------ */
/* the gateway for this job                                            */
/* ------------------------------------------------------------------ */

/**
 * Where this job's MusicBrainz documents come from.
 *
 * The choice follows the **URL**, exactly like `resolve` deciding whether a source is
 * `fixture://` and exactly like `mm match` deciding whether to load a cassette — never the
 * global `MM_FIXTURES` switch on its own. A `fixture://…` job replays its recorded cassette —
 * which is *not* copied into the raw cache, on purpose: the cassettes are pruned to the fields
 * the matcher reads, and seeding them would leave P04's document build reading a MusicBrainz
 * release with its relations amputated. The document side has recorded sources of its own.
 * Any other URL goes to the network, through P04's limiter and cache.
 *
 * Tying this to `ctx.fixtures` instead once let a test that flips `MM_FIXTURES` off for a
 * `fixture://` job (to reach the one thing fixtures mode auto-confirms past) fall through to
 * `liveGateway` and hit real MusicBrainz — a `fixture://` URL must stay offline whatever the
 * mode, the same way `resolve` never asks the toolbox for one for real.
 */
async function gatewayFor(ctx: StepContext): Promise<MbGateway | null> {
  const name = cassetteNameOf(ctx.job.url);
  const cassette = name === null ? null : loadCassette(name);
  // `withOutage` so that `fixture://…?mb=503&mbtimes=3` refuses here too. The wizard has
  // honoured that switch since decision 165 and the *step* did not, which meant the one
  // recorded MusicBrainz outage this repository owns could not be driven through the machine
  // it is really about — the one that used to turn a 503 into a terminal `failed`.
  if (cassette !== null) return withOutage(cassetteGateway(cassette), ctx.job.url);
  if (ctx.fixtures) return null;
  return liveGateway(await sourceContextFor(ctx.db, ctx.signal));
}

/* ------------------------------------------------------------------ */
/* the step                                                            */
/* ------------------------------------------------------------------ */

/** How many candidates are kept on `job_steps.result` for the wizard to offer. */
const KEPT_CANDIDATES = 12;

/** Trim a candidate list to what the Console needs, so one row does not carry a megabyte. */
function keep<T>(candidates: readonly T[]): T[] {
  return candidates.slice(0, KEPT_CANDIDATES);
}

/**
 * Run the step, then settle what the run leaves behind it: **the questions it no longer asks**,
 * and **the files that no longer agree with the mapping it has just written**.
 *
 * Two clean-ups, one seam, and deliberately so. `runMatch` decides; everything that has to be
 * true *afterwards* is a consequence of that decision and not a branch inside it, so neither
 * of the two is repeated at the three places `matchOneAlbum` gives up nor at the four doors a
 * confirmation comes through.
 *
 * **Closing.** Re-matching used to accumulate: `openInboxItem` refreshed the item a step still
 * wanted to raise and nothing ever closed the one it had stopped raising, so an album
 * re-matched onto a release that covers every track kept its "6 track(s) of the release have no
 * video" flag for ever. The owner re-matched fifteen albums and not one flag was re-evaluated.
 *
 * `closeItemsOf` was the only closing verb in this module and it is the wrong one here: it
 * dismisses *everything* open on the import, which is right for a cancellation and would throw
 * away a `fingerprint_mismatch` and a `job_failed` here. What this needs is the difference
 * between what was open and what was just asked, over the four types this step owns — and only
 * over `open` rows, so an item a person answered stays the record it is.
 *
 * **Catching up.** See `catchUp`. It runs after the closing rather than before it because the
 * two report to the same journal and the reading order is the acting order: the Inbox settles,
 * then the files are told to follow. Nothing in either depends on the other.
 */
export async function matchStep(ctx: StepContext): Promise<StepResult> {
  const result = await runMatch(ctx);
  const closed = await closeSupersededItems(ctx.job.id, MATCH_ITEMS, ctx.raised, ctx.db);
  if (closed.length > 0) {
    await ctx.say(
      "inbox.closed",
      `${String(closed.length)} review item(s) no longer hold and were closed.`,
      { level: "info", data: { items: closed.map((item) => ({ id: item.id, type: item.type })) } },
    );
  }
  await catchUp(ctx, result);
  return result;
}

async function runMatch(ctx: StepContext): Promise<StepResult> {
  const rows = await ctx.tracks();
  if (rows.length === 0) {
    return { status: "failed", message: "Nothing to match: the import has no videos." };
  }

  const options = ctx.job.options as unknown as Record<string, unknown>;
  const supplied = mappingFromOptions({ options });

  // The escape hatch wins outright: somebody told us the answer.
  if (supplied !== null) return await applySupplied(ctx, rows, supplied);

  const videos = rows.map(toMatchVideo);
  const gateway = await gatewayFor(ctx);
  /*
   * No gateway at all — fixtures mode with nothing recorded for this source.
   *
   * It goes through `untaggedFallback` like every other way of giving up, and it has to: this
   * is precisely the shape "MusicBrainz knows nothing about this record" takes offline, and a
   * folder import is the case where the files themselves know enough to carry on. Returning
   * early here is what left the end-to-end folder run parked in `awaiting_review`.
   */
  const result: StepResult =
    gateway === null
      ? {
          status: "blocked",
          blockedAs: "awaiting_review",
          message: `No recorded MusicBrainz data for ${ctx.job.url} in fixtures mode.`,
          data: { url: ctx.job.url },
        }
      : ctx.job.kind === "single" || rows.length === 1
        ? await matchOneRecording(ctx, rows, videos, gateway)
        : await matchOneAlbum(ctx, rows, videos, gateway);

  return (await untaggedFallback(ctx, rows, result)) ?? result;
}

/* ---- import without MusicBrainz, when MusicBrainz has nothing ---- */

/**
 * Is this import allowed to give up on MusicBrainz and build from the source's own tags?
 *
 * **On by default for a folder, off for everything else**, and the asymmetry is the point. A
 * YouTube listing that matches nothing has *no* usable metadata to fall back on — a video
 * title, a channel name, and four tags YouTube Music inferred — so blocking and asking a human
 * is the right answer and has been since P03. A folder's files carry real tags, written by
 * Picard or by this application's own v1: TITLE, ARTIST, ALBUM, TRACKNUMBER, DATE, often the
 * MusicBrainz ids themselves. For those, "MusicBrainz does not know this record" is a fact
 * about a bootleg, a live set or an unregistered artist, not a reason to stop.
 *
 * `options.untaggedFallback` overrides it in either direction, because a person importing a
 * folder they *know* is on MusicBrainz would rather be asked than filed under a wrong title.
 *
 * **A release a person pinned switches it off.** `--release <mbid>` is somebody saying *this is
 * the record*; quietly importing it as untagged because MusicBrainz was unreachable, or because
 * the id was mistyped, would answer a different question from the one that was asked and file
 * the album under a title they never chose. The right answer there is the one that has always
 * been right — block, and let the Inbox ask.
 *
 * A release the **files** claimed is not that (`options.releaseMbidFromTags`). Nobody asserted
 * it, `resolve` read it off a majority of `MUSICBRAINZ_ALBUMID` tags, and MusicBrainz not
 * having it any more is precisely the situation the fallback exists for.
 */
function wantsUntaggedFallback(job: StepContext["job"]): boolean {
  const stated = job.options.untaggedFallback;
  if (stated !== undefined) return stated;
  const pinnedByHand =
    (job.options.releaseMbid !== undefined || job.releaseMbid !== null) &&
    job.options.releaseMbidFromTags !== true;
  if (pinnedByHand) return false;
  return isFolderSource(job.url);
}

/**
 * Turn "the Inbox is asking which release this is" into "import it without MusicBrainz".
 *
 * Intercepted here, once, rather than at each of the three places `matchOneAlbum` gives up —
 * no candidate at all, nothing credited to the artist, nothing above the preselection floor.
 * All three mean the same thing to a folder import ("MusicBrainz cannot tell me what this
 * is"), and one interception cannot drift from another the way three guards would.
 *
 * The Inbox item the refusal opened is **dismissed, not resolved**: nobody answered it, and
 * leaving it open would show a review queue entry for a job that has already moved on. This is
 * the same distinction `forgetMapping` draws for the same items.
 *
 * What it then does is exactly the existing `untagged` path — a supplied mapping with
 * `releaseMbid: null`, the source's own order, the album flagged `untagged` in the library so
 * it can be found and finished later. Nothing new; the fallback has simply stopped being empty.
 */
async function untaggedFallback(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  result: StepResult,
): Promise<StepResult | null> {
  if (result.status !== "blocked" || result.blockedAs !== "awaiting_review") return null;
  if (!wantsUntaggedFallback(ctx.job)) return null;

  await ctx.db
    .update(inboxItems)
    .set({ status: "dismissed", resolvedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(inboxItems.importId, ctx.job.id),
        eq(inboxItems.status, "open"),
        inArray(inboxItems.type, ["ambiguous_release", "ambiguous_recording"]),
      ),
    );

  const videos = rows.map(toMatchVideo);
  const hints = albumHints(videos, {
    album: ctx.job.title,
    artist: ctx.job.artist,
    year: ctx.job.year,
  });
  await ctx.say(
    "match.untagged",
    `MusicBrainz has nothing for this; importing from the source's own tags instead.`,
    {
      level: "warn",
      data: { reason: result.message, album: hints.album ?? null, artist: hints.artist ?? null },
    },
  );

  /*
   * The source's own order, one track per entry, in the order `resolve` listed them.
   *
   * `trackPosition` is the *position in this import*, which for a folder is the tracklist the
   * files already state (`folder-source.ts` orders by DISCNUMBER/TRACKNUMBER when every file
   * carries one). `place` files an untagged album on (album, disc, track), so this is what
   * decides the filenames — and it is the one thing that would be wrong if the folder were
   * listed in an arbitrary order.
   */
  return await applySupplied(ctx, rows, {
    releaseMbid: null,
    ...(hints.album === undefined || hints.album === null ? {} : { album: hints.album }),
    ...(hints.artist === undefined || hints.artist === null ? {} : { albumArtist: hints.artist }),
    year: hints.year ?? null,
    tracks: rows.map((row, index) => ({
      position: row.position,
      trackPosition: index + 1,
      recordingMbid: null,
      trackTitle: row.trackTitle ?? row.sourceTitle,
      confidence: 1,
    })),
  });
}

/**
 * The files catch up with the mapping that has just been written.
 *
 * This is the whole of the fix for "confirming a different release leaves the previous
 * edition's tags on disk", and it is *here* rather than in `services/confirm.ts` because this
 * is where every confirmation ends up: `confirmSupplied` (the wizard's Start button, the album
 * page's "Change release", `POST /confirm-mapping`, MCP's `confirm_mapping`) and
 * `confirmBest`/`applyAndReport` (`POST /confirm-best`, MCP, the batch) both call
 * `runStep(id, "match")`, and an Inbox `{action: "retry", step: "match"}` re-queues this step.
 * One call, four doors, and `services/confirm.ts` untouched.
 *
 * Nothing is queued unless the import already has files in the library **and** those files
 * disagree with the mapping the database now holds — which is the whole of an ordinary first
 * import, where `library_tracks` has no row yet and this costs one indexed query.
 *
 * `place` and `tag` will not do it instead: a track that has reached `done` or `placed` is
 * terminal in `machine.ts`, so re-queueing the import after a re-match re-runs nothing over
 * the files that are already filed. That is the exact shape of the defect.
 *
 * ## The untagged fallback is not an exception, and must not become one
 *
 * `untaggedFallback` ends in `applySupplied` with `releaseMbid: null`, every `recordingMbid`
 * `null`, and no MusicBrainz document anywhere. Queueing a re-tag for *that* would be a loop
 * with no progress: there is nothing to rebuild from, so the rebuild would change nothing and
 * the next pass would find the same files still adrift. It is therefore worth being precise
 * about why this is called anyway, unconditionally, rather than guarded with
 * `if (result.releaseMbid !== null)`.
 *
 * **The guard belongs in the comparison, and it is already there.** `quality.tracksAdrift` is
 * asymmetric on purpose: `disagrees(held, claimed)` is false whenever `claimed` is `null`,
 * because a mapping that holds no identifier is not *claiming* the file is wrong. An untagged
 * album therefore contributes nothing under the `sources` reason — and nothing under
 * `document` either, since the stored document and its `projection_hash` were written together
 * and a re-match that builds no document moves neither. An adopted file that this application
 * never wrote carries `projection_hash = null` and is skipped outright. So `ensureProjection`
 * fires, reads no adrift track, opens no run, and costs one indexed query.
 *
 * That is the right place for it. A guard here would say "an untagged import never needs to
 * catch up", which is false in the direction that matters: a folder filed untagged and *later*
 * pinned to a release re-enters this step with real `recordingMbid`s against a document that
 * holds none, `disagrees(null, "…")` is true, and the re-tag that rebuilds from the freshly
 * learned mapping is exactly the repair. The fallback's own path stays silent for the same
 * reason the first import of anything does: `library_tracks` has no row for this import until
 * `place` has run, so a folder import's `match` resolves to no album at all.
 */
async function catchUp(ctx: StepContext, result: StepResult): Promise<void> {
  if (result.status !== "done" && result.status !== "skipped") return;
  try {
    const { ensureProjectionForImport } = await import("#/server/services/projection.ts");
    const outcomes = await ensureProjectionForImport({
      importId: ctx.job.id,
      db: ctx.db,
      settings: ctx.settings,
      trigger: "sources",
    });
    for (const outcome of outcomes) {
      if (outcome.reused) continue;
      await ctx.say(
        "step.done",
        `${String(outcome.adrift)} file(s) of this album no longer match the database; a re-tag is queued.`,
        { data: { runId: outcome.runId, adrift: outcome.adrift, total: outcome.total } },
      );
    }
  } catch (error) {
    // The mapping is written and correct; failing the `match` step because the catch-up could
    // not be queued would throw away the part that worked. The Quality page and the album page
    // both report the drift, so the state is recoverable by hand.
    await ctx.say("step.progress", `Could not queue the re-tag: ${MMError.from(error).message}`, {
      level: "warn",
    });
  }
}

/* ---- album ---- */

async function matchOneAlbum(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  videos: readonly MatchVideo[],
  gateway: MbGateway,
): Promise<StepResult> {
  const derived = albumHints(videos, {
    album: ctx.job.title,
    artist: ctx.job.artist,
    year: ctx.job.year,
  });
  /*
   * An album title stated on the import wins over the one derived from the listing.
   *
   * `albumHints` takes the album from a majority of the videos' YouTube Music tags, which is
   * right nearly always and wrong in exactly one way that matters: the tag carries the edition
   * ("… (Expanded Edition)") for a release MusicBrainz never published under that name, and the
   * search then comes back empty however many times it is run. `options.albumTitle` is how the
   * review card says "search for this instead", and it is deliberately an *override* rather
   * than another fallback — a fallback would still lose to the majority.
   */
  const stated = ctx.job.options.albumTitle?.trim();
  const hints = stated === undefined || stated === "" ? derived : { ...derived, album: stated };
  const result = await matchAlbum(gateway, { videos, hints }, ctx.settings);
  const pinned = ctx.job.options.releaseMbid;

  /*
   * The search fell back, so the journal says so and to what.
   *
   * A fallback that only ever shows up as "it worked this time" is a fallback nobody can
   * audit. Somebody looking at a questionable import has to be able to read that MusicBrainz
   * was asked a different question from the one the playlist's title implies — the base title
   * instead of "Let Go (Expanded Edition)", the first credited name instead of the whole
   * "Laufey, Spencer Stewart", or four of the tracks instead of the album at all.
   */
  if (result.fallback !== null) {
    await ctx.say("match.fallback", describeFallback(result.fallback), {
      level: "info",
      data: { fallback: result.fallback, queries: result.queries },
    });
  }

  /*
   * `--release <mbid>` pins the release. The mapping is still computed — against that one.
   *
   * A pin the search never returned is the case that matters: it is exactly why somebody
   * reaches for the flag. Falling back to the preselection there would silently import a
   * different record than the one asked for, so the release is looked up by MBID instead. That
   * costs one document beyond the budget, which is the correct trade: the budget bounds what
   * the *matcher* spends guessing, not what a person spends being explicit.
   */
  const pinnedCandidate =
    pinned === undefined
      ? undefined
      : result.ranking.candidates.find((candidate) => candidate.id === pinned);

  if (pinned !== undefined && pinnedCandidate === undefined) {
    const direct = await gateway.lookupRelease(pinned);
    if (direct === null) {
      return {
        status: "failed",
        message: `No MusicBrainz release with id ${pinned}.`,
        error: {
          code: "NOT_FOUND",
          message: `No MusicBrainz release with id ${pinned}.`,
          hint: "Check the MBID on musicbrainz.org, or drop --release and let the matcher propose.",
          action: "Check the MBID",
        },
      };
    }
    return await withPinnedRelease(ctx, rows, videos, direct, result.budget, result.queries);
  }

  const chosen = pinnedCandidate ?? result.ranking.preselected;

  /*
   * **Nothing here is by the artist the source names.** Refuse, and ask.
   *
   * The first defect of the sixth owner review, and the only one that put somebody else's
   * record in the library: a fourteen-video *Bewitched* credited "Laufey, Spencer Stewart"
   * matched to Laura Fygi's 1993 album, seven of fourteen videos placed, 0.537, and imported.
   * Nothing gated it — `safeThreshold` only *marks* a candidate and `confidentFloor` only
   * styles a mapping line, while `--yes` and fixtures mode open `confirm` unconditionally. The
   * only score gate in the codebase belongs to watched sources, and this import was not one.
   *
   * So the refusal has to happen **here**, at `match`, where blocking is what stops the
   * pipeline: an `awaiting_review` job never reaches `confirm`, so there is no gate left for
   * `--yes` to open. And it is a refusal rather than a bigger penalty because no penalty can
   * be both large enough to stop this and small enough to let the ordinary case through, where
   * MusicBrainz credits a record to a name YouTube spells differently.
   *
   * Pinned releases are exempt: `--release <mbid>` is a person saying which record it is, and
   * this rule exists to ask a person.
   */
  if (!result.artist.carried && pinned === undefined) {
    await raise(
      ctx.raised,
      {
        type: "ambiguous_release",
        importId: ctx.job.id,
        title: `No release of “${hints.album ?? ctx.job.url}” is credited to ${result.artist.wanted ?? "this artist"}`,
        summary:
          `MusicBrainz returned ${String(result.ranking.candidates.length)} release(s) with this title and ` +
          `none of them is by ${result.artist.wanted ?? "the credited artist"}` +
          `${chosen === null || chosen === undefined ? "" : ` — the best is “${chosen.title}” by ${chosen.artist}`}. ` +
          "Pick one with `mm import --release <mbid>`, or reject this import.",
        payload: {
          url: ctx.job.url,
          wantedArtist: result.artist.wanted,
          queries: result.queries,
          fallback: result.fallback,
          videos: videos.length,
          candidates: keep<ReleaseCandidate>(result.ranking.candidates),
        },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `No candidate is credited to ${result.artist.wanted ?? "the source artist"}: the Inbox is asking.`,
      data: {
        budget: result.budget,
        queries: result.queries,
        wantedArtist: result.artist.wanted,
        candidates: keep<ReleaseCandidate>(result.ranking.candidates),
      },
    };
  }

  /*
   * A preselection this weak is not a preselection. Ask.
   *
   * The other half of the sixth owner review's first defect, and the answer to "what gated a
   * 0.537 import?" — **nothing did**. `safeThreshold` (0.95) only *marks* a candidate and
   * `docs/04` says in as many words that it does not skip the confirmation; `confidentFloor`
   * (0.90) styles a mapping line; `matchBindingFloor` (0.35) judges one video against one
   * track. The only score gate in the codebase belonged to watched sources, and this import
   * was not one — `--yes` and fixtures mode open `confirm` without reading a score at all.
   *
   * So there is a floor now, and it lives at `match` for the same reason the artist rule does:
   * a blocked job never reaches the gate that ignores scores. 0.6 is where "this is the
   * record" stops and "this has a similar name" begins — every preselection in the recorded
   * corpus is above 0.92, and the album that started this was at 0.537. It is a *question*,
   * not a refusal: the Inbox item carries the candidate as its preselected answer, so somebody
   * who disagrees is one click from the same import.
   */
  const floor = ctx.settings.matchPreselectionFloor;
  if (chosen !== null && chosen !== undefined && chosen.score < floor && pinned === undefined) {
    await raise(
      ctx.raised,
      {
        type: "ambiguous_release",
        importId: ctx.job.id,
        title: `Nothing convincing for “${hints.album ?? ctx.job.url}”`,
        summary:
          `The best candidate, ${describe(chosen)}, scores ${String(chosen.score)} — under the ` +
          `${String(floor)} below which the matcher is naming a resemblance rather than a record. ` +
          `It would import ${String(videos.length - chosen.leftOver)} of your ${String(videos.length)} videos.`,
        payload: {
          url: ctx.job.url,
          score: chosen.score,
          floor,
          queries: result.queries,
          candidates: keep<ReleaseCandidate>(result.ranking.candidates),
        },
        preselected: { releaseMbid: chosen.id },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `The best candidate scores ${String(chosen.score)}, under ${String(floor)}: the Inbox is asking.`,
      data: {
        budget: result.budget,
        queries: result.queries,
        score: chosen.score,
        candidates: keep<ReleaseCandidate>(result.ranking.candidates),
      },
    };
  }

  if (chosen === null || chosen === undefined) {
    await raise(
      ctx.raised,
      {
        type: "ambiguous_release",
        importId: ctx.job.id,
        title: `No MusicBrainz release matches “${hints.album ?? ctx.job.url}”`,
        /*
         * The sentence used to end with "Supply one with `mm import --release <mbid>`", which
         * sent the reader out of the Console to do the one thing the card is for. The card now
         * takes a release id and offers the qualifier search itself; the summary says what
         * happened and lets the card say what can be done about it.
         */
        summary: `Searched for “${hints.album ?? ctx.job.url}” and nothing came back.`,
        payload: {
          url: ctx.job.url,
          album: hints.album,
          queries: result.queries,
          videos: videos.length,
        },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: "No release candidate: the Inbox is asking which release to use.",
      data: { budget: result.budget, queries: result.queries },
    };
  }

  const release =
    chosen.id === result.ranking.preselected?.id
      ? result.release
      : await gateway.lookupRelease(chosen.id);
  const proposal =
    release === null
      ? null
      : mappingEngine.assign(videos, flattenTracks(release), configFromSettings(ctx.settings));

  if (proposal === null) {
    return {
      status: "failed",
      message: `Release ${chosen.id} has no tracklist.`,
      data: { budget: result.budget },
    };
  }

  await persistRelease(ctx, chosen);
  const { mapped, extras } = await persistMapping(ctx, rows, proposal);
  await raiseNotices(ctx, proposal, chosen.id);

  const data = {
    kind: "album" as const,
    releaseMbid: chosen.id,
    mapped,
    extras,
    uncovered: proposal.uncoveredTracks.length,
    safe: chosen.safe,
    /*
     * Written down so `confirm` can read it off the row.
     *
     * The artist rule is enforced here, at `match`, and a blocked job never reaches `confirm`
     * — but a job *pinned* past it does, and so does a row re-read after a retry. `confirm`'s
     * own gate (`exactnessRefusal`) needs all four facts in one place, and the step that knew
     * them is this one.
     */
    artistCarried: result.artist.carried,
    ambiguous: result.ranking.ambiguous,
    margin: result.ranking.margin,
    budget: result.budget satisfies MatchBudget,
    queries: result.queries,
    candidates: keep<ReleaseCandidate>(result.ranking.candidates),
    mapping: proposal.lines,
  };

  // The only blocking case: two candidates that would import differently, close enough that
  // preferring one would be a guess.
  if (result.ranking.ambiguous && pinned === undefined) {
    const runnerUp = result.ranking.candidates[1];
    await raise(
      ctx.raised,
      {
        type: "ambiguous_release",
        importId: ctx.job.id,
        title: `Two releases of “${chosen.title}” are equally likely`,
        summary:
          `${describe(chosen)} scores ${String(chosen.score)}, ` +
          `${runnerUp === undefined ? "the runner-up" : describe(runnerUp)} ${String(runnerUp?.score ?? 0)} — ` +
          `and they would not import the same tracks.`,
        payload: {
          margin: result.ranking.margin,
          candidates: keep<ReleaseCandidate>(result.ranking.candidates),
        },
        preselected: { releaseMbid: chosen.id },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `Two releases are within ${String(result.ranking.margin)}: the Inbox is asking.`,
      data,
    };
  }

  return {
    status: "done",
    message:
      `${String(mapped)} track(s) mapped, ${String(extras)} extra, ` +
      `${String(proposal.uncoveredTracks.length)} uncovered — ${describe(chosen)}`,
    data,
  };
}

/**
 * Map against a release the user named, which the search never proposed.
 *
 * No ranking, no ambiguity, no `ambiguous_release`: there is nothing to be ambiguous *about*.
 * The notices still apply — being explicit about the release says nothing about whether every
 * track is covered.
 */
async function withPinnedRelease(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  videos: readonly MatchVideo[],
  release: MbRelease,
  budget: MatchBudget,
  queries: readonly string[],
): Promise<StepResult> {
  const tracks = flattenTracks(release);
  if (tracks.length === 0) {
    return {
      status: "failed",
      message: `Release ${release.id ?? "?"} has no tracklist.`,
      data: { budget },
    };
  }

  const proposal = mappingEngine.assign(videos, tracks, configFromSettings(ctx.settings));
  await persistRelease(ctx, {
    id: release.id ?? "",
    releaseGroupId: release["release-group"]?.id ?? null,
    ...(release.title === undefined ? {} : { title: release.title }),
    ...(creditName(release["artist-credit"]) === null
      ? {}
      : { artist: creditName(release["artist-credit"]) ?? "" }),
    year: yearOf(release.date),
  });
  const { mapped, extras } = await persistMapping(ctx, rows, proposal);
  await raiseNotices(ctx, proposal, release.id ?? null);

  return {
    status: "done",
    message:
      `${String(mapped)} track(s) mapped, ${String(extras)} extra, ` +
      `${String(proposal.uncoveredTracks.length)} uncovered — pinned release ${release.id ?? "?"}`,
    data: {
      kind: "album" as const,
      releaseMbid: release.id ?? "",
      mapped,
      extras,
      uncovered: proposal.uncoveredTracks.length,
      pinned: true,
      budget: { searches: budget.searches, lookups: budget.lookups + 1 },
      queries,
      mapping: proposal.lines,
    },
  };
}

function describe(candidate: ReleaseCandidate): string {
  const parts = [candidate.country ?? "??", candidate.format ?? "?", candidate.date ?? ""];
  return `${candidate.title} (${parts.filter((part) => part !== "").join(" ")})`;
}

/* ---- single ---- */

async function matchOneRecording(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  videos: readonly MatchVideo[],
  gateway: MbGateway,
): Promise<StepResult> {
  const video = videos[0];
  const row = rows[0];
  if (video === undefined || row === undefined) {
    return { status: "failed", message: "Nothing to match." };
  }

  const result = await matchSingle(gateway, { video }, ctx.settings);
  const chosen = result.ranking.preselected;

  /*
   * The same artist gate as the album path, and this is where the wide recording search — the
   * one query left in this repository that names no artist — stops being dangerous. It exists
   * to *surface* the same-titled recordings by other people so the ranking can be seen
   * rejecting them; if the whole list turns out to be other people's, there is nothing left to
   * reject them in favour of, and that is a question for a person rather than a preselection.
   */
  if (!result.artist.carried) {
    await raise(
      ctx.raised,
      {
        type: "ambiguous_recording",
        importId: ctx.job.id,
        trackId: row.id,
        title: `No recording of “${video.title}” is credited to ${result.artist.wanted ?? "this artist"}`,
        summary:
          `Every candidate MusicBrainz returned is by somebody else` +
          `${chosen === null ? "" : ` — the best is “${chosen.title}” by ${chosen.artist}`}.`,
        payload: {
          wantedArtist: result.artist.wanted,
          queries: result.queries,
          candidates: keep<RecordingCandidate>(result.ranking.candidates),
        },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `No recording is credited to ${result.artist.wanted ?? "the source artist"}: the Inbox is asking.`,
      data: { budget: result.budget, queries: result.queries },
    };
  }

  if (chosen === null || chosen.borrow === null) {
    await raise(
      ctx.raised,
      {
        type: "ambiguous_recording",
        importId: ctx.job.id,
        trackId: row.id,
        title: `No MusicBrainz recording matches “${video.title}”`,
        summary: "Nothing scored high enough to propose, or nothing it found is on a release.",
        payload: {
          queries: result.queries,
          candidates: keep<RecordingCandidate>(result.ranking.candidates),
        },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: "No recording candidate: the Inbox is asking.",
      data: { budget: result.budget, queries: result.queries },
    };
  }

  await persistRelease(ctx, {
    id: chosen.borrow.id,
    title: chosen.borrow.title,
    artist: chosen.artist,
    year: chosen.borrow.date === null ? null : Number(chosen.borrow.date.slice(0, 4)),
  });
  await updateTrack(ctx, row.id, {
    role: "mapped",
    trackMbid: null,
    recordingMbid: chosen.id,
    trackTitle: chosen.title,
    trackPosition: chosen.borrow.trackPosition ?? 1,
    mediumPosition: 1,
    confidence: chosen.score,
  });

  const data = {
    kind: "single" as const,
    recordingMbid: chosen.id,
    releaseMbid: chosen.borrow.id,
    safe: chosen.safe,
    artistCarried: result.artist.carried,
    ambiguous: result.ranking.ambiguous,
    margin: result.ranking.margin,
    budget: result.budget satisfies MatchBudget,
    queries: result.queries,
    candidates: keep<RecordingCandidate>(result.ranking.candidates),
  };

  if (result.ranking.ambiguous) {
    const runnerUp = result.ranking.candidates[1];
    await raise(
      ctx.raised,
      {
        type: "ambiguous_recording",
        importId: ctx.job.id,
        trackId: row.id,
        title: `Two recordings of “${chosen.title}” are equally likely`,
        summary:
          `${chosen.borrow.title} (${chosen.borrow.type ?? "release"}) at ${clock(chosen.length)} ` +
          `against ${runnerUp?.borrow?.title ?? "the runner-up"} ` +
          `(${runnerUp?.borrow?.type ?? "release"}) at ${clock(runnerUp?.length ?? null)}.`,
        payload: {
          margin: result.ranking.margin,
          candidates: keep<RecordingCandidate>(result.ranking.candidates),
        },
        preselected: { recordingMbid: chosen.id, releaseMbid: chosen.borrow.id },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `Two recordings are within ${String(result.ranking.margin)}: the Inbox is asking.`,
      data,
    };
  }

  return {
    status: "done",
    message: `“${chosen.title}” by ${chosen.artist}, filed under “${chosen.borrow.title}”`,
    data,
  };
}

function clock(seconds: number | null): string {
  if (seconds === null) return "?";
  const total = Math.round(seconds);
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, "0")}`;
}

/* ---- the escape hatch ---- */

/**
 * Apply a mapping decided outside the matcher (`mm import --mapping <file.json>`).
 *
 * Kept from P03 verbatim in behaviour. It is the thing that makes a wrong preselection
 * survivable without waiting for a fix, and P05 does not get to remove it just because it now
 * has an opinion of its own.
 */
/**
 * The release a supplied mapping names, as MusicBrainz has it.
 *
 * One lookup, two consumers. It used to be fetched only for the release group; the *media* on
 * the same document are what makes a supplied mapping's `uncovered_tracks` notice truthful on
 * a multi-disc record, so fetching it once and reading both is strictly cheaper than the
 * arithmetic it replaces. `null` on an offline run or a MusicBrainz that did not answer — a
 * release group is worth one lookup, never a failed import.
 */
async function lookupSupplied(
  ctx: StepContext,
  releaseMbid: string | null,
): Promise<MbRelease | null> {
  if (releaseMbid === null || releaseMbid === "") return null;
  try {
    const gateway = await gatewayFor(ctx);
    if (gateway === null) return null;
    return await gateway.lookupRelease(releaseMbid);
  } catch {
    return null;
  }
}

/** One release track a supplied mapping left with no video. */
export interface UncoveredCell {
  readonly position: number;
  readonly mediumPosition: number;
  readonly title: string | null;
  readonly recordingMbid: string | null;
  readonly lengthSeconds: number | null;
}

/**
 * Which tracks of the release a supplied mapping did **not** cover.
 *
 * The key is `(mediumPosition, trackPosition)` and never `trackPosition` alone. That is the
 * whole of the second owner defect: *Crèvecœur* is twelve tracks over two discs, numbered 1–6
 * then 1–6, every one of them downloaded, tagged and filed — and the flat comparison saw six
 * positions covered out of twelve and reported "Positions 7, 8, 9, 10, 11, 12" as missing.
 * Six of his fifteen flagged albums were that sentence and nothing else.
 *
 * Two shapes of answer, in this order:
 *
 *  1. **the release's own tracklist**, when the lookup produced one. The grid is then a fact,
 *     the report carries titles, and it is the same payload the matcher's own path writes;
 *  2. **`trackTotal` on one medium**, when it did not — and only when every binding is on
 *     medium 1. A mapping that spans two discs with no tracklist to check it against cannot be
 *     keyed correctly, and a report nobody can key is worse than no report: it is exactly the
 *     six phantom lines this function exists to stop.
 */
export function uncoveredTracks(
  supplied: Pick<SuppliedMapping, "tracks" | "trackTotal">,
  tracklist: readonly MatchTrack[] | null,
): UncoveredCell[] {
  /*
   * **`trackTotal` still decides whether the question is asked at all**, and the tracklist only
   * decides what the answer is.
   *
   * Absent means "there is no tracklist to cover, do not check": `confirm-best` omits it for a
   * single deliberately, and `0` is what the wizard's single path sends. Both mean the release
   * is the album this recording is *filed under*, not a record to be covered — and reading the
   * media instead would report the ten other tracks of that album as missing, which is the
   * notice those two callers went out of their way to avoid.
   */
  if (supplied.trackTotal === undefined || supplied.trackTotal === 0) return [];

  const key = (medium: number | undefined, position: number): string =>
    `${String(medium ?? 1)}:${String(position)}`;
  const covered = new Set(
    supplied.tracks.map((entry) => key(entry.mediumPosition, entry.trackPosition)),
  );

  if (tracklist !== null && tracklist.length > 0) {
    return tracklist
      .filter((track) => !covered.has(key(track.mediumPosition, track.position)))
      .map((track) => ({
        position: track.position,
        mediumPosition: track.mediumPosition,
        title: track.title,
        recordingMbid: track.recordingMbid,
        lengthSeconds: track.lengthSeconds,
      }));
  }

  if (supplied.tracks.some((entry) => (entry.mediumPosition ?? 1) !== 1)) return [];
  return Array.from({ length: supplied.trackTotal }, (_, index) => index + 1)
    .filter((position) => !covered.has(key(1, position)))
    .map((position) => ({
      position,
      mediumPosition: 1,
      title: null,
      recordingMbid: null,
      lengthSeconds: null,
    }));
}

/**
 * "Positions 7, 8, 9" on one disc; "disc 2: 1, 2, 3" as soon as the *record* has two.
 *
 * A bare position is ambiguous the moment a record has a second medium, and the sentence the
 * owner read — six positions that do not exist on his album — was ambiguous *and* wrong.
 * `multiDisc` describes the release and not the gaps, because six gaps that all sit on disc 2
 * still need to say which disc they sit on.
 */
export function describePositions(cells: readonly UncoveredCell[], multiDisc: boolean): string {
  if (!multiDisc) return `Positions ${cells.map((cell) => cell.position).join(", ")}.`;
  return [...new Set(cells.map((cell) => cell.mediumPosition))]
    .sort((a, b) => a - b)
    .map((disc) => {
      const positions = cells
        .filter((cell) => cell.mediumPosition === disc)
        .map((cell) => cell.position);
      return `disc ${String(disc)}: ${positions.join(", ")}`;
    })
    .join("; ");
}

async function applySupplied(
  ctx: StepContext,
  rows: readonly ImportTrack[],
  supplied: SuppliedMapping,
): Promise<StepResult> {
  const byPosition = new Map(supplied.tracks.map((entry) => [entry.position, entry]));
  let mapped = 0;
  let extras = 0;

  for (const row of rows) {
    const hit = byPosition.get(row.position);
    if (hit === undefined) {
      await updateTrack(ctx, row.id, {
        role: "extra",
        trackMbid: null,
        recordingMbid: null,
        trackTitle: null,
        trackPosition: null,
        mediumPosition: null,
        confidence: null,
      });
      extras += 1;
      continue;
    }
    await updateTrack(ctx, row.id, {
      role: "mapped",
      trackMbid: hit.trackMbid ?? null,
      recordingMbid: hit.recordingMbid,
      trackTitle: hit.trackTitle,
      trackPosition: hit.trackPosition,
      mediumPosition: hit.mediumPosition ?? 1,
      confidence: hit.confidence ?? 1,
    });
    mapped += 1;
  }

  /*
   * The release itself, read once for the two things that need it: its release group and its
   * **media**. `null` when there is nothing to look up, or nothing answered.
   *
   * **Asked for only when it changes an answer**, because `confirmSupplied` runs this step
   * inside the wizard's Start button — a server function, synchronous, with somebody watching
   * (`CLAUDE.md`: a call that can take minutes belongs on a queue). The release group is
   * already known when the caller supplied it, and the media only matter when the mapping
   * spans more than one of them: on a single-disc record `trackTotal` and the positions are
   * the whole grid, and reading the tracklist would buy nothing but the track titles. So this
   * costs exactly what it cost before on every path that existed before it.
   */
  const statedGroup = supplied.releaseGroupMbid;
  const knowsGroup = statedGroup !== undefined && statedGroup !== null && statedGroup !== "";
  const spansDiscs = supplied.tracks.some((entry) => (entry.mediumPosition ?? 1) !== 1);
  const release =
    knowsGroup && !spansDiscs ? null : await lookupSupplied(ctx, supplied.releaseMbid);
  const tracklist = release === null ? null : flattenTracks(release);

  if (supplied.releaseMbid === null) {
    // "Import without MusicBrainz": there is no release to persist, but the album and artist
    // the source claimed are still what the document and the folder name will be built from,
    // so they are recorded here exactly as a matched release would have been.
    await ctx.db
      .update(imports)
      .set({
        ...(supplied.album === undefined || supplied.album === "" ? {} : { title: supplied.album }),
        ...(supplied.albumArtist === undefined || supplied.albumArtist === ""
          ? {}
          : { artist: supplied.albumArtist }),
        ...(supplied.year === undefined || supplied.year === null ? {} : { year: supplied.year }),
        updatedAt: new Date(),
      })
      .where(eq(imports.id, ctx.job.id));
  } else {
    /*
     * The release group, asked of MusicBrainz when the caller did not supply one.
     *
     * `MUSICBRAINZ_RELEASEGROUPID` is a **required** tag and the key the Cover Art Archive
     * falls back to when a release has no cover of its own. A caller confirming a mapping —
     * MCP, `/api/v1`, the wizard, `mm import --mapping` — has no reason to know it, and
     * inferring `null` from its silence is what left the CHVRCHES album of the third report
     * without one. The release lookup carries `release-groups` in its `inc` list already, so
     * this costs a cache hit in the ordinary case and one request in the worst.
     */
    const group = knowsGroup
      ? (statedGroup ?? undefined)
      : (release?.["release-group"]?.id ?? undefined);
    await persistRelease(ctx, {
      id: supplied.releaseMbid,
      ...(group === undefined ? {} : { releaseGroupId: group }),
      ...(supplied.album === undefined ? {} : { title: supplied.album }),
      ...(supplied.albumArtist === undefined ? {} : { artist: supplied.albumArtist }),
      year: supplied.year ?? null,
    });
  }

  if (extras > 0) {
    const leftovers = rows.filter((row) => !byPosition.has(row.position));
    await raise(
      ctx.raised,
      {
        type: "extra_videos",
        importId: ctx.job.id,
        title: `${String(extras)} video(s) outside the tracklist`,
        summary: leftovers.map((row) => row.sourceTitle).join(", "),
        payload: {
          videos: leftovers.map((row) => ({
            id: row.id,
            position: row.position,
            title: row.sourceTitle,
          })),
        },
        preselected: { action: "ignore" },
      },
      ctx.db,
    );
  }

  const uncovered = uncoveredTracks(supplied, tracklist);
  // The record's discs, not the gaps' — read from the tracklist when there is one, and from
  // the mapping when there is not.
  const discs = new Set<number>([
    ...(tracklist ?? []).map((track) => track.mediumPosition),
    ...supplied.tracks.map((entry) => entry.mediumPosition ?? 1),
    ...uncovered.map((cell) => cell.mediumPosition),
  ]);
  if (uncovered.length > 0) {
    await raise(
      ctx.raised,
      {
        type: "uncovered_tracks",
        importId: ctx.job.id,
        title: `${String(uncovered.length)} track(s) of the release have no video`,
        summary: describePositions(uncovered, discs.size > 1),
        payload: {
          releaseMbid: supplied.releaseMbid,
          tracks: uncovered.map((cell) => ({
            position: cell.position,
            mediumPosition: cell.mediumPosition,
            title: cell.title,
            recordingMbid: cell.recordingMbid,
            lengthSeconds: cell.lengthSeconds,
          })),
          // The flat list the card used to read, kept for an item written before this change.
          positions: uncovered.map((cell) => cell.position),
        },
        preselected: { action: "import anyway" },
      },
      ctx.db,
    );
  }

  return {
    status: "done",
    message:
      supplied.releaseMbid === null
        ? `${String(mapped)} track(s) mapped from the source's own order, ${String(extras)} extra (no MusicBrainz release)`
        : `${String(mapped)} track(s) mapped, ${String(extras)} extra (supplied mapping)`,
    data: {
      releaseMbid: supplied.releaseMbid,
      mapped,
      extras,
      supplied: true,
      untagged: supplied.releaseMbid === null,
    },
  };
}
