#!/usr/bin/env bun
/**
 * `mm` — the command line. `bun run mm -- <command>` from the repository root.
 *
 * In P03 it calls the services **in the same process** (P08 moves it onto `/api/v1`), with
 * one exception: it does not execute the pipeline itself. `mm import` creates the job, runs
 * `resolve` in-process so the answer is immediate, and then drops it on the queue — because
 * the download slot is global and one worker owns it. A CLI that ran steps of its own would
 * be a second worker, and two workers downloading at once is exactly what `docs/06-stack.md`
 * forbids.
 *
 * `--follow` tails `job_events` over LISTEN/NOTIFY, which is the same stream the Console's
 * SSE endpoint serves, so the two can never disagree about what happened.
 */
import { readFileSync } from "node:fs";
import { MMError } from "@mm/contracts";
import {
  albumHints,
  canonicalValue,
  tagByField,
  trackCompleteness,
  type AlbumHints,
  type MatchVideo,
} from "@mm/domain";
import { db } from "#/server/db/client.ts";
import { toolbox } from "#/server/toolbox/client.ts";
import {
  cassetteNameOf,
  cassetteNames,
  loadCassette,
} from "#/server/services/matching.cassettes.ts";
import {
  cassetteGateway,
  liveGateway,
  type MbGateway,
} from "#/server/services/matching.gateway.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import {
  matchAlbum,
  matchSingle,
  type AlbumMatch,
  type SingleMatch,
} from "#/server/services/matching.service.ts";
import {
  build as buildDocument,
  rebuild as rebuildDocument,
  storedDocument,
  type SourceVisit,
} from "#/server/services/documents.ts";
import { credentialReport, sourcesConfig } from "#/server/integrations/config.ts";
import type { StepName } from "#/server/db/schema/index.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import { readEvents, subscribe } from "#/server/services/events.ts";
import { getInboxItem, listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import {
  bumpImport,
  cancelImport,
  listImports,
  pauseImport,
  retryStep,
  stepsOf,
} from "#/server/services/jobs/index.ts";
import {
  isSecretSetting,
  isSettingKey,
  loadSettings,
  maskSetting,
  parseCliValue,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
  setSetting,
  type SettingKey,
} from "#/server/services/settings.ts";
import { createBoss, enqueueDownload, enqueueImportStep, stopBoss } from "#/worker/queues.ts";

/* ------------------------------------------------------------------ */
/* argument parsing                                                    */
/* ------------------------------------------------------------------ */

interface Args {
  readonly positional: string[];
  readonly flags: Record<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagBoolean(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}

/* ------------------------------------------------------------------ */
/* output                                                              */
/* ------------------------------------------------------------------ */

const STATUS_MARK: Record<string, string> = {
  done: "ok  ",
  skipped: "skip",
  running: "..  ",
  blocked: "wait",
  failed: "FAIL",
  pending: "    ",
};

function line(...parts: unknown[]): void {
  console.log(parts.join(" "));
}

function fail(error: unknown): never {
  const failure = MMError.from(error);
  console.error(`\n${failure.code}: ${failure.message}`);
  if (failure.hint !== undefined) console.error(`hint: ${failure.hint}`);
  if (failure.action !== undefined) console.error(`try : ${failure.action}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* follow                                                             */
/* ------------------------------------------------------------------ */

const TERMINAL_EVENTS = new Set(["import.done", "import.failed", "import.cancelled"]);

/**
 * Tail an import's journal until it stops.
 *
 * A blocked job is a stopping point too: waiting for a confirmation that has to be given in
 * another terminal would just look like a hang.
 */
async function followImport(importId: string): Promise<number> {
  return await new Promise<number>((finish) => {
    let exitCode = 0;
    void subscribe({
      importId,
      onEvent: (event) => {
        const mark = event.level === "error" ? "!" : event.level === "warn" ? "~" : " ";
        line(`${mark} [${event.step ?? "-"}] ${event.message}`);
        if (event.type === "import.failed") exitCode = 1;
        if (
          TERMINAL_EVENTS.has(event.type) ||
          (event.type === "import.status" &&
            /awaiting_confirm|awaiting_review|paused/.test(event.message))
        ) {
          finish(exitCode);
        }
      },
    }).then((subscription) => {
      const close = (): void => void subscription.unsubscribe();
      process.on("exit", close);
    });
  });
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdImport(args: Args): Promise<number> {
  const url = args.positional[1];
  if (url === undefined) throw new MMError("INVALID_INPUT", "usage: mm import <url|fixture://…>");

  const mappingFile = flagString(args, "mapping");
  const mapping =
    mappingFile === undefined
      ? undefined
      : (JSON.parse(readFileSync(mappingFile, "utf8")) as never);

  const created = await createFromUrl(url, {
    ...(flagString(args, "release") === undefined
      ? {}
      : { releaseMbid: flagString(args, "release") }),
    ...(mapping === undefined ? {} : { mapping }),
    autoConfirm: flagBoolean(args, "yes"),
    force: flagBoolean(args, "force"),
    ...(flagBoolean(args, "no-fingerprint") ? { fingerprint: false } : {}),
  });

  line(`import ${created.job.id}`);
  line(`  url    ${created.job.url}`);
  line(`  kind   ${created.job.kind}`);
  line(`  title  ${created.job.title ?? "-"}`);
  if (created.duplicates.length > 0) {
    line(`  note   ${String(created.duplicates.length)} earlier import(s) of the same URL`);
  }

  const boss = createBoss({ producer: true });
  await boss.start();
  await enqueueImportStep(boss, { importId: created.job.id, reason: "cli" });
  await stopBoss(boss);
  line(`  queued on import.step — run \`bun run worker\` if nothing moves`);

  if (!flagBoolean(args, "follow")) return 0;
  line("");
  const code = await followImport(created.job.id);
  await printJob(created.job.id);
  return code;
}

async function cmdJobs(): Promise<number> {
  const rows = await listImports({ limit: 50 });
  if (rows.length === 0) {
    line("no imports yet — `mm import fixture://discovery --yes --follow`");
    return 0;
  }
  line("ID                              STATUS            STEP         KIND      TITLE");
  for (const row of rows) {
    line(
      row.id.padEnd(31),
      row.status.padEnd(17),
      row.step.padEnd(12),
      row.kind.padEnd(9),
      row.title ?? row.url,
    );
  }
  return 0;
}

async function printJob(id: string): Promise<void> {
  const job = await getImport(id);
  if (job === null) throw new MMError("NOT_FOUND", `No import with id ${id}.`);
  line("");
  line(`import ${job.id}`);
  line(`  url      ${job.url}`);
  line(`  status   ${job.status}  (step ${job.step})`);
  line(`  release  ${job.releaseMbid ?? "-"}`);
  if (job.error !== null) line(`  error    ${job.error.code}: ${job.error.message}`);
  line("");
  for (const { step, row } of await stepsOf(id)) {
    const status = row?.status ?? "pending";
    line(` ${STATUS_MARK[status] ?? status} ${step.padEnd(12)} ${row?.message ?? ""}`);
  }
  const open = await listInbox({ importId: id, status: "open" });
  if (open.length > 0) {
    line("");
    line(` inbox (${String(open.length)} open):`);
    for (const item of open) line(`   ${item.id}  ${item.type}  ${item.title}`);
  }
}

async function cmdJob(args: Args): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm job <id> [--follow]");
  if (flagBoolean(args, "follow")) {
    const recent = await readEvents({ importId: id, limit: 20 });
    for (const event of recent) line(`  [${event.step ?? "-"}] ${event.message}`);
    const code = await followImport(id);
    await printJob(id);
    return code;
  }
  await printJob(id);
  return 0;
}

async function cmdRetry(args: Args): Promise<number> {
  const id = args.positional[1];
  const step = flagString(args, "step");
  if (id === undefined || step === undefined) {
    throw new MMError("INVALID_INPUT", `usage: mm retry <id> --step <${STEP_ORDER.join("|")}>`);
  }
  if (!(STEP_ORDER as readonly string[]).includes(step)) {
    throw new MMError("INVALID_INPUT", `Unknown step "${step}". One of: ${STEP_ORDER.join(", ")}.`);
  }
  const outcome = await retryStep(id, step as StepName, { db: db(), only: true });
  line(`retried ${step}: ${outcome.ran[0]?.result.status ?? "?"}`);

  const boss = createBoss({ producer: true });
  await boss.start();
  if (outcome.step === "download") await enqueueDownload(boss, { importId: id });
  else await enqueueImportStep(boss, { importId: id, reason: "retry" });
  await stopBoss(boss);

  await printJob(id);
  return 0;
}

async function cmdInbox(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "list";
  if (sub === "list") {
    const items = await listInbox({
      ...(flagBoolean(args, "all") ? {} : { status: "open" as const }),
    });
    if (items.length === 0) {
      line("inbox empty");
      return 0;
    }
    line("ID                              TYPE                  STATUS     TITLE");
    for (const item of items) {
      line(item.id.padEnd(31), item.type.padEnd(21), item.status.padEnd(10), item.title);
    }
    return 0;
  }

  if (sub === "resolve") {
    const accept = flagBoolean(args, "accept");
    const id = args.positional[2];
    const importFilter = flagString(args, "import");

    // `--all` answers every open item the same way. An album whose fingerprints all disagree
    // raises one item per track, and answering fourteen identical questions one at a time is
    // not a decision, it is typing.
    const items =
      id === undefined
        ? flagBoolean(args, "all")
          ? await listInbox({
              status: "open",
              ...(importFilter === undefined ? {} : { importId: importFilter }),
            })
          : []
        : [await getInboxItem(id)].filter((item) => item !== null);

    if (id !== undefined && items.length === 0) {
      throw new MMError("NOT_FOUND", `No Inbox item with id ${id}.`);
    }
    if (items.length === 0) {
      throw new MMError(
        "INVALID_INPUT",
        "usage: mm inbox resolve <id> --accept | mm inbox resolve --all --accept [--import <id>]",
      );
    }

    const affected = new Set<string>();
    for (const item of items) {
      await resolveInboxItem(item.id, {
        resolution: accept
          ? { accepted: true, ...(item.preselected ?? {}) }
          : { accepted: false, action: "dismiss" },
        decidedBy: "cli",
        status: accept ? "resolved" : "dismissed",
      });
      line(`${accept ? "accepted" : "dismissed"} ${item.type} — ${item.title}`);
      if (item.importId !== null) affected.add(item.importId);
    }

    // The jobs were parked waiting for exactly this. Put them back on the queue.
    if (affected.size > 0) {
      const boss = createBoss({ producer: true });
      await boss.start();
      for (const importId of affected) {
        await enqueueImportStep(boss, { importId, reason: "inbox resolved" });
        line(`resumed ${importId}`);
      }
      await stopBoss(boss);
      const first = [...affected][0];
      if (flagBoolean(args, "follow") && affected.size === 1 && first !== undefined) {
        const code = await followImport(first);
        await printJob(first);
        return code;
      }
    }
    return 0;
  }

  throw new MMError(
    "INVALID_INPUT",
    "usage: mm inbox list | mm inbox resolve <id> --accept | mm inbox resolve --all --accept",
  );
}

/* ------------------------------------------------------------------ */
/* mm match — the preselection, without importing anything (P05)       */
/* ------------------------------------------------------------------ */

/**
 * `mm match <url> [--kind album|single] [--json]` — run the matcher and print what it thinks,
 * without creating a job, downloading anything, or touching the library.
 *
 * The point of a separate command is that the preselection is the part of the pipeline most
 * worth arguing with, and arguing with it should not cost an import. It is also how the
 * acceptance table of `docs/phases/P05-matching.md` is checked by hand.
 *
 * A `fixture://…` URL replays a recorded scenario — the videos and every MusicBrainz document
 * come off the cassette, so this needs neither the network nor the toolbox. A real URL goes
 * through the toolbox for the video listing and through MusicBrainz for the rest, at one
 * request per second.
 */
async function cmdMatch(args: Args): Promise<number> {
  const url = args.positional[1];
  if (url === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      "usage: mm match <url|fixture://…> [--kind album|single] [--json]",
    );
  }
  const asJson = flagBoolean(args, "json");
  const forced = flagString(args, "kind");
  if (forced !== undefined && forced !== "album" && forced !== "single") {
    throw new MMError("INVALID_INPUT", `--kind must be album or single, not "${forced}".`);
  }

  const prepared = await prepareMatch(url);
  const kind = forced ?? prepared.kind;
  const settings = await loadSettings(db());

  if (kind === "single") {
    const video = prepared.videos[0];
    if (video === undefined) throw new MMError("INVALID_INPUT", "no video to match.");
    const result = await matchSingle(prepared.gateway, { video }, settings);
    if (asJson) {
      console.log(JSON.stringify({ ...result, kind, video }, null, 2));
      return 0;
    }
    printSingle(video, result);
    return 0;
  }

  const result = await matchAlbum(
    prepared.gateway,
    { videos: prepared.videos, hints: prepared.hints },
    settings,
  );
  if (asJson) {
    console.log(JSON.stringify({ ...result, kind, hints: prepared.hints }, null, 2));
    return 0;
  }
  printAlbum(prepared, result);
  return 0;
}

