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
import { overrideAlbumFields, overrideTrackFields } from "#/server/services/overrides.ts";
import { isId } from "#/server/ids.ts";
import { credentialReport, sourcesConfig } from "#/server/integrations/config.ts";
import type { StepName } from "#/server/db/schema/index.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import { readEvents, subscribe } from "#/server/services/events.ts";
import { getInboxItem, listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { offersUntaggedImport, UNTAGGED_RESOLUTION } from "#/server/services/inbox.resolution.ts";
import { createImport, getImport } from "#/server/services/imports.ts";
import { collapseParkedDuplicates } from "#/server/services/imports.reuse.ts";
import { folderPathOf } from "#/server/services/import-source.ts";
import { confirmBest, createImportsBatch, MAX_BATCH_URLS } from "#/server/services/imports.bulk.ts";
import { adoptTrackFile } from "#/server/services/adopt.ts";
import { adoptLibraryTrack, albumMissingTracks } from "#/server/services/album-missing.ts";
import {
  bumpImport,
  cancelImport,
  forgetMapping,
  listImports,
  pauseImport,
  requeueFailuresAt,
  requeueUpstreamFailures,
  rewindTo,
  stepsOf,
} from "#/server/services/jobs/index.ts";
import { enqueueAll } from "#/server/services/queue.ts";
import { forgetsMapping } from "#/server/services/retry-plan.ts";
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
import { enqueueRetag } from "#/worker/handlers/retag.ts";
import { albumDetail, albumGrid, artistList, trackList } from "#/server/services/library.ts";
import {
  cancelRun,
  createRun,
  emptyReason,
  emptyRunNote,
  listRuns,
  runToCompletion,
  runView,
} from "#/server/services/retag.ts";
import { relocate } from "#/server/services/relocate.ts";
import { cmdRepairOrphans, cmdScan, cmdTools, cmdVerify } from "./commands/library-ops.ts";
import { cmdDiscover } from "./commands/discover.ts";
import { cmdWatch } from "./commands/watch.ts";
import { cmdMigrate } from "./commands/migrate.ts";

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

/**
 * `mm import --from-file <path>` — one line per **source**, `#` comments and blanks dropped.
 *
 * The bulk form of the paste box. Nothing is resolved in this process: `createImportsBatch`
 * queues the rows and the worker resolves them, which is what makes three hundred sources a
 * second's work here instead of an hour of extractions.
 *
 * A line may be a **folder path** as well as a URL — they go through the same
 * `parseImportSource` — which is how twenty album folders are queued in one command. Note that
 * a folder refused for its path or for holding no audio is reported on *its* line and costs
 * the other nineteen nothing, because a batch resolves later and per row.
 */
async function cmdImportBatch(args: Args, path: string): Promise<number> {
  const urls = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row !== "" && !row.startsWith("#"));
  if (urls.length === 0) {
    throw new MMError("INVALID_INPUT", `${path} holds no URLs.`, {
      hint: "One URL per line; `#` starts a comment.",
    });
  }

  const signed = flagBoolean(args, "yes");
  let created = 0;
  const failures: { index: number; url: string; code: string; message: string }[] = [];

  // The service caps a batch; chunk here so a file of four hundred is four calls rather than a
  // refusal the person reading the file did not ask for.
  for (let start = 0; start < urls.length; start += MAX_BATCH_URLS) {
    const outcome = await createImportsBatch({
      urls: urls.slice(start, start + MAX_BATCH_URLS),
      db: db(),
      source: "cli batch",
      options: {
        autoConfirm: signed,
        ...(signed ? { confirmedBy: "cli --yes" } : {}),
        force: flagBoolean(args, "force"),
        ...(flagBoolean(args, "no-fingerprint") ? { fingerprint: false } : {}),
        // The same pair `mm import <one>` takes, and missing here until now: a file of a
        // hundred YouTube playlists is exactly the case where "MusicBrainz has never published
        // this" is worth stating once instead of eight times in the review queue.
        ...(flagBoolean(args, "no-untagged")
          ? { untaggedFallback: false }
          : flagBoolean(args, "untagged")
            ? { untaggedFallback: true }
            : {}),
      },
    });
    created += outcome.created;
    for (const row of outcome.results) {
      if (row.ok || row.error === null) continue;
      failures.push({
        index: row.index + start,
        url: row.url,
        code: row.error.code,
        message: row.error.message,
      });
    }
  }

  line(`${String(created)} of ${String(urls.length)} import(s) created and queued`);
  for (const failure of failures) {
    line(`  ! ${String(failure.index + 1).padStart(4)}  ${failure.url}`);
    line(`         ${failure.code}: ${failure.message}`);
  }
  line(`  run \`bun run worker\` if nothing moves`);
  return failures.length === 0 ? 0 : 1;
}

/**
 * `mm confirm-best <id>` — confirm the engine's best candidate, on whichever bar applies.
 *
 * The same service the REST route and the MCP tool call, so the three cannot drift; the only
 * thing that differs is `confirmedBy`, which is the door the decision came through. An album is
 * decided on `--min-coverage`, a single on `--min-margin`; the printout names which one ran, so
 * a terminal never leaves you guessing what the number on the screen was measured against.
 */
async function cmdConfirmBest(args: Args): Promise<number> {
  const id = args.positional[1];
  if (id === undefined) {
    throw new MMError("INVALID_INPUT", CONFIRM_BEST_USAGE);
  }
  const coverage = flagString(args, "min-coverage");
  const margin = flagString(args, "min-margin");
  const prefer = flagString(args, "prefer");
  if (prefer !== undefined && prefer !== "album" && prefer !== "any") {
    throw new MMError("INVALID_INPUT", "--prefer takes `album` or `any`.");
  }

  const outcome = await confirmBest({
    importId: id,
    ...(coverage === undefined ? {} : { minCoverage: Number(coverage) }),
    ...(margin === undefined ? {} : { minMargin: Number(margin) }),
    ...(prefer === undefined ? {} : { preferType: prefer }),
    confirmedBy: "cli confirm-best",
    db: db(),
    source: "cli confirm-best",
  });

  line(`confirmed ${outcome.importId} (${outcome.kind})`);
  if (outcome.chosen.kind === "release") {
    const chosen = outcome.chosen;
    line(
      `  release  ${chosen.artist} — ${chosen.title} (${chosen.primaryType ?? "?"})  ${chosen.mbid}`,
    );
    line(
      `  coverage ${String(Math.round(chosen.coverage * 100))} %` +
        ` of ${String(chosen.videos)} video(s), over ${String(outcome.candidatesConsidered)} candidate(s)`,
    );
  } else {
    const chosen = outcome.chosen;
    line(`  recording ${chosen.artist} — ${chosen.title}  ${chosen.mbid}`);
    line(
      `  filed as  ${chosen.releaseTitle} (${chosen.releaseType ?? "release"})  ${chosen.releaseMbid}`,
    );
    line(
      `  margin   ${chosen.margin === null ? "no runner-up" : String(chosen.margin)}` +
        ` over ${String(outcome.minMargin ?? 0)}, duration ${chosen.durationDelta === null ? "?" : `${String(chosen.durationDelta)} s`}` +
        `, title ${String(chosen.titleAgreement)}, artist ${String(chosen.artistAgreement)}`,
    );
  }
  line(
    `  mapped   ${String(outcome.mapped ?? 0)} track(s), ` +
      `${String(outcome.extras ?? 0)} extra, ${String(outcome.uncovered)} uncovered`,
  );
  line(`  status   ${outcome.status} (step ${outcome.step})`);
  return 0;
}