interface PreparedMatch {
  readonly kind: "album" | "single";
  readonly source: string;
  readonly videos: readonly MatchVideo[];
  readonly hints: AlbumHints;
  readonly gateway: MbGateway;
}

/** Where the videos and the MusicBrainz documents come from, for one `mm match`. */
async function prepareMatch(url: string): Promise<PreparedMatch> {
  const name = cassetteNameOf(url);
  if (name !== null) {
    const cassette = loadCassette(name);
    if (cassette === null) {
      throw new MMError("NOT_FOUND", `No recorded scenario "${name}".`, {
        hint: `Known: ${cassetteNames().join(", ") || "none"}.`,
        action: "List the scenarios",
      });
    }
    return {
      kind: cassette.kind,
      source: `${cassette.name} (recorded ${cassette.recordedAt.slice(0, 10)})`,
      videos: cassette.videos,
      // Derived, not read off `cassette.source` — the step derives them, so the command has
      // to derive them too or it would be scoring a different question.
      hints: albumHints(cassette.videos),
      gateway: cassetteGateway(cassette),
    };
  }

  const extract = await toolbox().extract(url);
  const videos: MatchVideo[] = extract.entries.map((entry, index) => ({
    id: entry.id,
    index,
    title: entry.title,
    durationSeconds: entry.duration ?? null,
    uploader: entry.uploader ?? null,
    ytTrack: entry.track ?? null,
    ytArtist: entry.artist ?? null,
    ytAlbum: entry.album ?? null,
    ytReleaseYear: entry.release_year ?? null,
  }));
  return {
    kind: extract.kind === "video" || videos.length <= 1 ? "single" : "album",
    source: url,
    videos,
    hints: albumHints(videos, { album: extract.title, artist: extract.uploader }),
    gateway: liveGateway(await sourceContextFor(db())),
  };
}