/** One sentence, used by the usage error and by `USAGE`, so the two cannot disagree. */
const CONFIRM_BEST_USAGE =
  "usage: mm confirm-best <id> [--min-coverage 0.8] [--min-margin 0.04] [--prefer album|any]";

async function cmdImport(args: Args): Promise<number> {
  const fromFile = flagString(args, "from-file");
  if (fromFile !== undefined) return await cmdImportBatch(args, fromFile);

  const source = args.positional[1];
  if (source === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      "usage: mm import <url|fixture://…|folder> | mm import --from-file <path>",
    );
  }

  const mappingFile = flagString(args, "mapping");
  const mapping =
    mappingFile === undefined
      ? undefined
      : (JSON.parse(readFileSync(mappingFile, "utf8")) as never);

  const created = await createImport(source, {
    ...(flagString(args, "release") === undefined
      ? {}
      : { releaseMbid: flagString(args, "release") }),
    ...(mapping === undefined ? {} : { mapping }),
    autoConfirm: flagBoolean(args, "yes"),
    // The CLI names itself like every other caller rather than being the value `confirm`
    // falls back to when nobody said anything — which is how three other callers ended up
    // wearing this label in the audit trail.
    ...(flagBoolean(args, "yes") ? { confirmedBy: "cli --yes" } : {}),
    force: flagBoolean(args, "force"),
    ...(flagBoolean(args, "no-fingerprint") ? { fingerprint: false } : {}),
    // Only when it was *said*. Absent means "decide by the source" — on for a folder, off for
    // a URL — and writing the computed default here would freeze today's rule into the row.
    ...(flagBoolean(args, "no-untagged")
      ? { untaggedFallback: false }
      : flagBoolean(args, "untagged")
        ? { untaggedFallback: true }
        : {}),
  });

  const folder = folderPathOf(created.job.url);
  line(`import ${created.job.id}`);
  if (folder === null) line(`  url    ${created.job.url}`);
  else line(`  folder ${folder}`);
  line(`  kind   ${created.job.kind}`);
  line(`  title  ${created.job.title ?? "-"}`);
  if (created.duplicates.length > 0) {
    line(
      `  note   ${String(created.duplicates.length)} earlier import(s) of the same ` +
        `${folder === null ? "URL" : "folder"}`,
    );
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

/**
 * `mm jobs collapse` — the broom for the wizard's old duplicates.
 *
 * 204 imports parked at "Waiting for the import wizard" for 7 URLs, because every visit to the
 * wizard opened a new one. The wizard no longer does that (`services/imports.reuse.ts`); this
 * collapses what is already there, keeping the newest import of every URL.
 *
 * **Dry by default**, like `mm relocate` and `mm library repair-orphans`. It cancels rows, and
 * a command that would cancel 197 imports has to be able to say which ones first.
 *
 * The guard is not restated here — it is `findParkedDuplicates`', shared with the reuse rule —
 * but it is worth naming: only imports that are `paused`, not by the worker, no further than
 * `match`, and with **no track that has downloaded, tagged or placed anything**. An import that
 * has done work is never in this list, and every URL keeps one.
 */
async function cmdJobsCollapse(args: Args): Promise<number> {
  const url = flagString(args, "url");
  const apply = flagBoolean(args, "apply");
  const result = await collapseParkedDuplicates({
    apply,
    db: db(),
    ...(url === undefined ? {} : { url }),
  });

  if (flagBoolean(args, "json")) {
    line(JSON.stringify(result, null, 2));
    return 0;
  }

  if (result.groups.length === 0) {
    line("no parked duplicates — every URL already has at most one import waiting");
    return 0;
  }

  line(
    `${String(result.cancelled)} redundant parked import(s) across ${String(result.groups.length)} URL(s)` +
      (result.applied ? ", cancelled" : " — dry run, nothing changed"),
  );
  line("");
  for (const group of result.groups) {
    line(
      `  ${String(result.applied ? "cancelled" : "would cancel")} ${String(group.cancel.length).padStart(3)}  ${group.url}`,
    );
    line(`      keeping ${group.keep} (opened ${group.keepCreatedAt})`);
  }
  if (!result.applied) {
    line("");
    line("  re-run with --apply to cancel them");
  }
  return 0;
}

async function cmdJobs(args: Args): Promise<number> {
  if (args.positional[1] === "collapse") return await cmdJobsCollapse(args);
  if (args.positional[1] !== undefined) {
    throw new MMError("INVALID_INPUT", `Unknown jobs subcommand "${args.positional[1]}".`, {
      hint: "usage: mm jobs [collapse [--url <url>] [--apply] [--json]]",
    });
  }
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

/**
 * `mm retry --failed-upstream` — the forty-five, in one command.
 *
 * The whole point of the flag is that the answer to a source outage is not forty-five
 * invocations of `mm retry <id> --step match`, typed out of a list read off a screen. The
 * selection is `classifyFailure`'s, so it is the same rule that decides the live case, and it
 * catches rows written long before this branch existed: a 503 stored as `SOURCE_UNAVAILABLE`
 * with `status: 503` is what the rule was written to recognise.
 *
 * `--dry-run` prints the selection and touches nothing, because "which forty-five?" is a fair
 * question to ask before answering it.
 */
async function cmdRetryFailedUpstream(args: Args): Promise<number> {
  const dryRun = flagBoolean(args, "dry-run");
  const limitFlag = flagString(args, "limit");
  const limit = limitFlag === undefined ? undefined : Number(limitFlag);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new MMError("INVALID_INPUT", `--limit wants a positive integer, got "${limitFlag}".`);
  }

  const planned = await requeueUpstreamFailures(
    { dryRun, ...(limit === undefined ? {} : { limit }) },
    db(),
  );
  if (planned.length === 0) {
    line("no import failed on a source; nothing to requeue");
    return 0;
  }

  line("ID                               STEP          SOURCE        CODE");
  for (const job of planned) {
    line(
      job.id.padEnd(32),
      job.restartAt.padEnd(13),
      (job.source ?? "-").padEnd(13),
      job.code,
      "  ",
      job.title ?? job.url,
    );
  }

  if (dryRun) {
    line("");
    line(`${String(planned.length)} import(s) would be requeued (--dry-run: nothing was touched)`);
    return 0;
  }

  const queued = await enqueueAll(
    planned.map((job) => ({ importId: job.id, step: job.restartAt })),
    "retry --failed-upstream",
  );
  line("");
  line(`${String(queued)} import(s) rewound and queued for the worker`);
  // Idempotent on purpose: they are no longer `failed`, so running this again selects nothing.
  return 0;
}

/**
 * `mm retry --failed-step resolve` — every import that died on one step, in one command.
 *
 * The companion to `--failed-upstream`, and not a widening of it. That flag selects on
 * `wasKilledByASource`: a 429, a 5xx, a timeout — failures that pass. The twenty album
 * playlists this was written for failed on `resolve` under `YTDLP_UNAVAILABLE`, which is a 404
 * about a video that really is gone, and `classifyFailure` calls that a defect for good
 * reasons that should not be relaxed. What changed is not the classification but the code
 * underneath: the extraction no longer throws away nineteen good entries to report the
 * twentieth, so those twenty are worth asking again.
 *
 * The selector is therefore the *step*, which is the operator's own question — "re-read every
 * source that would not read" — and stays true whatever each row's reason was.
 */
async function cmdRetryFailedStep(args: Args, step: string): Promise<number> {
  if (!(STEP_ORDER as readonly string[]).includes(step)) {
    throw new MMError("INVALID_INPUT", `Unknown step "${step}". One of: ${STEP_ORDER.join(", ")}.`);
  }
  const dryRun = flagBoolean(args, "dry-run");
  const limitFlag = flagString(args, "limit");
  const limit = limitFlag === undefined ? undefined : Number(limitFlag);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new MMError("INVALID_INPUT", `--limit wants a positive integer, got "${limitFlag}".`);
  }

  const planned = await requeueFailuresAt(
    step as StepName,
    { dryRun, ...(limit === undefined ? {} : { limit }) },
    db(),
  );
  if (planned.length === 0) {
    line(`no import is failed at ${step}; nothing to requeue`);
    return 0;
  }

  line("ID                               CODE                       TITLE");
  for (const job of planned) {
    line(job.id.padEnd(32), job.code.padEnd(26), job.title ?? job.url);
  }

  if (dryRun) {
    line("");
    line(`${String(planned.length)} import(s) would be requeued (--dry-run: nothing was touched)`);
    return 0;
  }

  const queued = await enqueueAll(
    planned.map((job) => ({ importId: job.id, step: step as StepName })),
    `retry --failed-step ${step}`,
  );
  line("");
  line(`${String(queued)} import(s) rewound to ${step} and queued for the worker`);
  // Idempotent: they are no longer `failed`, so running it again selects nothing.
  return 0;
}