/** A column of scores only reads as a ranking when the decimals line up. */
function score3(value: number): string {
  return value.toFixed(3);
}

const MAPPING_MARK: Record<string, string> = {
  confident: "ok   ",
  check: "?    ",
  unmatched: "extra",
};

function printAlbum(prepared: PreparedMatch, result: AlbumMatch): void {
  line(`source      ${prepared.source}`);
  line(`videos      ${String(prepared.videos.length)}`);
  line(
    `looking for ${prepared.hints.album ?? "?"} — ${prepared.hints.artist ?? "?"}` +
      `${prepared.hints.year == null ? "" : ` (${String(prepared.hints.year)})`}`,
  );
  line(
    `budget      ${String(result.budget.searches)} search(es) + ` +
      `${String(result.budget.lookups)} lookup(s)`,
  );
  line("");
  line("   score  fit    mean Δ  tk  where             release");
  for (const candidate of result.ranking.candidates.slice(0, 10)) {
    // `*` preselected, ` ` looked up, `·` never looked up — so the budget is visible.
    const mark = candidate.preselected ? "*" : candidate.detailed ? " " : "·";
    const fit = candidate.detailed ? `${String(candidate.fit)}/${String(candidate.fitOf)}` : "-";
    const delta = candidate.durDelta === null ? "-" : `${candidate.durDelta.toFixed(2)}s`;
    const where = `${candidate.country ?? "??"} ${candidate.format ?? "?"}`;
    line(
      ` ${mark} ${score3(candidate.score)}  ${fit.padEnd(6)} ${delta.padEnd(7)} ` +
        `${String(candidate.tracks).padStart(2)}  ${where.padEnd(17).slice(0, 17)} ` +
        `${candidate.title}${candidate.disambiguation === "" ? "" : ` (${candidate.disambiguation})`}`,
    );
  }

  const first = result.ranking.preselected;
  if (first !== null) {
    line("");
    line(`preselected ${first.title} — ${first.id}${first.safe ? "   [safe]" : ""}`);
    for (const why of first.why) line(`  · ${why}`);
    line(
      `margin      ${result.ranking.margin === null ? "n/a" : score3(result.ranking.margin)}` +
        `${result.ranking.ambiguous ? "   → ambiguous_release: the Inbox would ask" : ""}`,
    );
  }

  const proposal = result.mapping;
  if (proposal === null) return;
  line("");
  line(
    `mapping     ${String(proposal.bound)} bound, ` +
      `${String(proposal.extraVideos.length)} extra video(s), ` +
      `${String(proposal.uncoveredTracks.length)} uncovered track(s)`,
  );
  for (const mapped of proposal.lines) {
    const track = mapped.trackN === null ? " --" : String(mapped.trackN).padStart(3);
    const delta =
      mapped.delta === null ? "" : `  ${mapped.delta > 0 ? "+" : ""}${mapped.delta.toFixed(1)}s`;
    line(
      ` ${String(mapped.videoIndex + 1).padStart(3)} ${MAPPING_MARK[mapped.status] ?? "     "} ` +
        `${track}  ${score3(mapped.confidence)}  ` +
        `${(mapped.trackTitle ?? mapped.videoTitle).padEnd(36).slice(0, 36)}${delta}`,
    );
  }
  for (const track of proposal.uncoveredTracks) {
    line(` uncovered   ${String(track.position).padStart(3)}         ${track.title}`);
  }
  line("");
  line("Nothing was imported. `confirm` is still required — decision 002.");
}