async function cmdRetry(args: Args): Promise<number> {
  if (flagBoolean(args, "failed-upstream")) return await cmdRetryFailedUpstream(args);
  const failedStep = flagString(args, "failed-step");
  if (failedStep !== undefined) return await cmdRetryFailedStep(args, failedStep);

  const id = args.positional[1];
  const step = flagString(args, "step");
  if (id === undefined || step === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      `usage: mm retry <id> --step <${STEP_ORDER.join("|")}>\n` +
        `       mm retry --failed-upstream [--dry-run] [--limit N]\n` +
        `       mm retry --failed-step <${STEP_ORDER.join("|")}> [--dry-run] [--limit N]`,
    );
  }
  if (!(STEP_ORDER as readonly string[]).includes(step)) {
    throw new MMError("INVALID_INPUT", `Unknown step "${step}". One of: ${STEP_ORDER.join(", ")}.`);
  }
  /*
   * A re-match discards the confirmed mapping, here exactly as in the Console.
   *
   * `matchStep` applies `options.mapping` verbatim when it is there, so `--step match` on a
   * confirmed import would re-apply the mapping the operator is trying to be rid of. Naming a
   * step on the command line is the same deliberate gesture as choosing one from the menu, and
   * two doors into one room must not disagree about what "match again" means.
   */
  if (forgetsMapping(step as StepName)) {
    await forgetMapping(id, db());
    line(`discarded the confirmed release and the video → track mapping`);
  }
  // Rewind here, run nowhere. The CLI used to execute the step in its own process, which on
  // `--step download` opened a second download beside the worker's and earned the job a
  // `409 LOCKED` from the toolbox (owner review C3). The worker owns execution.
  await rewindTo(id, step as StepName, db());
  line(`rewound to ${step}; queued for the worker`);

  const boss = createBoss({ producer: true });
  await boss.start();
  if (step === "download") await enqueueDownload(boss, { importId: id });
  else await enqueueImportStep(boss, { importId: id, reason: "retry" });
  await stopBoss(boss);

  await printJob(id);
  return 0;
}

/**
 * `mm adopt <import id> <track id> --file <path> | --from-url <address>` — give one track
 * audio from somewhere other than its own video.
 *
 * The CLI runs *on the server*, which is the whole reason the file form is a path and not an
 * upload: the files of a library being taken over are on this disk, and base64-ing them
 * through the local HTTP API to a process with the same filesystem would be ceremony.
 * `--upload` exists for the remote case, where the machine holding the file and the machine
 * holding the library really are two machines; it is in `remote-commands.ts`.
 *
 * **`--from-url` and not `--url`.** `--url` is already taken, globally and irrevocably:
 * `mm --url http://host:3000 --token mm_… <anything>` is how this CLI drives *another
 * installation*, and `maybeRemote` reads that flag off the command line before a command name
 * is even looked at (see the bottom of this file). A `--url` on `adopt` would therefore never
 * reach `cmdAdopt` at all — `mm adopt imp_1 itr_2 --url https://youtu.be/…` would be read as
 * "drive the installation at youtu.be", which fails somewhere unrecognisable. `--from-url`
 * says the same thing, pairs with `--file`, and cannot be mistaken for the other one. The
 * remote command uses the same spelling, so the two modes stay the same commands.
 *
 * The allow-list still applies to `--file`. `mm` has a database handle, not a licence: the
 * same `adoptSourceRoots` check runs here as on the HTTP route, because "which folders may
 * the application read from" is a property of the installation, not of the door. `--from-url`
 * is checked differently and just as closed — see `adoptUrlSchema`.
 */