function printSingle(video: MatchVideo, result: SingleMatch): void {
  line(`video       ${video.title}`);
  line(
    `duration    ${video.durationSeconds === null ? "?" : `${String(video.durationSeconds)}s`}` +
      `${video.uploader == null ? "" : `, uploaded by ${video.uploader}`}`,
  );
  line(
    `budget      ${String(result.budget.searches)} search(es) + ` +
      `${String(result.budget.lookups)} lookup(s)`,
  );
  line("");
  line("   score  length  artist                 recording                      filed under");
  for (const candidate of result.ranking.candidates.slice(0, 10)) {
    const mark = candidate.preselected ? "*" : " ";
    const length = candidate.length === null ? "-" : `${String(Math.round(candidate.length))}s`;
    const named = `${candidate.title}${candidate.disambiguation === "" ? "" : ` (${candidate.disambiguation})`}`;
    const borrow =
      candidate.borrow === null
        ? "—"
        : `${candidate.borrow.title} [${candidate.borrow.type ?? "?"}]`;
    line(
      ` ${mark} ${score3(candidate.score)}  ${length.padEnd(7)} ` +
        `${candidate.artist.padEnd(22).slice(0, 22)} ${named.padEnd(30).slice(0, 30)} ${borrow}`,
    );
  }

  const first = result.ranking.preselected;
  if (first !== null) {
    line("");
    line(`preselected ${first.title} — ${first.id}${first.safe ? "   [safe]" : ""}`);
    for (const why of first.why) line(`  · ${why}`);
    line(
      `margin      ${result.ranking.margin === null ? "n/a" : score3(result.ranking.margin)}` +
        `${result.ranking.ambiguous ? "   → ambiguous_recording: the Inbox would ask" : ""}`,
    );
  }
  line("");
  line("Nothing was imported. `confirm` is still required — decision 002.");
}

/* ------------------------------------------------------------------ */
/* mm doc — the metadata document (P04)                                */
/* ------------------------------------------------------------------ */

const VISIT_MARK: Record<SourceVisit["outcome"], string> = {
  fetched: "net ",
  hit: "cach",
  absent: "none",
  skipped: "skip",
  failed: "FAIL",
};

function printVisits(visits: readonly SourceVisit[]): void {
  if (visits.length === 0) return;
  line("");
  line(" sources consulted:");
  for (const visit of visits) {
    line(
      `  ${VISIT_MARK[visit.outcome]} ${visit.source.padEnd(16)} ${visit.key.slice(0, 52).padEnd(53)}${visit.note ?? visit.fetchedAt ?? ""}`,
    );
  }
}

/** A value, short enough to read in a table. Lyrics and pictures are summarised, not dumped. */
function short(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length > 0 && typeof value[0] === "object") {
      return `${String(value.length)} entr${value.length === 1 ? "y" : "ies"}`;
    }
    return value.map((item) => String(item)).join("; ");
  }
  if (typeof value === "object" && value !== null) {
    const held = value as { synced?: string | null; plain?: string | null };
    if ("synced" in held || "plain" in held) {
      return held.synced != null ? "synced lyrics" : held.plain != null ? "plain lyrics" : "-";
    }
    return canonicalValue(value as never).slice(0, 60);
  }
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