async function cmdAdopt(args: Args): Promise<number> {
  const importId = args.positional[1];
  const trackId = args.positional[2];
  const file = flagString(args, "file");
  const from = flagString(args, "from-url");
  if (
    importId === undefined ||
    trackId === undefined ||
    (file === undefined) === (from === undefined)
  ) {
    throw new MMError(
      "INVALID_INPUT",
      "usage: mm adopt <import id> <track id> (--file <path on this server> | --from-url <address>)",
      {
        hint:
          file !== undefined && from !== undefined
            ? "Give one or the other: the bytes come from a file or from an address, not both."
            : "`--file <path>` takes audio already on this server. `--from-url <address>` makes " +
              "the server download this track from another upload of the same song — for a " +
              "video that is deleted, age-checked or Premium-only. It is spelled `--from-url` " +
              "and not `--url` because `--url` already means something else and would not " +
              "reach this command: `mm --url <base> --token mm_… <command>` is how the CLI " +
              "drives *another installation*, and that flag is read before the command name.",
        action: "mm adopt <id> <track id> --from-url 'https://www.youtube.com/watch?v=…'",
      },
    );
  }

  const result = await adoptTrackFile({
    importId,
    trackId,
    source: file === undefined ? { kind: "url", url: from ?? "" } : { kind: "path", path: file },
    adoptedBy: "cli adopt",
    db: db(),
  });

  line(
    result.downloadedFrom === null
      ? `adopted ${result.originalName} for ${result.trackId}`
      : `downloaded ${result.originalName} from ${result.downloadedFrom} for ${result.trackId}`,
  );
  line(`  file     ${result.path}`);
  line(
    `  audio    ${result.codec ?? "?"}` +
      (result.durationSeconds === null ? "" : `, ${String(Math.round(result.durationSeconds))} s`) +
      `, ${String(Math.round(result.bytes / 1024))} KiB`,
  );
  line(`  next     ${result.nextStep ?? "nothing left"}${result.queued ? " (queued)" : ""}`);
  line("");
  line(
    result.downloadedFrom === null
      ? "The tags will say this file was adopted, not downloaded."
      : "The tags will name the address it came from, and say the original source was unavailable.",
  );
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
    /*
     * The way out of a record MusicBrainz has never published, from a terminal.
     *
     * Same answer as the review card's and the API's, through the same shared shape: the album
     * is built from the source's own tags and flagged `untagged`. It implies an acceptance —
     * `--untagged` alone is an answer, not a dismissal — and it refuses an item it cannot apply
     * to rather than closing it, exactly as the batch does.
     */
    const untagged = flagBoolean(args, "untagged");
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
        "usage: mm inbox resolve <id> --accept | mm inbox resolve <id> --untagged | mm inbox resolve --all --accept [--import <id>]",
      );
    }

    const affected = new Set<string>();
    for (const item of items) {
      if (untagged && !offersUntaggedImport(item)) {
        throw new MMError(
          "INVALID_INPUT",
          `Importing from the source's own tags is not an answer to a ${item.type} item.`,
          {
            hint: "It is offered on an `ambiguous_release` the search found no candidate for — the card that says MusicBrainz has nothing for this title.",
            action: "Answer this one with its own options",
          },
        );
      }
      await resolveInboxItem(item.id, {
        resolution: untagged
          ? { ...UNTAGGED_RESOLUTION }
          : accept
            ? { accepted: true, ...(item.preselected ?? {}) }
            : { accepted: false, action: "dismiss" },
        decidedBy: "cli",
        status: accept || untagged ? "resolved" : "dismissed",
      });
      line(
        untagged
          ? `untagged ${item.type} — ${item.title}`
          : `${accept ? "accepted" : "dismissed"} ${item.type} — ${item.title}`,
      );
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
    "usage: mm inbox list | mm inbox resolve <id> --accept | mm inbox resolve <id> --untagged | mm inbox resolve --all --accept",
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

  /*
   * `fields` comes before the `<id>` guard: it is the one `doc` subcommand that takes no id,
   * and it exists precisely so that a person can read the scope of a field *before* running
   * `mm doc set` and being refused for getting it wrong.
   */
  if (sub === "fields") {
    const { cmdDocFields } = await import("./commands/doc-fields.ts");
    return await cmdDocFields({ positional: args.positional, flags: args.flags });
  }

  const id = args.positional[2];
  if (sub === undefined || id === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      "usage: mm doc fields [--album|--track] [--json] | mm doc build <id> | " +
        "mm doc show <id> [--missing] [--json] | mm doc rebuild <id> [--offline] | " +
        "mm doc set <id> <field> <value…> | mm doc lock <id> <field> | " +
        "mm doc unlock <id> <field>",
    );
  }

  if (sub === "set" || sub === "lock" || sub === "unlock") {
    return await cmdDocOverride(args, sub, id);
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
        // `via` says how the value was obtained *within* its source — `alias en (primary)`,
        // `pseudo-release <mbid>`. It answers the one question `source` cannot: why this tag
        // does not say what MusicBrainz's canonical name says.
        const via = held.via === undefined ? "" : ` · via ${held.via}`;
        line(
          `${entry.field.padEnd(28)} ${entry.vorbis.padEnd(26)} ${held.source.padEnd(13)} ${held.fetchedAt.slice(0, 19).padEnd(21)} ${held.locked ? "🔒 " : ""}${short(held.value)}${via}`,
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
    hint: "build, show, rebuild, set, lock or unlock. `mm doc fields` lists them with their scope.",
  });
}

/**
 * `mm doc set|lock|unlock` — the manual override, from a terminal.
 *
 * The same service the Console and the MCP tool call, so the three cannot disagree about what
 * an override means. The id says which scope: an `alb_…` is the album's, and an album-scope
 * field is written on every one of its tracks in one transaction (§2.7); anything else is a
 * library track, which refuses album-scope fields and names the album command instead.
 *
 * A multi-valued field takes several values on the command line: `mm doc set <id> genre house
 * electronic` is two `GENRE` tags, not one with a space in it.
 */
async function cmdDocOverride(
  args: Args,
  sub: "set" | "lock" | "unlock",
  id: string,
): Promise<number> {
  const fieldName = args.positional[3];
  if (fieldName === undefined) {
    throw new MMError(
      "INVALID_INPUT",
      `usage: mm doc ${sub} <id> <field>${sub === "set" ? " <value…>" : ""}`,
      {
        hint:
          "The field is the tag map's name (`album`), not the Vorbis key (`ALBUM`). " +
          "`mm doc fields` lists every field and whether it belongs to the album or to the track.",
      },
    );
  }

  const values = args.positional.slice(4);
  if (sub === "set" && values.length === 0) {
    throw new MMError("INVALID_INPUT", "`mm doc set` needs a value.", {
      hint: "`mm doc lock <id> <field>` pins what the sources already say.",
      action: "Lock it instead",
    });
  }

  const edits = [
    sub === "set"
      ? { field: fieldName, value: values.length === 1 ? (values[0] ?? "") : values }
      : { field: fieldName, value: null, locked: sub === "lock" },
  ];

  const album = isId("libraryAlbum", id);
  const result = album
    ? await overrideAlbumFields(id, edits, { setBy: "mm" })
    : await overrideTrackFields(id, edits, { setBy: "mm" });

  if (flagBoolean(args, "json")) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (result.changed.length === 0) {
    line(`nothing changed — ${fieldName} already held that value.`);
    return 0;
  }

  line(`${album ? "album" : "track"} ${id}`);
  for (const change of result.changed) {
    line(`  ${change.action.padEnd(9)} ${change.vorbis.padEnd(22)} ${short(change.before ?? "—")}`);
    line(
      `  ${"".padEnd(9)} ${"".padEnd(22)} → ${short(change.after ?? "—")} · ${String(change.tracks)} track(s)`,
    );
  }
  line(
    result.retagRunId === null
      ? "  re-tag     nothing in scope; the files are already what the database says"
      : `  re-tag     queued (run ${result.retagRunId})`,
  );
  for (const entry of result.skipped) line(`  skipped    ${entry.path} — ${entry.why}`);

  const moves = result.relocatePlan?.moves ?? [];
  if (moves.length > 0) {
    line("");
    line(
      `  ${String(moves.length)} file(s) now sit off the path template. NOTHING WAS MOVED: Navidrome`,
    );
    line(
      "  identifies a file by its path, so a move loses that track's play count and favourites.",
    );
    for (const move of moves.slice(0, 5)) line(`    ${move.from}\n      → ${move.to}`);
    line("  `mm relocate --album <id>` moves them once you have read the list.");
  }
  return 0;
}