async function cmdDoc(args: Args): Promise<number> {
  const sub = args.positional[1];
  const id = args.positional[2];
  if (sub === undefined || id === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      "usage: mm doc build <id> | mm doc show <id> [--missing] [--json] | mm doc rebuild <id> [--offline]",
    );
  }

  if (sub === "build" || sub === "rebuild") {
    // `rebuild` is offline by default — that is what distinguishes it from `build`. `--offline`
    // on `build` says the same thing explicitly, and `--online` on `rebuild` opts back out.
    const offline = sub === "rebuild" ? !flagBoolean(args, "online") : flagBoolean(args, "offline");
    const run = sub === "rebuild" ? rebuildDocument : buildDocument;
    const result = await run(id, {
      offline,
      refresh: flagBoolean(args, "refresh"),
    });

    line(`document ${result.documentId} for ${result.importTrackId}`);
    line(`  mode        ${offline ? "offline (cache only)" : "online"}`);
    line(
      `  fields      ${String(Object.keys(result.document.fields).length)} present, ${String(Object.keys(result.document.na).length)} n/a`,
    );
    line(`  completeness ${result.completeness === null ? "n/a" : result.completeness.toFixed(3)}`);
    line(`  requests    ${String(result.requests)}`);
    if (offline && result.requests > 0) {
      // The whole promise of §8 is that a rebuild costs nothing. If it ever stops being true,
      // it must be loud rather than slow.
      console.error(
        `\nOFFLINE VIOLATION: ${String(result.requests)} outgoing request(s) during an offline rebuild.`,
      );
      printVisits(result.visits);
      return 1;
    }
    if (!flagBoolean(args, "quiet")) printVisits(result.visits);
    return 0;
  }

  if (sub === "show") {
    const stored = await storedDocument(id);
    if (stored === null) {
      throw new MMError("NOT_FOUND", `No document for ${id}.`, {
        hint: "`mm doc build <id>` builds it.",
        action: "Build it",
      });
    }
    if (flagBoolean(args, "json")) {
      console.log(JSON.stringify(stored.document, null, 2));
      return 0;
    }

    const report = trackCompleteness(stored.document);
    const onlyMissing = flagBoolean(args, "missing");

    line(`document for ${stored.importTrackId}`);
    line(
      `  completeness ${stored.completeness === null ? "n/a" : stored.completeness.toFixed(3)}  ·  ${String(report.present.length)} present, ${String(report.missing.length)} missing, ${String(report.na.length)} n/a`,
    );
    line("");

    if (onlyMissing) {
      const byLevel = {
        required: [] as string[],
        recommended: [] as string[],
        optional: [] as string[],
      };
      for (const field of report.missing) {
        const tag = tagByField(field);
        if (tag !== undefined) byLevel[tag.level].push(`${field} (${tag.vorbis})`);
      }
      for (const level of ["required", "recommended", "optional"] as const) {
        const held = byLevel[level];
        line(` ${level.padEnd(12)} ${held.length === 0 ? "— none missing" : String(held.length)}`);
        for (const entry of held) line(`   ${entry}`);
      }
      line("");
      line(` n/a (${String(report.na.length)}) — the source says the field does not exist:`);
      for (const field of report.na) {
        const reason = stored.document.na[field]?.reason ?? "";
        line(`   ${field.padEnd(28)} ${reason}`);
      }
      return byLevel.required.length === 0 ? 0 : 1;
    }

    line(
      "FIELD                        VORBIS                     SOURCE        FETCHED AT            VALUE",
    );
    for (const entry of report.fields) {
      if (entry.state === "present") {
        const held = stored.document.fields[entry.field];
        if (held === undefined) continue;
        line(
          `${entry.field.padEnd(28)} ${entry.vorbis.padEnd(26)} ${held.source.padEnd(13)} ${held.fetchedAt.slice(0, 19).padEnd(21)} ${held.locked ? "🔒 " : ""}${short(held.value)}`,
        );
      } else if (entry.state === "na") {
        const held = stored.document.na[entry.field];
        line(
          `${entry.field.padEnd(28)} ${entry.vorbis.padEnd(26)} ${(held?.source ?? "-").padEnd(13)} ${"n/a".padEnd(21)} ${held?.reason ?? ""}`,
        );
      } else {
        line(
          `${entry.field.padEnd(28)} ${entry.vorbis.padEnd(26)} ${"-".padEnd(13)} ${`missing (${entry.level})`.padEnd(21)}`,
        );
      }
    }
    return 0;
  }

  throw new MMError("INVALID_INPUT", `Unknown doc subcommand "${sub}".`, {
    hint: "build, show or rebuild.",
  });
}