/**
 * `mm sources` — which credentials are configured, without printing any of them.
 *
 * `mm sources refresh` is the manual trigger for `cron.refresh-sources`. The job had no way in
 * at all before: no route, no tool, no command, so the only ways to run it were to wait until
 * Monday at 5 a.m. or to restart the worker at the right minute.
 */
async function cmdSources(args: Args): Promise<number> {
  if (args.positional[1] === "refresh") {
    const settings = await loadSettings();
    const { enqueueSourceRefresh } = await import("#/server/services/queue.ts");
    const jobId = await enqueueSourceRefresh({ trigger: "cli" });
    line(
      jobId === null
        ? "the refresh could not be queued — is the database reachable?"
        : `queued ${jobId} on cron.refresh-sources`,
    );
    if (!settings.sourcesRefreshEnabled) {
      line("note: sourcesRefreshEnabled is off, so the worker will return without doing anything.");
      line("      mm settings set sourcesRefreshEnabled true");
    }
    return jobId === null ? 1 : 0;
  }
  if (args.positional[1] !== undefined) {
    throw new MMError("INVALID_INPUT", `Unknown sources subcommand "${args.positional[1]}".`, {
      hint: "usage: mm sources [refresh]",
    });
  }

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
    const { priority, queue } = await bumpImport(id);
    line(`priority ${String(priority)}`);
    // What happened on pg-boss, and not only in the row: `mm bump` used to print a number that
    // was true and changed nothing.
    line(`queue    ${queue.action}${queue.queue === null ? "" : ` on ${queue.queue}`}`);
    line(
      `         ${String(queue.messages)} message(s) for this import` +
        (queue.removed === 0 ? "" : `, ${String(queue.removed)} duplicate(s) removed`),
    );
  }
  await printJob(id);
  return 0;
}

/* ------------------------------------------------------------------ */
/* mm library — what is on disk (P07a)                                 */
/* ------------------------------------------------------------------ */

/**
 * `mm library …` — the same numbers the Console shows, on a terminal.
 *
 * It reads through `library.service` and `quality.service` rather than querying tables, so a
 * score printed here and a score drawn there can never be computed two different ways.
 */