/** `mm sources` — which credentials are configured, without printing any of them. */
async function cmdSources(): Promise<number> {
  const settings = await loadSettings();
  const config = sourcesConfig(settings);
  line(`user-agent  ${config.userAgent}`);
  line("");
  for (const [name, state] of Object.entries(credentialReport(config))) {
    line(`  ${name.padEnd(22)} ${state}`);
  }
  line("");
  line("  source           enabled  ttl (days)");
  for (const [name, on] of Object.entries(config.enabled)) {
    const days = config.ttlMs[name as keyof typeof config.ttlMs] / 86_400_000;
    line(
      `  ${name.padEnd(17)} ${(on ? "yes" : "no").padEnd(8)} ${days === 0 ? "never" : String(days)}`,
    );
  }
  return 0;
}

async function cmdSettings(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "get";
  if (sub === "get") {
    const key = args.positional[2];
    const all = await loadSettings();
    // A credential is never printed, here or anywhere else: `maskSetting` turns it into its
    // length and last two characters, which distinguishes "wrong key" from "no key" and
    // nothing more.
    if (key === undefined) {
      for (const name of SETTING_KEYS) {
        line(name.padEnd(30), JSON.stringify(maskSetting(name, all[name])));
      }
      return 0;
    }
    if (!isSettingKey(key)) throw new MMError("INVALID_INPUT", `Unknown setting "${key}".`);
    line(JSON.stringify(maskSetting(key, all[key])));
    return 0;
  }

  if (sub === "set") {
    const key = args.positional[2];
    const raw = args.positional[3];
    if (key === undefined || raw === undefined) {
      throw new MMError("INVALID_INPUT", "usage: mm settings set <key> <value>");
    }
    if (!isSettingKey(key)) throw new MMError("INVALID_INPUT", `Unknown setting "${key}".`);
    const value = await setSetting(key as SettingKey, parseCliValue(key as SettingKey, raw), {
      setBy: "cli",
    });
    line(`${key} = ${JSON.stringify(maskSetting(key as SettingKey, value))}`);
    return 0;
  }

  if (sub === "list") {
    for (const name of SETTING_KEYS) {
      const mark = isSecretSetting(name) ? " (secret)" : "";
      line(name.padEnd(30), `${SETTING_DEFINITIONS[name].doc}${mark}`);
    }
    return 0;
  }

  throw new MMError("INVALID_INPUT", "usage: mm settings get|set|list");
}