async function cmdLibrary(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "albums";
  const profile = flagString(args, "profile");
  const scored = (quality: { score: number | null; byProfile: Record<string, number | null> }) =>
    profile === undefined ? quality.score : (quality.byProfile[profile] ?? null);

  if (sub === "albums" || sub === "quality") {
    const payload = await albumGrid(
      {
        ...(flagString(args, "filter") === undefined
          ? {}
          : { filter: flagString(args, "filter") as never }),
        ...(profile === undefined ? {} : { profile: profile as never }),
      },
      db(),
    );
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(payload, null, 2));
      return 0;
    }
    line(
      `${String(payload.stats.albums)} album(s) · ${String(payload.stats.tracks)} track(s) · metadata ${payload.stats.averageScore === null ? "—" : (payload.stats.averageScore * 100).toFixed(0) + "%"} on average`,
    );
    line(
      `schema v${String(payload.stats.currentSchema)}${payload.stats.schemaOverridden ? " (override in force)" : ""} · ${String(payload.stats.filesBehind)} file(s) behind, ${String(payload.stats.filesCurrent)} current`,
    );
    line("");
    line("SCORE  TRACKS  SCHEMA  ALBUM");
    for (const album of payload.albums) {
      const score = scored(album.quality);
      line(
        `${(score === null ? "  —" : `${(score * 100).toFixed(0).padStart(3)}%`).padEnd(6)} ${`${String(album.presentCount)}/${String(album.trackCount)}`.padStart(6)}  ${`v${String(album.quality.schemaVersion ?? 0)}${album.quality.filesBehind > 0 ? "!" : " "}`.padEnd(6)}  ${album.albumArtist} — ${album.title}  ${album.id}`,
      );
    }
    return 0;
  }

  if (sub === "tracks") {
    const payload = await trackList(
      {
        ...(flagString(args, "search") === undefined
          ? {}
          : { search: flagString(args, "search") as string }),
        ...(flagString(args, "filter") === undefined
          ? {}
          : { filter: flagString(args, "filter") as never }),
        limit: Number(flagString(args, "limit") ?? "50"),
      },
      db(),
    );
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(payload, null, 2));
      return 0;
    }
    line(`${String(payload.total)} track(s) match · schema v${String(payload.currentSchema)}`);
    for (const track of payload.tracks) {
      line(
        `${track.behind ? "!" : " "} ${track.score === null ? "  —" : `${(track.score * 100).toFixed(0).padStart(3)}%`}  ${track.path}`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const id = args.positional[2];
    if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm library show <album id>");
    const detail = await albumDetail(id, db());
    if (detail === null) throw new MMError("NOT_FOUND", `No album with id ${id}.`);
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(detail, null, 2));
      return 0;
    }
    line(`${detail.album.albumArtist} — ${detail.album.title}`);
    line(`  folder      ${detail.album.folder}`);
    line(`  release     ${detail.album.releaseMbid ?? "— (imported without MusicBrainz)"}`);
    line(
      `  tracks      ${String(detail.quality.presentCount)}/${String(detail.quality.trackCount)}  ·  schema v${String(detail.quality.schemaVersion ?? 0)} (current v${String(detail.currentSchema)})`,
    );
    line(
      `  metadata    ${detail.quality.score === null ? "—" : (detail.quality.score * 100).toFixed(0) + "%"}  ·  ${String(detail.quality.missing.length)} missing, ${String(detail.quality.naCount)} n/a, ${String(detail.quality.driftCount)} drifting`,
    );
    line("");
    for (const entry of detail.quality.missing.slice(0, 30)) {
      line(
        `  ${entry.level.padEnd(12)} ${entry.vorbis.padEnd(28)} ${String(entry.tracks)} track(s)   ${entry.action}`,
      );
    }
    return 0;
  }

  /*
   * `mm library missing <album id>` — which tracks of the release this album has not got.
   *
   * The half of `mm library show` that was never there. `show` prints `16/20` and then lists
   * the *tag* fields that are missing, which is a different question entirely; this one names
   * the four recordings. Offline, against the release already in the raw cache, so it costs
   * nothing to run it over every incomplete album `mm library albums --filter incomplete`
   * reports.
   */
  if (sub === "missing") {
    const id = args.positional[2];
    if (id === undefined) {
      throw new MMError("INVALID_INPUT", "usage: mm library missing <album id> [--json]");
    }
    const found = await albumMissingTracks(id, { db: db() });
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(found, null, 2));
      return 0;
    }
    line(
      `${String(found.presentCount)}/${String(found.trackCount)} track(s) present · release ${found.releaseMbid ?? "—"}`,
    );
    if (found.unavailable !== null) {
      line("");
      // Said rather than left as an empty list: "nothing printed" and "nothing is missing"
      // look identical on a terminal, and only one of them is good news.
      line(
        found.unavailable === "no-release"
          ? "  This album has no MusicBrainz release, so there is no tracklist to compare it against."
          : "  The release is not in the local cache, so its tracklist cannot be read offline.",
      );
      line(
        found.unavailable === "no-release"
          ? "  Re-import it against a release to give it one."
          : "  Run `mm library refresh <album id>` once; everything after that is offline.",
      );
      return 0;
    }
    if (found.missing.length === 0) {
      line("");
      line("  Every track of the release is accounted for.");
      return 0;
    }
    line("");
    // The disc column only when there is more than one, so the ordinary album is not made to
    // look like a box set. The couple is still what `mm library adopt` is given.
    const multi = found.mediumCount > 1;
    line(`${multi ? "DISC  " : ""}  #  TITLE                          ARTIST`);
    for (const track of found.missing) {
      line(
        `${multi ? `${String(track.mediumPosition).padStart(4)}  ` : ""}${String(track.trackPosition).padStart(3)}  ${track.title.slice(0, 30).padEnd(30)} ${track.artist ?? ""}`,
      );
    }
    line("");
    line(
      multi
        ? "  mm library adopt <album id> <disc> <position> --file <path>   to fill one"
        : "  mm library adopt <album id> 1 <position> --file <path>   to fill one",
    );
    return 0;
  }

  /*
   * `mm library adopt <album id> <disc> <position> --file <path>|--from-url <address>`.
   *
   * Both numbers, always, and the disc is not optional even on a single-disc record: a command
   * that took one number would be a command whose meaning changed when a release turned out to
   * have two discs, and the one thing this feature must never do is address the wrong track.
   *
   * `--file` is a path *on this server* and `--url` an address to fetch — the same two the CLI
   * offers for `mm adopt`, plus the address, because the whole point of the missing-track case
   * is that there is no local file half the time.
   */
  if (sub === "adopt") {
    const id = args.positional[2];
    const medium = Number(args.positional[3]);
    const position = Number(args.positional[4]);
    const file = flagString(args, "file");
    const from = flagString(args, "from-url");
    if (
      id === undefined ||
      !Number.isInteger(medium) ||
      !Number.isInteger(position) ||
      (file === undefined) === (from === undefined)
    ) {
      throw new MMError(
        "INVALID_INPUT",
        "usage: mm library adopt <album id> <disc> <position> --file <path on this server>\n" +
          "       mm library adopt <album id> <disc> <position> --from-url <address>",
        {
          hint: "Both numbers, always: `mm library missing <album id>` prints the couple to give. The disc is 1 on a single-disc release.",
        },
      );
    }

    const result = await adoptLibraryTrack({
      albumId: id,
      mediumPosition: medium,
      trackPosition: position,
      source: file === undefined ? { kind: "url", url: from ?? "" } : { kind: "path", path: file },
      adoptedBy: "cli library adopt",
      db: db(),
    });
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(result, null, 2));
      return 0;
    }
    line(`adopted ${result.originalName} for “${result.trackTitle}”`);
    line(`  slot     disc ${String(result.mediumPosition)}, track ${String(result.trackPosition)}`);
    line(`  file     ${result.path}`);
    line(
      `  audio    ${result.codec ?? "?"}` +
        (result.durationSeconds === null
          ? ""
          : `, ${String(Math.round(result.durationSeconds))} s`) +
        `, ${String(Math.round(result.bytes / 1024))} KiB`,
    );
    if (result.materialised) {
      line("  row      created with no source: the album's playlist never published this track");
    }
    line(`  next     ${result.nextStep ?? "nothing left"}${result.queued ? " (queued)" : ""}`);
    line("");
    line(
      `The album says ${String(result.counters.presentCount)}/${String(result.counters.trackCount)} until \`place\` files this one — run \`bun run worker\` if nothing is.`,
    );
    return 0;
  }

  if (sub === "artists") {
    for (const artist of await artistList({}, db())) {
      line(
        `${artist.name.padEnd(36)} ${String(artist.albums).padStart(3)} album(s)  ${String(artist.tracks).padStart(4)} track(s)  ${artist.mbid ?? ""}`,
      );
    }
    return 0;
  }

  /*
   * The repair of the orphan half of the scan report.
   *
   * It lives under `mm library` rather than under `mm scan` because it is not a finding, it is
   * a *write*: the scan says "these files have no row", and this is the one command that puts
   * the rows back. `--apply` is the second ask; without it nothing is written.
   */
  if (sub === "repair-orphans") return await cmdRepairOrphans(args);

  throw new MMError(
    "INVALID_INPUT",
    "usage: mm library albums|tracks|artists|show <id>|missing <id>|adopt <id> <disc> <pos>|repair-orphans [--apply]",
  );
}

/* ------------------------------------------------------------------ */
/* mm retag — the background re-projection of docs/03 §8 (P07a)        */
/* ------------------------------------------------------------------ */

/**
 * `mm retag …`
 *
 * Unlike `mm import`, this runs **in this process** by default, and that is not an
 * inconsistency: the reason the CLI refuses to run a pipeline is the single global download
 * slot, and a re-tag downloads nothing. It reads the raw cache, projects, and writes tag
 * blocks. `--queue` hands it to the worker instead, which is what the Console does.
 */
async function cmdRetag(args: Args): Promise<number> {
  const sub = args.positional[1] ?? "run";

  if (sub === "runs") {
    for (const run of await listRuns({ limit: Number(flagString(args, "limit") ?? "20") }, db())) {
      line(
        `${run.id}  ${run.status.padEnd(10)} ${run.dryRun ? "dry " : "    "} ${run.scope.padEnd(8)} v${String(run.schemaVersion)}  ${String(run.done)}/${String(run.total)} done, ${String(run.changed)} changed, ${String(run.failed)} failed`,
      );
    }
    return 0;
  }

  if (sub === "show") {
    const id = args.positional[2];
    if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm retag show <run id>");
    const view = await runView(id, {}, db());
    if (view === null) throw new MMError("NOT_FOUND", `No re-tag run with id ${id}.`);
    if (flagBoolean(args, "json")) {
      line(JSON.stringify(view, null, 2));
      return 0;
    }
    line(
      `${view.run.id} · ${view.run.status} · ${view.run.dryRun ? "dry run" : "wrote files"} · projection v${String(view.run.schemaVersion)}`,
    );
    line(
      `${String(view.run.done)}/${String(view.run.total)} file(s), ${String(view.run.changed)} changed, ${String(view.run.failed)} failed`,
    );
    for (const diff of view.diffs) {
      const counts = `+${String(diff.added.length)} ~${String(diff.changed.length)} -${String(diff.removed.length)}`;
      line("");
      line(
        `  ${diff.path}   ${counts}${diff.error === null ? "" : `   ERROR ${diff.error.message}`}`,
      );
      for (const entry of diff.added) line(`    + ${entry.key}=${entry.after ?? ""}`);
      for (const entry of diff.changed) {
        line(`    ~ ${entry.key}: ${entry.before ?? ""} -> ${entry.after ?? ""}`);
      }
      for (const entry of diff.removed) line(`    - ${entry.key}=${entry.before ?? ""}`);
    }
    return 0;
  }

  if (sub === "cancel") {
    const id = args.positional[2];
    if (id === undefined) throw new MMError("INVALID_INPUT", "usage: mm retag cancel <run id>");
    const run = await cancelRun(id, db());
    line(run === null ? "Nothing to cancel; that run is not in flight." : `Cancelled ${run.id}.`);
    return 0;
  }

  /* ---- run ---- */
  const album = flagString(args, "album");
  const track = flagString(args, "track");
  const scope = track !== undefined ? "track" : album !== undefined ? "album" : "library";
  const dryRun = flagBoolean(args, "dry-run");
  /*
   * Three selections, and the default is still the old one so no script changes meaning.
   *
   * `--adrift` is the repair for a library that already diverged: it selects the files whose
   * tags disagree with the database rather than the files written by an older *projection
   * version*, which is all the default has ever been able to see. Without it a re-matched album
   * was unreachable from here — `mm retag --album …` answered "nothing to do" on twelve files
   * that plainly carried the previous edition's ids.
   */
  const selection = flagBoolean(args, "adrift")
    ? "adrift"
    : flagBoolean(args, "all")
      ? "all"
      : "behind";

  const run = await createRun({
    db: db(),
    scope,
    targetId: track ?? album ?? null,
    dryRun,
    selection,
    trigger: "manual",
  });

  line(
    `${dryRun ? "Dry run" : "Re-tag"} ${run.id}: ${String(run.total)} file(s) to projection v${String(run.schemaVersion)} (selection: ${selection}).`,
  );
  if (run.total === 0) {
    line(`Nothing to do — ${emptyReason(selection)}`);
    return 0;
  }

  if (flagBoolean(args, "queue")) {
    const boss = createBoss({ producer: true });
    await boss.start();
    await enqueueRetag(boss, { runId: run.id });
    await stopBoss(boss);
    line("Queued for the worker.");
    return 0;
  }

  const finished = await runToCompletion(run.id, { db: db() });
  line(
    `${finished.status}: ${String(finished.done)}/${String(finished.total)} file(s), ${String(finished.changed)} changed, ${String(finished.failed)} failed.`,
  );
  /*
   * The line above is a count, and a count of zero is not an answer. A run that planned files
   * and then selected none of them used to stop right there — `done: 0/1 file(s), 0 changed, 0
   * failed`, which reads as "it worked" on the one command whose argument was a file the scan
   * had just reported drifted. `emptyRunNote` says which question was asked instead.
   */
  const note = emptyRunNote(finished);
  if (note !== null) line(note);
  if (dryRun) line(`Read the diff with:  mm retag show ${finished.id}`);
  return finished.failed > 0 ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* mm relocate — re-file against the path template (decision 074)      */
/* ------------------------------------------------------------------ */

/**
 * `mm relocate [--album <id>] [--apply] [--json]`
 *
 * Dry by default, and loudly. `retag` re-projects the tags of a file; nothing re-projected its
 * *path*, so a library that predates a `pathTemplate` change keeps its old names for ever.
 * `--apply` is the only thing that moves a byte, and the warning above it is the one from the
 * v1 migration: Navidrome identifies a file by its path, so a move costs that track its play
 * count and its favourites.
 */
async function cmdRelocate(args: Args): Promise<number> {
  const album = flagString(args, "album");
  const apply = flagBoolean(args, "apply");
  const report = await relocate({
    db: db(),
    dryRun: !apply,
    ...(album === undefined ? {} : { albumId: album }),
  });

  if (flagBoolean(args, "json")) {
    line(JSON.stringify(report, null, 2));
    return report.failed > 0 ? 1 : 0;
  }

  line(`Template: ${report.template}`);
  line(
    `${String(report.scanned)} file(s) scanned, ${String(report.inPlace)} already in place, ${String(report.planned)} off-template.`,
  );
  for (const move of report.moves) line(`  ${move.from}\n    -> ${move.to}`);
  if (report.planned > report.moves.length) {
    line(`  … and ${String(report.planned - report.moves.length)} more.`);
  }
  for (const entry of report.blocked) line(`  blocked (${entry.reason}): ${entry.path}`);
  for (const failure of report.errors) {
    line(`  failed: ${failure.path} — ${failure.code}: ${failure.message}`);
  }

  if (!apply) {
    if (report.planned > 0) {
      line("");
      line("Nothing was moved. Navidrome identifies a file by its path, so applying this loses");
      line("the play count and the favourites of every track it moves.");
      line("Apply it with:  mm relocate --apply");
    }
    return 0;
  }

  line(
    `Moved ${String(report.moved)}, skipped ${String(report.skipped)}, failed ${String(report.failed)}.`,
  );
  if (report.rescan !== null) {
    line(
      report.rescan.error === null
        ? "Navidrome was asked to rescan."
        : `Navidrome could not be asked to rescan: ${report.rescan.error}`,
    );
  }
  return report.failed > 0 ? 1 : 0;
}

const USAGE = `mm — Music Manager

  mm import <url|fixture://…> [--release <mbid>] [--mapping <file.json>] [--yes] [--force] [--follow]
                                          --untagged builds the album from the source's own
                                          tags when MusicBrainz has nothing, instead of
                                          parking it in the review queue: no identifiers, the
                                          album flagged 'untagged' in the library. Off by
                                          default for a URL, and worth saying for a record
                                          MusicBrainz has never published.
  mm import <folder> [--release <mbid>] [--yes] [--follow]
                                          an absolute folder of audio files: each file is an
                                          entry, matched like a video, then adopted rather than
                                          downloaded. Must be inside adoptSourceRoots.
                                          --untagged is already the default here, because the
                                          files carry real tags; --no-untagged asks instead.
  mm import --from-file <path> [--yes] [--force] [--untagged|--no-untagged]
                                          one source per line (URL or folder),
                                          '#' comments; queued, not resolved
  mm confirm-best <id> [--min-coverage 0.8] [--min-margin 0.04] [--prefer album|any]
                                          confirm the engine's best candidate: an album on
                                          coverage, a single on its margin over the runner-up
  mm match <url|fixture://…> [--kind album|single] [--json]   score candidates without importing
  mm jobs
  mm jobs collapse [--url <url>] [--apply] [--json]
                                          cancel the redundant imports parked at the wizard for
                                          a URL, keeping the newest; never touches one whose
                                          tracks have done any work. Dry run unless --apply
  mm job <id> [--follow]
  mm retry <id> --step <${STEP_ORDER.join("|")}>
  mm retry --failed-upstream [--dry-run] [--limit N]   every import a source killed, at once
  mm retry --failed-step <step> [--dry-run] [--limit N]   every import that died on one
                                          step: --failed-step resolve re-reads every
                                          source that would not read
  mm adopt <id> <track id> --file <path>   give one track a file you already have
                                          (deleted video, age check, an existing library)
  mm adopt <id> <track id> --from-url <address>   download this track from another upload
                                          of the same song; the original stays its declared
                                          source. Spends the single download slot.
                                          NB: --from-url, never --url. --url is the global
                                          flag that points mm at ANOTHER INSTALLATION (see
                                          Remote below) and is read before the command name,
                                          so "adopt --url ..." never reaches this command.
  mm inbox list [--all]
  mm inbox resolve <id> --accept [--follow]
  mm inbox resolve <id> --untagged        on a card MusicBrainz found nothing for: build the
                                          album from the source's own tags and run match
                                          again. The album is flagged 'untagged'.
  mm inbox resolve --all --accept [--import <id>]
  mm settings get [key] | set <key> <value> | list
  mm pause <id> | mm cancel <id> | mm bump <id>

  mm doc build <import_track_id|library_track_id> [--offline] [--refresh]
  mm doc show <id> [--missing] [--json]
  mm doc rebuild <id> [--offline]        offline by default; exits 1 if anything left the machine
  mm doc set <ltr_…|alb_…> <field> <value…>   type a value by hand and lock it (source: console)
  mm doc lock <id> <field>               pin what the sources say; no rebuild can change it
  mm doc unlock <id> <field>             remove it and re-resolve offline: the sources own it again
  mm sources                             which credentials are set, and every source's TTL
  mm sources refresh                     run cron.refresh-sources now, on the worker

  mm verify <album> [--rescan] [--json]  read one album back through Navidrome, field by field
  mm verify --all [--json]               the whole library, with one scan for all of it
  mm scan [run|last] [--drift-limit N]   walk the library: orphans, missing, drift, duplicates
  mm scan identify <path> | trash <path>  fingerprint an orphan, or move a file to the trash
  mm tools [status|update|selftest]       the downloader, the cookies and the sources
  mm tools url <url> | mm tools errors    a dry-run extract, and the error decoder

  mm discover sync                       recompute the recommendations from your listening
  mm discover list [--json] [--limit n]   the three blocks: gaps, recommendations, similar artists
  mm discover forget                      un-hide everything you marked "not interested"

  mm watch add <url> [--label x] [--auto-accept] [--min-duration s] [--max-duration s]
                                          watch a playlist or channel; new videos become imports
  mm watch list [--json]                  every watched source, with its counts
  mm watch show <id> [--json]             one source: its policy and every video it has seen
  mm watch scan [id] [--queue] [--json]   scan now, in this process — or hand it to the worker
  mm watch remove <id>                    stop watching; the imports it opened are kept

  mm library albums [--filter <f>] [--profile <p>] [--json]   what is on disk, scored
  mm library tracks [--search s] [--filter f] [--limit n]     every file, one line each
  mm library show <album id> [--json]     one album: identifiers, score, what is missing
  mm library artists                      grouped as the folders name them
  mm library missing <album id> [--json]  which tracks of the release this album has not
                                          got — offline, the four lines behind "16/20"
  mm library adopt <album id> <disc> <position> --file <path> | --from-url <address>
                                          fill one of them: downloads or copies, tags and
                                          files that track alone
  mm library repair-orphans [--apply] [--limit n] [--json]
                                          re-attach library files that have no row, from their
                                          own MUSICBRAINZ_* tags; dry run unless --apply
  mm retag [--album <id>|--track <id>] [--dry-run] [--adrift|--all] [--queue]
                                          re-project from the raw cache; offline, no re-download
                                          default selects files behind the schema *version*;
                                          --adrift selects files whose tags disagree with the
                                          database; --all selects everything in scope
  mm retag runs | show <run id> | cancel <run id>             the runs, and the per-file diffs
  mm relocate [--album <id>] [--apply] [--json]               re-file against pathTemplate; dry by default

  mm migrate v1 --db <postgres url> --library <dir> [--dry-run] [--rename-to-template]
                [--limit N] [--no-resume] [--i-have-a-backup] [--verify] [--json]
                                          take over a v1 library and database (P11)
  mm migrate runs | show <run id>          past migrations, and their reports

Remote (P08): --url http://host:3000 --token mm_…   drive another installation over /api/v1.
  Also read from MM_URL / MM_TOKEN, or ~/.config/mm/config.toml. \`mm --url … help\` lists the
  remote verbs; \`match\`, \`doc\` and \`sources\` are in-process only.

Environment: DATABASE_URL, MM_TOOLBOX_URL, MM_FIXTURES, MM_LIBRARY_ROOT, MM_TOOLBOX_LIBRARY_ROOT,
             MM_MB_CONTACT, MM_ACOUSTID_KEY, MM_LASTFM_KEY, MM_FANARTTV_KEY, MM_URL, MM_TOKEN.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args.positional[0];

  switch (command) {
    case "import":
      return await cmdImport(args);
    case "confirm-best":
      return await cmdConfirmBest(args);
    case "match":
      return await cmdMatch(args);
    case "jobs":
      return await cmdJobs(args);
    case "job":
      return await cmdJob(args);
    case "retry":
      return await cmdRetry(args);
    case "adopt":
      return await cmdAdopt(args);
    case "inbox":
      return await cmdInbox(args);
    case "settings":
      return await cmdSettings(args);
    case "doc":
      return await cmdDoc(args);
    case "sources":
      return await cmdSources(args);
    case "verify":
      return await cmdVerify(args);
    case "scan":
      return await cmdScan(args);
    case "tools":
      return await cmdTools(args);
    case "discover":
      return await cmdDiscover(args);
    case "watch":
      return await cmdWatch(args);
    case "library":
      return await cmdLibrary(args);
    case "migrate":
      return await cmdMigrate(args);
    case "retag":
      return await cmdRetag(args);
    case "relocate":
      return await cmdRelocate(args);
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

/**
 * Remote mode (P08), decided before anything local is touched.
 *
 * `mm --url … --token …` drives another installation over `/api/v1`. The two modules it needs
 * are pulled in **dynamically and only here**, because they are the only part of this CLI that
 * is allowed to run on a machine with no database: a static import would be harmless today and
 * would break the moment somebody adds a module-level `serverEnv()` to something they pull in.
 *
 * A `RemoteError` is printed in the same shape as a local `MMError`, so the two modes fail
 * identically — which is the whole claim being made by "the same commands".
 */
async function maybeRemote(): Promise<number | null> {
  const args = parseArgs(process.argv.slice(2));
  const { resolveRemote } = await import("./remote.ts");
  const config = resolveRemote(args.flags);
  if (config === null) return null;

  const { ApiClient, RemoteError } = await import("./remote.ts");
  const { runRemote } = await import("./remote-commands.ts");
  try {
    return await runRemote(new ApiClient(config), args);
  } catch (error) {
    if (error instanceof RemoteError) {
      console.error(`\n${error.code}: ${error.message}`);
      if (error.hint !== undefined) console.error(`hint: ${error.hint}`);
      if (error.action !== undefined) console.error(`try : ${error.action}`);
      return 1;
    }
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

try {
  const remote = await maybeRemote();
  process.exit(remote ?? (await main()));
} catch (error) {
  fail(error);
}