async function cmdControl(args: Args, action: "cancel" | "pause" | "bump"): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) throw new MMError("INVALID_INPUT", `usage: mm ${action} <id>`);
  if (action === "cancel") await cancelImport(id);
  if (action === "pause") await pauseImport(id, "paused from the CLI");
  if (action === "bump") {
    const priority = await bumpImport(id);
    line(`priority ${String(priority)}`);
  }
  await printJob(id);
  return 0;
}

const USAGE = `mm — Music Manager

  mm import <url|fixture://…> [--release <mbid>] [--mapping <file.json>] [--yes] [--force] [--follow]
  mm match <url|fixture://…> [--kind album|single] [--json]   score candidates without importing
  mm jobs
  mm job <id> [--follow]
  mm retry <id> --step <${STEP_ORDER.join("|")}>
  mm inbox list [--all]
  mm inbox resolve <id> --accept [--follow]
  mm inbox resolve --all --accept [--import <id>]
  mm settings get [key] | set <key> <value> | list
  mm pause <id> | mm cancel <id> | mm bump <id>

  mm doc build <import_track_id|library_track_id> [--offline] [--refresh]
  mm doc show <id> [--missing] [--json]
  mm doc rebuild <id> [--offline]        offline by default; exits 1 if anything left the machine
  mm sources                             which credentials are set, and every source's TTL

Environment: DATABASE_URL, MM_TOOLBOX_URL, MM_FIXTURES, MM_LIBRARY_ROOT, MM_TOOLBOX_LIBRARY_ROOT,
             MM_MB_CONTACT, MM_ACOUSTID_KEY, MM_LASTFM_KEY, MM_FANARTTV_KEY.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  switch (command) {
    case "import":
      return await cmdImport(args);
    case "match":
      return await cmdMatch(args);
    case "jobs":
      return await cmdJobs();
    case "job":
      return await cmdJob(args);
    case "retry":
      return await cmdRetry(args);
    case "inbox":
      return await cmdInbox(args);
    case "settings":
      return await cmdSettings(args);
    case "doc":
      return await cmdDoc(args);
    case "sources":
      return await cmdSources();
    case "cancel":
    case "pause":
    case "bump":
      return await cmdControl(args, command);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command "${command}"\n`);
      console.log(USAGE);
      return 2;
  }
}

try {
  process.exit(await main());
} catch (error) {
  fail(error);
}
