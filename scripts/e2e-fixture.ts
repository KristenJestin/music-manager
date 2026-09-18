/**
 * `bun run e2e-fixture` — the whole vertical slice, offline, automated.
 *
 * This is the acceptance test of P03 and the regression net for every phase after it. It runs
 * the real worker, the real CLI and the real toolbox container; nothing is stubbed and nothing
 * reaches the network. Five scenarios, in one pass over one library:
 *
 *  1. **resume**       — the worker is killed mid-download and restarted. The job carries on
 *                        and nothing already on disk is fetched twice; an import the *worker*
 *                        had paused is picked back up, and one the *owner* paused is not.
 *  2. **the album**    — fourteen `.opus` files with the right names, a `.lrc` sidecar, a
 *                        `cover.jpg`, and one file probed through the toolbox to prove the
 *                        tags really are in it.
 *  3. **idempotence**  — the same import again: zero downloads, `already present`.
 *  4. **a gap**        — `?gap=14` makes one entry of the listing unreadable. The import still
 *                        finishes, is still an album, and says "14 of 15 entries" in the
 *                        journal and on the row instead of failing on the one it lost.
 *  5. **fingerprint**  — `?fp=mismatch` parks the job in `awaiting_review` with Inbox items,
 *                        and `mm inbox resolve --accept` lets it finish.
 *
 * The SSE endpoint is curled during a run, because a job you cannot watch is half a feature.
 *
 * It is deliberately written against the *outside* of the app: SQL for assertions, HTTP for
 * the toolbox, the `mm` binary for everything else. If this passes, the product works — not
 * merely the code.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  bun,
  capture,
  createFreshDatabase,
  dockerIsRunning,
  dropDatabaseIfExists,
  findFreePort,
  repoRoot,
  resolveDocker,
  withDatabaseName,
} from "./lib.ts";
import { describeStack, e2eStack, RUN_TAG } from "./e2e-checkout.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

/** Which checkout is this, and therefore which postgres, which toolbox, which `-p`. */
const STACK = e2eStack();
const ADMIN_DATABASE_URL = STACK.adminDatabaseUrl;
/**
 * A database of its own, per process, rather than resetting whatever `DATABASE_URL` already
 * pointed at — which was the developer's or another agent's real `mm` database by default.
 * `MM_E2E_DB` pins a name for a caller that wants a stable one.
 */
const TEST_DB = process.env["MM_E2E_DB"] ?? `mm_e2e_fixture_${RUN_TAG}`;
const DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, TEST_DB);
const TOOLBOX_URL = STACK.toolboxUrl;
/**
 * Never `:3000` by default: a script that silently reused whatever answered there once mistook
 * an unrelated app for itself and reported zero SSE frames with no error
 * (`orchestration/reports/P07a-build-1.md` §6, "l'environnement"). A free port picked by the OS
 * cannot collide with something else already running, on `:3000` or otherwise.
 */
const WEB_PORT = process.env["MM_WEB_PORT"]
  ? Number.parseInt(process.env["MM_WEB_PORT"], 10)
  : await findFreePort();
const WEB_URL = process.env["MM_WEB_URL"] ?? `http://localhost:${String(WEB_PORT)}`;
/**
 * A library directory of its own, per process, under the same bind mount the toolbox and
 * Navidrome already see — so two runs (or a run and a developer's own `bun run dev`) never
 * write into the same album folder or fight over `.mm-work`.
 */
const LIBRARY_SUBDIR = process.env["MM_E2E_LIBRARY_SUBDIR"] ?? `.mm-e2e-fixture-${RUN_TAG}`;
const LIBRARY = resolve(repoRoot, ".local/library", LIBRARY_SUBDIR);
const TOOLBOX_LIBRARY_ROOT = `/library/${LIBRARY_SUBDIR}`;
/**
 * Always with `-p`, and never `postgres` from a worktree. `e2eStack()` says why at length;
 * the short version is that `docker compose -f docker-compose.dev.yml …` without a project
 * addresses the **shared** `mm-dev` containers by name, wherever it is run from.
 */
const COMPOSE = STACK.compose;

/** Slice pace of the fixture download. Slow enough to interrupt, fast enough to finish. */
const SLOW_MS = "400";
const FAST_MS = "20";

/** The fourteen names `packages/domain/paths` must produce for Discovery. */
const EXPECTED_FILES = [
  "01 - One More Time.opus",
  "02 - Aerodynamic.opus",
  "03 - Digital Love.opus",
  "04 - Harder, Better, Faster, Stronger.opus",
  "05 - Crescendolls.opus",
  "06 - Nightvision.opus",
  "07 - Superheroes.opus",
  "08 - High Life.opus",
  "09 - Something About Us.opus",
  "10 - Voyager.opus",
  "11 - Veridis Quo.opus",
  "12 - Short Circuit.opus",
  "13 - Face to Face.opus",
  "14 - Too Long.opus",
] as const;

const ALBUM_DIR = join(LIBRARY, "Daft Punk", "Discovery (2001)");

const childEnv: Record<string, string> = {
  ...STACK.env,
  DATABASE_URL,
  MM_TOOLBOX_URL: TOOLBOX_URL,
  MM_FIXTURES: "1",
  MM_LIBRARY_ROOT: LIBRARY,
  MM_TOOLBOX_LIBRARY_ROOT: TOOLBOX_LIBRARY_ROOT,
};

/* ------------------------------------------------------------------ */
/* reporting                                                           */
/* ------------------------------------------------------------------ */

let failures = 0;
let checks = 0;

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

function check(ok: boolean, what: string, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `  ${detail}`}`);
}

function info(message: string): void {
  console.log(`  ..   ${message}`);
}

function die(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* processes                                                           */
/* ------------------------------------------------------------------ */

type Child = ReturnType<typeof Bun.spawn>;

const running: Child[] = [];

function spawnChild(cmd: string[], label: string, cwd = repoRoot): Child {
  const log = Bun.file(join(repoRoot, ".local", `e2e-${label}.log`)).writer();
  const child = Bun.spawn(cmd, {
    cwd,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  void pump(child.stdout, log);
  void pump(child.stderr, log);
  running.push(child);
  return child;
}

async function pump(
  stream: ReadableStream<Uint8Array> | undefined,
  writer: { write(chunk: Uint8Array): unknown; flush(): unknown },
): Promise<void> {
  if (stream === undefined) return;
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    writer.write(chunk);
    writer.flush();
  }
}

async function stopChild(child: Child, signal: NodeJS.Signals | number = "SIGTERM"): Promise<void> {
  if (child.killed) return;
  child.kill(signal as number);
  await child.exited;
  const index = running.indexOf(child);
  if (index !== -1) running.splice(index, 1);
}

async function stopEverything(): Promise<void> {
  for (const child of [...running]) await stopChild(child, 9);
}

/** Run `mm …` and return its output. */
async function mm(...args: string[]): Promise<string> {
  const result = await capture({
    label: `mm ${args[0] ?? ""}`,
    cmd: [bun, "run", "apps/web/bin/mm.ts", ...args],
    env: childEnv,
  });
  if (result.code !== 0) {
    console.log(result.stdout);
    console.error(result.stderr);
    die(`mm ${args.join(" ")} exited ${String(result.code)}`);
  }
  return result.stdout;
}

/* ------------------------------------------------------------------ */
/* database helpers                                                    */
/* ------------------------------------------------------------------ */

// Bun's built-in Postgres client: the assertions are made from *outside* the app, with no
// dependency on its Drizzle schema objects. If a query here still works, the schema is real.
const sql = new SQL({ url: DATABASE_URL, max: 2 });

interface JobRow {
  id: string;
  status: string;
  step: string;
}

async function job(importId: string): Promise<JobRow> {
  const rows = await sql<JobRow[]>`
    select id, status::text as status, step::text as step from imports where id = ${importId}`;
  const row = rows[0];
  if (row === undefined) die(`no import ${importId}`);
  return row;
}

/** Wait until `predicate` holds for the job, or give up. */
async function waitFor(
  importId: string,
  predicate: (row: JobRow) => boolean,
  what: string,
  timeoutMs = 180_000,
): Promise<JobRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await job(importId);
    if (predicate(row)) return row;
    if (Date.now() > deadline) {
      die(
        `timed out after ${String(timeoutMs / 1000)}s waiting for ${what} (status ${row.status}, step ${row.step})`,
      );
    }
    await Bun.sleep(500);
  }
}

async function countDownloadedTracks(importId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from job_events
     where import_id = ${importId} and step = 'download' and type = 'track.done'`;
  return Number(rows[0]?.n ?? "0");
}

async function stepRow(
  importId: string,
  step: string,
): Promise<{ status: string; message: string }> {
  const rows = await sql<{ status: string; message: string }[]>`
    select status::text as status, coalesce(message, '') as message
      from job_steps where import_id = ${importId} and step = ${step}::step_name`;
  return rows[0] ?? { status: "missing", message: "" };
}

/** The id of the newest import. `mm import` prints it, but SQL is unambiguous. */
/** Wait for a queued re-tag run to leave `pending`/`running`, and say where it landed. */
async function waitForRetagRun(runId: string, timeoutMs = 60_000): Promise<string> {
  if (runId === "") return "no run id";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql<{ status: string }[]>`
      select status::text as status from retag_runs where id = ${runId} limit 1`;
    const status = rows[0]?.status ?? "missing";
    if (status !== "pending" && status !== "running") return status;
    if (Date.now() > deadline) return `still ${status} after ${String(timeoutMs)} ms`;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function latestImport(): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from imports order by created_at desc limit 1`;
  const id = rows[0]?.id;
  if (id === undefined) die("no import was created");
  return id;
}

/* ------------------------------------------------------------------ */
/* toolbox                                                             */
/* ------------------------------------------------------------------ */

async function toolboxReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${TOOLBOX_URL}/health`, {
        signal: AbortSignal.timeout(4000),
      });
      const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
      if (body.ok === true) {
        if (body.fixtures !== true) die("the toolbox is up but not in fixtures mode");
        return;
      }
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) die("the toolbox never became healthy");
    await Bun.sleep(1000);
  }
}

async function recreateToolbox(delayMs: string): Promise<void> {
  const docker = resolveDocker();
  if (docker === null) die("docker not found");
  const result = await capture({
    label: "compose up toolbox",
    cmd: [docker, ...COMPOSE, "up", "-d", ...STACK.services("toolbox")],
    env: { ...childEnv, ...STACK.composeEnv, MM_TOOLBOX_FIXTURE_DELAY_MS: delayMs },
  });
  if (result.code !== 0) die(`compose up toolbox failed:\n${result.stderr}`);
  await toolboxReady();
}

/**
 * `POST /tag` on a library file, addressed as the container sees it — **behind the app's back**.
 *
 * `clear: false`, so exactly one key moves and everything else in the block stays as the app
 * wrote it. That is the sabotage §10 needs: it is what a person with a tag editor does, and it
 * is the one kind of divergence no amount of comparing rows against rows can see.
 */
async function writeTag(relative: string, key: string, value: string): Promise<void> {
  const response = await fetch(`${TOOLBOX_URL}/tag`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: `${TOOLBOX_LIBRARY_ROOT}/${relative}`,
      tags: [{ key, value }],
      clear: false,
      sidecar_lrc: false,
    }),
  });
  if (!response.ok) die(`toolbox /tag failed: HTTP ${String(response.status)} for ${relative}`);
}

/** `POST /probe` on a library file, addressed as the container sees it. */
async function probe(relative: string): Promise<{ tags: Record<string, string>; codec: string }> {
  const response = await fetch(`${TOOLBOX_URL}/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${TOOLBOX_LIBRARY_ROOT}/${relative}` }),
  });
  if (!response.ok) die(`probe failed: HTTP ${String(response.status)}`);
  return (await response.json()) as { tags: Record<string, string>; codec: string };
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  section("preflight");
  info(describeStack(STACK));
  if (!(await dockerIsRunning())) die("The Docker daemon is not answering. Start Docker Desktop.");
  const docker = resolveDocker();
  if (docker === null) die("docker not found");

  const up = await capture({
    label: "compose up",
    cmd: [docker, ...COMPOSE, "up", "-d", ...STACK.services("postgres", "toolbox")],
    env: { ...childEnv, ...STACK.composeEnv, MM_TOOLBOX_FIXTURE_DELAY_MS: FAST_MS },
  });
  if (up.code !== 0) die(`compose up failed:\n${up.stderr}`);
  await toolboxReady();
  info(`toolbox healthy at ${TOOLBOX_URL}, fixtures mode on`);

  info(`creating ${TEST_DB}`);
  await createFreshDatabase(ADMIN_DATABASE_URL, TEST_DB);
  const migrate = await capture({
    label: "db migrate",
    cmd: [bun, "run", join("apps", "web", "src", "server", "db", "migrate.ts")],
    env: childEnv,
  });
  if (migrate.code !== 0) die(`db migrate failed:\n${migrate.stdout}${migrate.stderr}`);
  info("database created and migrated");

  // P04: fixtures mode is no longer a branch in the code, it is a pre-filled raw cache. The
  // recorded source responses are written into `source_cache` under the keys the real clients
  // use, so `tag` takes the ordinary production path with the network unplugged. Seeding must
  // happen after the reset, which is why it lives here and not only in the acceptance script.
  const seeded = await capture({
    label: "seed fixtures",
    cmd: [bun, "run", "apps/web/src/server/integrations/seed-fixtures.ts"],
    env: childEnv,
  });
  if (seeded.code !== 0) die(`cache:seed-fixtures failed:\n${seeded.stdout}${seeded.stderr}`);
  info(seeded.stdout.trim());

  rmSync(LIBRARY, { recursive: true, force: true });
  mkdirSync(LIBRARY, { recursive: true });
  info(`library emptied: ${LIBRARY}`);

  /* ---------------------------------------------------------------- */
  section("1 · resume: kill the worker mid-download");
  /* ---------------------------------------------------------------- */

  await recreateToolbox(SLOW_MS);
  info(`fixture download paced at ${SLOW_MS} ms per slice`);

  let worker = spawnChild([bun, "run", "apps/web/src/worker/index.ts"], "worker");
  await Bun.sleep(4000);

  await mm("import", "fixture://discovery", "--yes");
  const first = await latestImport();
  info(`import ${first}`);

  // Wait until a few tracks are really on disk, then pull the plug.
  const deadline = Date.now() + 120_000;
  let before = 0;
  for (;;) {
    before = await countDownloadedTracks(first);
    if (before >= 3) break;
    if (Date.now() > deadline) die("no track finished downloading in two minutes");
    await Bun.sleep(500);
  }
  info(`${String(before)} track(s) downloaded; killing the worker`);
  await stopChild(worker, 9);

  /*
   * Two pauses the restart has to tell apart.
   *
   * Both are created now, with no worker running, so nothing can move them before the sweep
   * does. `mm pause` is the owner's Pause, through the real CLI, and it must survive the
   * restart untouched — a deploy is not permission to restart a job somebody stopped.
   *
   * The worker's own pause is written here rather than elicited, and that is deliberate: a
   * clean shutdown produces it (`runImport` pauses on the abort signal, as `SIGTERM` makes it
   * do), but a child process spawned from this script cannot be sent a *catchable* `SIGTERM`
   * on Windows — the platform terminates it instead — so eliciting it would make this test
   * pass on one operating system and hang on another. The row is the whole of what a shutdown
   * leaves behind, and it is the row the restarted worker is being asked about.
   */
  await mm("import", "fixture://skinny-love", "--yes");
  const shutdownPaused = await latestImport();
  await sql`update imports
               set status = 'paused', paused_by = 'worker', updated_at = now()
             where id = ${shutdownPaused}`;

  await mm("import", "fixture://skinny-love", "--yes");
  const ownerPaused = await latestImport();
  await mm("pause", ownerPaused);

  const pauses = await sql<{ id: string; paused_by: string | null }[]>`
    select id, paused_by::text as paused_by from imports
     where id in (${shutdownPaused}, ${ownerPaused})`;
  const pausedBy = (id: string): string => pauses.find((row) => row.id === id)?.paused_by ?? "null";
  check(
    pausedBy(ownerPaused) === "user",
    "`mm pause` records the owner as the one who stopped it",
    pausedBy(ownerPaused),
  );

  await recreateToolbox(FAST_MS);
  worker = spawnChild([bun, "run", "apps/web/src/worker/index.ts"], "worker");
  info("worker restarted");

  const wokenUp = await waitFor(
    shutdownPaused,
    (row) => row.status === "done" || row.status === "failed",
    "the shutdown-paused import to be picked back up",
  );
  check(
    wokenUp.status === "done",
    "an import paused by a worker shutting down is resumed by the next worker",
    wokenUp.status,
  );

  const leftAlone = await job(ownerPaused);
  check(
    leftAlone.status === "paused",
    "an import the owner paused is still paused after a restart",
    leftAlone.status,
  );
  const messages = await sql<{ n: string }[]>`
    select count(*)::text as n from pgboss.job
     where data->>'importId' = ${ownerPaused} and state < 'completed'`;
  check(
    Number(messages[0]?.n ?? "0") === 0,
    "…and nothing was queued for it either",
    `${messages[0]?.n ?? "?"} message(s)`,
  );

  // The owner has to be able to read, after a deploy, what was picked back up and why.
  const bootLog = await Bun.file(join(repoRoot, ".local", "e2e-worker.log")).text();
  // The last one: both workers write to this file, and it is the *restarted* one being asked.
  const sweep = bootLog
    .split(/\r?\n/)
    .findLast(
      (row) => row.includes('"message":"resume sweep"') && row.includes('"trigger":"boot"'),
    );
  check(
    sweep !== undefined && sweep.includes("paused-by-shutdown") && sweep.includes("running-orphan"),
    "the boot log breaks the sweep down by reason",
    sweep ?? "no `resume sweep` line in the worker log",
  );

  const finished = await waitFor(
    first,
    (row) => row.status === "done",
    "the first import to finish",
  );
  check(finished.status === "done", "the interrupted import finished after a restart");

  /*
   * Every track that already had a file was **spared**, whichever way it was spared.
   *
   * Two reasons now, not one, because the steps are pipelined (decision 147): a track whose
   * download finished before the kill may still be in the work directory — `already
   * downloaded` — or it may already have been fingerprinted, tagged and filed while the next
   * one was coming down, in which case the restarted `download` finds it in the library and
   * says `already present`. Counting only the first reason measured the old serial pipeline,
   * where nothing could possibly be filed yet, and read as a regression on the new one while
   * "no track was downloaded twice" — the claim that actually matters — stayed green.
   */
  const spared = await sql<{ n: string }[]>`
    select count(distinct track_id)::text as n from job_events
     where import_id = ${first} and type = 'track.skipped'
       and data->>'reason' in ('already downloaded', 'already present')`;
  check(
    Number(spared[0]?.n ?? "0") >= before - 1,
    "already-downloaded tracks were not fetched again",
    `${spared[0]?.n ?? "0"} spared, ${String(before)} were on disk`,
  );

  const doubled = await sql<{ track_id: string; n: string }[]>`
    select track_id, count(*)::text as n from job_events
     where import_id = ${first} and step = 'download' and type = 'track.done'
     group by track_id having count(*) > 1`;
  check(
    doubled.length === 0,
    "no track was downloaded twice",
    `${String(doubled.length)} duplicate(s)`,
  );

  /* ---------------------------------------------------------------- */
  section("2 · the album on disk");
  /* ---------------------------------------------------------------- */

  const present = existsSync(ALBUM_DIR) ? readdirSync(ALBUM_DIR).sort() : [];
  const opus = present.filter((name) => name.endsWith(".opus"));
  check(opus.length === 14, "fourteen .opus files", `${String(opus.length)} found in ${ALBUM_DIR}`);
  for (const name of EXPECTED_FILES) {
    const path = join(ALBUM_DIR, name);
    const ok = existsSync(path) && statSync(path).size > 0;
    if (!ok) check(false, `missing or empty: ${name}`);
  }
  check(
    EXPECTED_FILES.every((name) => present.includes(name)),
    "every file is named as packages/domain/paths says",
  );

  const lrc = present.filter((name) => name.endsWith(".lrc"));
  check(
    lrc.length >= 1,
    ".lrc sidecar written",
    `${String(lrc.length)} (only the tracks LRCLIB has lyrics for)`,
  );
  check(present.includes("cover.jpg"), "cover.jpg written");

  const artistImagePath = join(LIBRARY, "Daft Punk", "artist.jpg");
  check(
    existsSync(artistImagePath) && statSync(artistImagePath).size > 0,
    "artist.jpg written",
    artistImagePath,
  );

  /* ---------------------------------------------------------------- */
  section("3 · the tags, read back through the toolbox");
  /* ---------------------------------------------------------------- */

  const probed = await probe("Daft Punk/Discovery (2001)/01 - One More Time.opus");
  check(probed.codec === "opus", "the file really is Opus", probed.codec);
  for (const key of ["MUSICBRAINZ_TRACKID", "ARTISTS", "R128_TRACK_GAIN"]) {
    const value = probed.tags[key];
    check(
      value !== undefined && value !== "",
      `${key} present`,
      value === undefined ? "" : `= ${value.slice(0, 40)}`,
    );
  }
  check(
    (probed.tags["MUSICMANAGER_TAGSCHEMA"] ?? "") !== "",
    "MUSICMANAGER_TAGSCHEMA present (docs/03 §1)",
    probed.tags["MUSICMANAGER_TAGSCHEMA"] ?? "",
  );
  info(`${String(Object.keys(probed.tags).length)} tags in the file`);

  /* ---------------------------------------------------------------- */
  section("4 · idempotence: the same import again");
  /* ---------------------------------------------------------------- */

  await mm("import", "fixture://discovery", "--yes");
  const second = await latestImport();
  await waitFor(second, (row) => row.status === "done", "the second import to finish");

  const secondDownloads = await countDownloadedTracks(second);
  check(secondDownloads === 0, "zero downloads on the second import", `${String(secondDownloads)}`);
  const secondStep = await stepRow(second, "download");
  check(
    secondStep.status === "skipped" && secondStep.message.startsWith("already present"),
    "the download step says `already present`",
    secondStep.message,
  );

  /* ---------------------------------------------------------------- */
  section("5 · a playlist that lost one entry, imported anyway");
  /* ---------------------------------------------------------------- */
  //
  // The defect of 2026-09-17, end to end. `GET /tools/url` on an `OLAK5uy_…` album answered
  // `entries: 0` and "This video is not available" while yt-dlp, asked with `--ignore-errors`,
  // listed all twenty titles: one dead entry cancelled the extraction of the other nineteen,
  // and twenty live playlists were filed as vanished from YouTube on the strength of it.
  //
  // `?gap=14` takes one entry out of the recorded listing and reports it as unreadable, which
  // is what a live `ignoreerrors` extraction now does. Four properties, and every one of them
  // was false before: the import finishes, it is still an **album** and not something the
  // missing entry demoted it to, the gap is in the journal in words, and it survives on the
  // row for whoever opens the page tomorrow.

  await mm("import", "fixture://discovery?gap=14", "--yes");
  const partial = await latestImport();
  const partialRow = await waitFor(
    partial,
    (row) => row.status === "done" || row.status === "failed",
    "the partial import to finish",
  );
  check(
    partialRow.status === "done",
    "one unreadable entry does not fail the import",
    partialRow.status,
  );

  const partialKind = await sql<{ kind: string; n: string }[]>`
    select i.kind::text as kind,
           (select count(*)::text from import_tracks t where t.import_id = i.id) as n
      from imports i where i.id = ${partial}`;
  check(
    partialKind[0]?.kind === "album",
    "a partial listing is still classified as an album",
    partialKind[0]?.kind ?? "?",
  );
  check(
    partialKind[0]?.n === "14",
    "the fourteen entries that came back are all there",
    `${partialKind[0]?.n ?? "?"} track row(s)`,
  );

  const partialResolve = await stepRow(partial, "resolve");
  check(
    partialResolve.message.startsWith("14 of 15 entries; 1 could not be read"),
    "the journal says how many entries the source listed",
    partialResolve.message,
  );

  const gapEvents = await sql<{ level: string; message: string }[]>`
    select level::text as level, message from job_events
     where import_id = ${partial} and type = 'resolve.unreadable'`;
  check(
    gapEvents.length === 1 && gapEvents[0]?.level === "warn",
    "one warn line names the entry that could not be read",
    gapEvents[0]?.message ?? "no event",
  );

  const storedGaps = await sql<{ unreadable: unknown }[]>`
    select unreadable from imports where id = ${partial}`;
  const gaps = (storedGaps[0]?.unreadable ?? []) as { position: number | null; code: string }[];
  check(
    gaps.length === 1 && gaps[0]?.position === 15,
    "the gap is on the import row, not only in the log",
    JSON.stringify(gaps),
  );

  /* ---------------------------------------------------------------- */
  section("6 · SSE, while a job runs");
  /* ---------------------------------------------------------------- */

  const web = await startWebIfNeeded();
  let sseLines = 0;

  /* ---------------------------------------------------------------- */
  section("7 · fingerprint mismatch, Inbox, and resuming from it");
  /* ---------------------------------------------------------------- */

  await mm("import", "fixture://discovery?fp=mismatch", "--yes", "--force");
  const third = await latestImport();

  // Watch this import over the very endpoint the Console will use.
  const sse = web === null ? null : startSse(third);

  const parked = await waitFor(
    third,
    (row) => row.status === "awaiting_review",
    "the fingerprint mismatch to park the job",
  );
  check(parked.status === "awaiting_review", "the job is awaiting_review after a mismatch");

  const items = await sql<{ n: string }[]>`
    select count(*)::text as n from inbox_items
     where import_id = ${third} and type = 'fingerprint_mismatch' and status = 'open'`;
  check(
    Number(items[0]?.n ?? "0") > 0,
    "fingerprint_mismatch Inbox item(s) created",
    `${items[0]?.n ?? "0"}`,
  );

  const listed = await mm("inbox", "list");
  check(listed.includes("fingerprint_mismatch"), "`mm inbox list` shows them");

  await mm("inbox", "resolve", "--all", "--accept", "--import", third);
  const resumed = await waitFor(
    third,
    (row) => row.status === "done",
    "the accepted job to finish",
  );
  check(resumed.status === "done", "`mm inbox resolve --accept` let the job finish");

  if (sse !== null) {
    sseLines = await sse;
    check(
      sseLines > 0,
      `SSE delivered events on GET /api/events?import=…`,
      `${String(sseLines)} frame(s)`,
    );
  } else {
    check(false, "SSE endpoint reachable on " + WEB_URL, "the web server never came up");
  }

  /* ---------------------------------------------------------------- */
  section("8 · watched sources: the diff, and the auto-accept gate");
  /* ---------------------------------------------------------------- */
  //
  // The fixture playlist exists at two points in time, one video apart, and every reachable
  // entry points at `fixture://skinny-love`, so the imports a scan opens resolve, match and
  // download entirely offline. Three properties are worth an end-to-end run rather than a
  // unit test: the diff is idempotent, a source that opted in reaches `done` with nobody
  // looking, and a source that did not opt in stops at `awaiting_confirm` — **including in
  // fixtures mode**, which confirms every other import automatically.

  await mm(
    "watch",
    "add",
    "fixture://watched?snapshot=1&e2e=auto",
    "--label",
    "Auto",
    "--auto-accept",
  );
  await mm("watch", "add", "fixture://watched?snapshot=1&e2e=manual", "--label", "Manual");

  const sourceIds = await sql<{ id: string; url: string }[]>`
    select id, url from watched_sources order by created_at`;
  const autoSource = sourceIds.find((row) => row.url.includes("e2e=auto"))?.id ?? "";
  const manualSource = sourceIds.find((row) => row.url.includes("e2e=manual"))?.id ?? "";
  check(autoSource !== "" && manualSource !== "", "`mm watch add` registered two sources");

  await mm("watch", "scan", autoSource);
  const firstPass = await sql<{ status: string; n: string }[]>`
    select status::text as status, count(*)::text as n from watched_source_items
     where source_id = ${autoSource} group by status order by status`;
  const countOf = (rows: { status: string; n: string }[], status: string): number =>
    Number(rows.find((row) => row.status === status)?.n ?? "0");
  check(
    countOf(firstPass, "imported") === 2 && countOf(firstPass, "skipped") === 1,
    "snapshot 1: two videos imported, the private one skipped",
    firstPass.map((row) => `${row.status} ${row.n}`).join(", "),
  );

  await mm("watch", "scan", autoSource);
  const secondPass = await sql<{ n: string }[]>`
    select count(*)::text as n from watched_source_items where source_id = ${autoSource}`;
  check(
    Number(secondPass[0]?.n ?? "0") === 3,
    "scanning the same listing again discovers nothing",
    `${secondPass[0]?.n ?? "?"} item(s)`,
  );

  // Tomorrow: the same playlist, one video longer.
  await sql`update watched_sources set url = ${"fixture://watched?snapshot=2&e2e=auto"}
             where id = ${autoSource}`;
  await mm("watch", "scan", autoSource);
  const thirdPass = await sql<{ n: string }[]>`
    select count(*)::text as n from watched_source_items where source_id = ${autoSource}`;
  check(
    Number(thirdPass[0]?.n ?? "0") === 4,
    "snapshot 2 discovers exactly one new video",
    `${thirdPass[0]?.n ?? "?"} item(s)`,
  );

  const autoImports = await sql<{ import_id: string }[]>`
    select import_id from watched_source_items
     where source_id = ${autoSource} and import_id is not null order by first_seen_at`;
  const autoImport = autoImports[0]?.import_id ?? "";
  check(autoImport !== "", "the scan opened imports for the new videos");

  const accepted = await waitFor(
    autoImport,
    (row) => row.status === "done" || row.status === "failed",
    "the auto-accepted import to finish",
  );
  check(accepted.status === "done", "an auto-accepting source takes its import to done");
  const decidedBy = await sql<{ decided_by: string }[]>`
    select decided_by from decisions where import_id = ${autoImport} limit 1`;
  check(
    decidedBy[0]?.decided_by === "watched-source",
    "the confirmation is signed `watched-source`, never `fixtures`",
    decidedBy[0]?.decided_by ?? "no decision row",
  );

  await mm("watch", "scan", manualSource);
  const manualImports = await sql<{ import_id: string }[]>`
    select import_id from watched_source_items
     where source_id = ${manualSource} and import_id is not null order by first_seen_at`;
  const manualImport = manualImports[0]?.import_id ?? "";
  const waiting = await waitFor(
    manualImport,
    (row) => row.status === "awaiting_confirm" || row.status === "done",
    "the un-opted-in import to reach its gate",
  );
  check(
    waiting.status === "awaiting_confirm",
    "a source without auto-accept waits, even in fixtures mode",
    waiting.status,
  );
  const sourceItems = await sql<{ n: string }[]>`
    select count(*)::text as n from inbox_items
     where import_id = ${manualImport} and type = 'source_new_video' and status = 'open'`;
  check(
    Number(sourceItems[0]?.n ?? "0") === 1,
    "a `source_new_video` Inbox item points at it",
    `${sourceItems[0]?.n ?? "?"} item(s)`,
  );

  /* ---------------------------------------------------------------- */
  section("9 · a folder of files, imported without downloading anything");
  /* ---------------------------------------------------------------- */
  //
  // The case the owner has three times over and which no URL can express: twenty playlists
  // that have vanished from YouTube, eight albums behind an age check, and a library that is
  // simply already on the disk. All three fail at `resolve`, before a single track row exists,
  // so adopting a file onto a track cannot help — there is no track.
  //
  // What is proved here, end to end, with the real worker, the real toolbox and the real CLI:
  // folder → entries → match → adopt → tag → place, and **no download**. The last part is the
  // one that has to be measured rather than assumed, so it is checked three ways: no
  // `track.done` event (the journal line a fetched file writes), an `mm_adoption` record on
  // every row, and the `COMMENT` read back out of a *placed* file with ffprobe.

  const { buildFixtureSource, FIXTURE_ALBUM, FIXTURE_ARTIST, FIXTURE_TRACKS } =
    await import("../fixtures/folder/build-source.ts");
  // Inside this run's library, because ffprobe runs in the container and the container's only
  // mount is the library. In production that is what `MM_ADOPT_PATH` provides; here the
  // fixture folder is dot-prefixed so Navidrome's scanner never sees it.
  const source = await buildFixtureSource({
    libraryRoot: LIBRARY,
    subdir: ".mm-folder-src",
    toolboxUrl: TOOLBOX_URL,
    containerRoot: TOOLBOX_LIBRARY_ROOT,
  });
  info(`built ${String(source.files)} tagged file(s) in ${source.album}`);

  const folderOut = await mm("import", source.album, "--yes", "--follow");
  const folderImport = await latestImport();
  const folderJob = await waitFor(
    folderImport,
    (row) => row.status === "done" || row.status === "failed",
    "the folder import to finish",
  );
  check(
    folderJob.status === "done",
    "a folder of audio files imports to done",
    folderOut.slice(-300),
  );

  const folderRow = await sql<{ url: string; kind: string }[]>`
    select url, kind from imports where id = ${folderImport}`;
  check(
    folderRow[0]?.kind === "album",
    "the files agreeing on an album make it an `album` — no fifth kind was needed",
    folderRow[0]?.kind ?? "(none)",
  );
  check(
    (folderRow[0]?.url ?? "").startsWith("file:///"),
    "the source is stored as a file:// URL, in the same column a playlist uses",
    folderRow[0]?.url ?? "(none)",
  );

  // `track.done` on the **download** step is the line a fetched file writes — `tag` and `place`
  // write one of their own for every track, adopted or not, so the step is part of the filter.
  const downloadEvents = await sql<{ n: string }[]>`
    select count(*)::text as n from job_events
     where import_id = ${folderImport} and type = 'track.done' and step = 'download'`;
  check(
    Number(downloadEvents[0]?.n ?? "1") === 0,
    "not one byte was downloaded: no download finished on this import",
    `${downloadEvents[0]?.n ?? "?"} download(s)`,
  );
  const downloadedBytes = await sql<{ n: string }[]>`
    select coalesce(sum(downloaded_bytes), 0)::text as n from import_tracks
     where import_id = ${folderImport}`;
  info(`${downloadedBytes[0]?.n ?? "?"} byte(s) accounted for, all of them copied from disk`);
  const adoptedEvents = await sql<{ n: string }[]>`
    select count(*)::text as n from job_events
     where import_id = ${folderImport} and type = 'track.adopted'`;
  check(
    Number(adoptedEvents[0]?.n ?? "0") === FIXTURE_TRACKS.length,
    `all ${String(FIXTURE_TRACKS.length)} files were adopted instead`,
    `${adoptedEvents[0]?.n ?? "?"} adoption(s)`,
  );

  const adoptedRows = await sql<{ n: string }[]>`
    select count(*)::text as n from import_tracks
     where import_id = ${folderImport} and raw ? 'mm_adoption' and raw ? 'mm_file'`;
  check(
    Number(adoptedRows[0]?.n ?? "0") === FIXTURE_TRACKS.length,
    "every row carries both its file record and its adoption record in `raw`",
    `${adoptedRows[0]?.n ?? "?"} row(s)`,
  );

  const placed = await sql<{ path: string; track_number: number }[]>`
    select t.path, t.track_number from library_tracks t
      join library_albums a on a.id = t.album_id
     where a.title = ${FIXTURE_ALBUM} order by t.track_number`;
  check(
    placed.length === FIXTURE_TRACKS.length,
    `${String(FIXTURE_TRACKS.length)} tracks were filed into the library`,
    `${String(placed.length)} filed`,
  );
  check(
    placed.every((row, index) => row.track_number === index + 1),
    "in the order the files' own track numbers state, not the order the directory was in",
    placed.map((row) => String(row.track_number)).join(","),
  );
  for (const row of placed) {
    check(existsSync(join(LIBRARY, row.path)), `${row.path} is on disk`);
  }

  // MusicBrainz has no recording of this album, so `match` fell back to the source's own tags —
  // the `untagged` path that already existed for "import without MusicBrainz". An album with no
  // `release_mbid` is exactly what the library's `untagged` chip selects.
  const folderAlbum = await sql<{ release_mbid: string | null; album_artist: string }[]>`
    select release_mbid, album_artist from library_albums where title = ${FIXTURE_ALBUM}`;
  check(
    folderAlbum.length === 1 && (folderAlbum[0]?.release_mbid ?? "") === "",
    "with nothing on MusicBrainz the album is filed `untagged`, from the files' own tags",
    folderAlbum[0]?.release_mbid ?? "(no release mbid — correct)",
  );
  check(
    folderAlbum[0]?.album_artist === FIXTURE_ARTIST,
    "and it carries the artist the files claimed",
    folderAlbum[0]?.album_artist ?? "(none)",
  );

  const adoptedFile = placed[0]?.path ?? "";
  if (adoptedFile !== "") {
    const tags = await probe(adoptedFile);
    check(
      (tags.tags["COMMENT"] ?? "").startsWith("Adopted local file"),
      "the placed file says so itself: COMMENT names the file it was adopted from",
      tags.tags["COMMENT"] ?? "(no comment)",
    );
    check(
      !(tags.tags["COMMENT"] ?? "").includes("youtu.be"),
      "and it invents no YouTube video to say it was not downloaded from",
      tags.tags["COMMENT"] ?? "",
    );
    check(
      (tags.tags["ORIGINALFILENAME"] ?? "").endsWith(".opus"),
      "ORIGINALFILENAME is the file's own name",
      tags.tags["ORIGINALFILENAME"] ?? "(none)",
    );
  }

  // The refusals, at the one door a person actually walks into: a folder with nothing in it.
  // `capture` rather than `mm`, because this one is *expected* to exit non-zero and `mm` treats
  // that as the end of the run.
  const junk = await capture({
    label: "mm import <junk>",
    cmd: [bun, "run", "apps/web/bin/mm.ts", "import", source.junk],
    env: childEnv,
  });
  const junkSaid = `${junk.stdout}${junk.stderr}`;
  check(junk.code !== 0, "a folder with nothing importable exits non-zero", String(junk.code));
  check(
    junkSaid.includes("FOLDER_NO_AUDIO") || junkSaid.includes("nothing importable"),
    "…and says so by name, listing what it did see",
    junkSaid.split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200),
  );

  /* ---------------------------------------------------------------- */
  section("10 · the files follow the database (AGENTS.md's first guiding fact)");
  /* ---------------------------------------------------------------- */
  //
  // *The database is the source of truth for metadata; files are a regenerable projection of
  // it.* The owner found 175 files out of 4 344 where that was false, and — worse — a re-tag
  // that refused to repair them: `mm retag --album <id>` answered "Nothing to do — every file
  // in scope already carries that projection" over twelve files that plainly carried the
  // previous edition's `MUSICBRAINZ_RELEASETRACKID` and no `ASIN` at all.
  //
  // Everything below is asserted by **reading the tags back out of the file** through the
  // toolbox. Reading the database back would prove nothing: the database was never the thing
  // that was wrong.

  const album = await sql<{ id: string; import_id: string }[]>`
    select a.id, t.import_id
      from library_albums a
      join library_tracks t on t.album_id = a.id
     where a.folder like ${"Daft Punk/Discovery%"}
     limit 1`;
  const albumId = album[0]?.id ?? "";
  const albumImport = album[0]?.import_id ?? "";
  check(albumId !== "", "found the placed Discovery album", albumId);

  const FILE_1 = "Daft Punk/Discovery (2001)/01 - One More Time.opus";
  const FILE_2 = "Daft Punk/Discovery (2001)/02 - Aerodynamic.opus";

  /** The release-track id the database holds for the video behind one file. */
  const dbTrackMbid = async (path: string): Promise<string> => {
    const rows = await sql<{ track_mbid: string | null }[]>`
      select it.track_mbid
        from library_tracks lt
        join import_tracks it on it.id = lt.import_track_id
       where lt.path = ${path}
       limit 1`;
    return rows[0]?.track_mbid ?? "";
  };

  const beforeFile1 = (await probe(FILE_1)).tags["MUSICBRAINZ_RELEASETRACKID"] ?? "";
  const beforeFile2 = (await probe(FILE_2)).tags["MUSICBRAINZ_RELEASETRACKID"] ?? "";
  check(
    beforeFile1 !== "" && beforeFile2 !== "" && beforeFile1 !== beforeFile2,
    "the two files start with different release-track ids",
  );
  check(
    beforeFile1 === (await dbTrackMbid(FILE_1)),
    "and the database agrees with them, to begin with",
  );

  /*
   * The defect, reproduced on the rows a confirmation writes and on no others.
   *
   * `applySupplied` (`services/jobs/steps/match.ts`) writes exactly this when a different
   * edition is confirmed for an album whose files are already placed: the video → track
   * binding moves, and nothing else happens. `place` and `tag` will not catch up — a track in
   * state `done` is terminal in `machine.ts`, so re-queueing the import re-runs nothing over a
   * file that is already filed. That is the whole of the bug, and swapping two bindings makes
   * it visible in a single tag both halves of this test can read.
   */
  await sql`
    update import_tracks a
       set track_position = b.track_position,
           track_mbid     = b.track_mbid,
           recording_mbid = b.recording_mbid,
           track_title    = b.track_title
      from import_tracks b
     where a.import_id = ${albumImport} and b.import_id = ${albumImport}
       and a.track_position in (1, 2) and b.track_position in (1, 2)
       and a.track_position <> b.track_position`;

  const swapped1 = await dbTrackMbid(FILE_1);
  check(
    swapped1 === beforeFile2,
    "the database now binds file 1 to the other release track; the file does not know",
  );

  /*
   * What the owner ran, and what it used to answer. `behind` compares
   * `library_tracks.tag_schema_version` with the current one and nothing else, so a file whose
   * schema version is current is invisible to it however wrong its contents are.
   */
  const defaultRun = await mm("retag", "--album", albumId, "--dry-run");
  check(
    defaultRun.includes("Nothing to do") && defaultRun.includes("older projection version"),
    "the default selection still finds nothing — and now says which question it asked",
    defaultRun.split("\n").slice(-2).join(" ").trim(),
  );

  /*
   * Exactly two, on a fourteen-track album. The count matters as much as the repair: an album
   * imported twice has two `metadata_documents` rows per file, and a catch-up that joined them
   * on `library_track_id` reported four files adrift where two were — a warning that overstates
   * itself is a warning nobody reads twice.
   */
  const adriftRun = await mm("retag", "--album", albumId, "--adrift");
  check(
    /\b2 file\(s\) to projection/.test(adriftRun),
    "`mm retag --adrift` selects exactly the two files that disagree, out of fourteen",
    adriftRun.split("\n")[0] ?? "",
  );
  check(
    /done: 2\/2 file\(s\), 2 changed, 0 failed/.test(adriftRun),
    "and rewrites both of them",
    adriftRun.split("\n").slice(-1).join(" ").trim(),
  );

  const afterFile1 = await probe(FILE_1);
  const afterFile2 = await probe(FILE_2);
  check(
    (afterFile1.tags["MUSICBRAINZ_RELEASETRACKID"] ?? "") === (await dbTrackMbid(FILE_1)),
    "the file now carries the release-track id the database holds",
    afterFile1.tags["MUSICBRAINZ_RELEASETRACKID"] ?? "(absent)",
  );
  check(
    (afterFile2.tags["MUSICBRAINZ_RELEASETRACKID"] ?? "") === (await dbTrackMbid(FILE_2)),
    "and so does the other one",
    afterFile2.tags["MUSICBRAINZ_RELEASETRACKID"] ?? "(absent)",
  );
  check(
    (afterFile1.tags["MUSICBRAINZ_RELEASETRACKID"] ?? "") !== beforeFile1,
    "which is not the id it had before — the re-tag really rewrote the block",
  );

  const settled = await mm("retag", "--album", albumId, "--adrift");
  check(
    settled.includes("already matches the database"),
    "running it again finds nothing: a re-tag does not leave work behind itself",
    settled.split("\n").slice(-1).join(" ").trim(),
  );

  /* ---- and back, so the rest of this section works on a correct album ---- */

  await sql`
    update import_tracks a
       set track_position = b.track_position,
           track_mbid     = b.track_mbid,
           recording_mbid = b.recording_mbid,
           track_title    = b.track_title
      from import_tracks b
     where a.import_id = ${albumImport} and b.import_id = ${albumImport}
       and a.track_position in (1, 2) and b.track_position in (1, 2)
       and a.track_position <> b.track_position`;
  await mm("retag", "--album", albumId, "--adrift");
  const restored = (await probe(FILE_1)).tags["MUSICBRAINZ_RELEASETRACKID"] ?? "";
  check(
    restored === beforeFile1,
    "the round trip is reversible: the album is back to what it was",
    restored,
  );

  /*
   * ---- and the same thing without anybody asking ----
   *
   * Everything above was driven by hand, which is the *repair* for a library that already
   * diverged. This is the half that stops it happening again: a field corrected from the
   * Console queues the catch-up because of where it is written (`services/projection.ts`), and
   * the worker rewrites the file. Nobody had to know a re-tag exists.
   *
   * `ENGINEER` is the owner's own second example — "Robin Schmidt" in the database, "Robin
   * Schmidt, Alex Wharton" in the file — and it is run on a *restored* album because the
   * override refuses an edit to a track whose position is claimed by another file, which the
   * swap above deliberately makes true.
   */
  const trackRow = await sql<{ id: string }[]>`
    select id from library_tracks where path = ${FILE_1} limit 1`;
  const overridden = await mm("doc", "set", trackRow[0]?.id ?? "", "engineer", "Robin Schmidt");
  check(
    overridden.includes("re-tag     queued"),
    "a hand correction queues the catch-up itself, with nobody asking",
    overridden.split("\n").slice(-1).join(" ").trim(),
  );

  const engineerRun = await waitForRetagRun(/run (rtg_[0-9A-Z]+)/.exec(overridden)?.[1] ?? "");
  check(engineerRun === "done", "the worker drained it", engineerRun);
  const engineerTags = (await probe(FILE_1)).tags;
  check(
    (engineerTags["ENGINEER"] ?? "") === "Robin Schmidt",
    "and the file says what the database says, without a second gesture",
    engineerTags["ENGINEER"] ?? "(absent)",
  );

  /*
   * ---- and the other direction: the file moved, and nothing in the database did ----
   *
   * Everything above is a divergence the *database* caused — a re-match, a corrected field — and
   * every one of them is visible from a query. This one is not, and that is the whole point of
   * it: somebody opens a tag editor and changes `DATE`. The document does not move, and
   * `projection_hash` does not move either, because it is stamped after the toolbox has written
   * and read a block back and is therefore a record of *what we last wrote*, not of what the file
   * now holds. So both database-side predicates go on answering "nothing adrift" over a file that
   * plainly is — which is how `mm retag --adrift` came to select nothing after a hand edit and
   * report `0 changed` as though it had repaired something.
   *
   * The scan is the only pass that opens the file, so the scan is the only thing that can know.
   * It now writes what it read onto `library_tracks.file_drift_at`, and `adrift` unions that with
   * the two it already had. The cost stays where it already was — one probe per file, in the pass
   * that was already paying for it — instead of being paid a second time by every caller that
   * wants to *select* a drifted file.
   */
  const HAND_EDITED = FILE_2;
  const originalDate = (await probe(HAND_EDITED)).tags["DATE"] ?? "";
  await writeTag(HAND_EDITED, "DATE", "2008");
  check(
    (await probe(HAND_EDITED)).tags["DATE"] === "2008",
    "a tag edited behind the app's back really is in the file",
    `${originalDate} → 2008`,
  );

  // Honest about the mechanism, and the price of the design: nothing has opened the file since,
  // so nothing yet knows. This is the trade — a recorded fact, not a re-measured one.
  const beforeScan = await mm("retag", "--album", albumId, "--adrift");
  check(
    beforeScan.includes("Nothing to do"),
    "before a scan, no query can see it — no row moved",
    beforeScan.split("\n").slice(-1).join(" ").trim(),
  );

  // `mm scan run` exits 1 when it finds drift, which is the point, so it is captured rather than
  // run through `mm()`.
  const scanRun = await capture({
    label: "mm scan run",
    cmd: [bun, "run", "apps/web/bin/mm.ts", "scan", "run", "--json"],
    env: childEnv,
  });
  const scanReport = JSON.parse(scanRun.stdout) as {
    drift: { path: string; fields: { key: string; db: string; file: string }[] }[];
  };
  const found = scanReport.drift.find((entry) => entry.path === HAND_EDITED);
  const dateField = found?.fields.find((field) => field.key === "DATE");
  check(
    dateField?.file === "2008" && dateField.db === originalDate,
    "the scan opens the file, finds it, and says both sides",
    `db=${String(dateField?.db)} file=${String(dateField?.file)}`,
  );

  const flagged = await sql<{ n: string }[]>`
    select count(*)::text as n from library_tracks
     where path = ${HAND_EDITED} and file_drift_at is not null`;
  check(flagged[0]?.n === "1", "and writes what it read onto the row", `file_drift_at set`);

  /*
   * The owner's instruction after a hand edit, with no file named and no ids fed in. That is the
   * acceptance test for the whole mechanism: a detector that reads files and a repairer that
   * reads only the database are no use to anybody until one of them can reach the other.
   */
  const adriftAfterScan = await mm("retag", "--album", albumId, "--adrift");
  check(
    /\b1 file\(s\) to projection/.test(adriftAfterScan),
    "`mm retag --adrift` now selects exactly that one file, nobody having named it",
    adriftAfterScan.split("\n")[0] ?? "",
  );
  check(
    /done: 1\/1 file\(s\), 1 changed, 0 failed/.test(adriftAfterScan),
    "and rewrites it",
    adriftAfterScan.split("\n").slice(-1).join(" ").trim(),
  );
  check(
    (await probe(HAND_EDITED)).tags["DATE"] === originalDate,
    "the file carries the document's value again",
    (await probe(HAND_EDITED)).tags["DATE"] ?? "(absent)",
  );

  /*
   * A recorded fact ages, so something has to clear it — otherwise "175 files adrift" never goes
   * down however many times the button is pressed. Two things do: `retag.stamp`, on the file it
   * has just rewritten (here), and a scan that re-reads a file and finds no difference
   * (`scan.recordFileDrift`), which is what covers a file repaired by something else entirely.
   */
  const cleared = await sql<{ n: string }[]>`
    select count(*)::text as n from library_tracks
     where path = ${HAND_EDITED} and file_drift_at is null`;
  check(
    cleared[0]?.n === "1",
    "and the re-tag cleared the scan's finding with it",
    "file_drift_at null",
  );
  const settledAgain = await mm("retag", "--album", albumId, "--adrift");
  check(
    settledAgain.includes("already matches the database"),
    "so running it again finds nothing: the flag cannot age into a lie",
    settledAgain.split("\n").slice(-1).join(" ").trim(),
  );

  /* ---------------------------------------------------------------- */
  section("11 · an album with a hole in it, closed from the command line");
  /* ---------------------------------------------------------------- */
  //
  // The two halves of the owner's September batch, in the order he hits them.
  //
  // A source publishes fewer titles than the release has tracks — nineteen official playlists
  // deleted, five videos withdrawn — so one track of the record is covered by no video. Until
  // now that album was *permanently* incomplete: `import_tracks` is born from a video, so
  // there was no id to adopt onto, and `mm adopt` answered ADOPT_NOT_READY however good the
  // file in your hand was. Now confirmation materialises the gap as a row, and that row takes
  // either a file or **a replacement address** — the same song under another upload, which is
  // what actually exists when a video is age-checked or Premium-only.
  //
  // Everything here goes through the real CLI, the real worker and the real toolbox, and the
  // last assertion is read back out of a *placed* file with ffprobe rather than out of the row
  // that produced it.

  // `?gap=3` drops a *real* track from the listing, where section 5's `?gap=14` drops the one
  // video that was outside the tracklist anyway. That one entry is the difference between an
  // album that is merely short a video and a record with a hole in it.
  await mm("import", "fixture://discovery?gap=3", "--yes", "--no-fingerprint");
  const gapJob = await latestImport();
  await waitFor(
    gapJob,
    (row) => ["done", "failed", "awaiting_review", "awaiting_confirm"].includes(row.status),
    "the album with a hole in it to settle",
  );

  const holes = await sql<{ id: string; track_position: number; source_title: string }[]>`
    select id, track_position, source_title
      from import_tracks
     where import_id = ${gapJob} and video_id is null
     order by medium_position, track_position`;
  check(
    holes.length > 0,
    "confirming an album the source did not fully publish leaves a row for each missing track",
    `${String(holes.length)} sourceless row(s)`,
  );
  check(
    holes.every((row) => row.track_position !== null),
    "…each one knowing where it sits on the record, which is how it will be filed",
    holes.map((row) => String(row.track_position)).join(", "),
  );

  // **No byte was fetched for them.** The whole danger of a row with no url is that the
  // download step sends that null to yt-dlp, fails the track, and takes the album with it.
  const gapState = await sql<{ n: string }[]>`
    select count(*)::text as n
      from import_tracks
     where import_id = ${gapJob} and video_id is null
       and (state <> 'sourceless' or error is not null or attempts <> 0)`;
  check(
    Number(gapState[0]?.n ?? "1") === 0,
    "no download was attempted for them: still `sourceless`, no error, no attempt",
    `${gapState[0]?.n ?? "?"} row(s) that moved`,
  );

  // …and the import **settled** rather than hanging for ever on a track nobody can download.
  const gapStatus = await sql<{ status: string }[]>`
    select status from imports where id = ${gapJob} limit 1`;
  check(
    gapStatus[0]?.status !== "running" && gapStatus[0]?.status !== "pending",
    "and the import finished anyway instead of waiting for a track that cannot arrive",
    gapStatus[0]?.status ?? "(none)",
  );

  // Now close the hole with a replacement address, from the command line, exactly as Kris
  // would. `--from-url` and not `--url`: `--url` selects a *remote installation*.
  const gapTrack = holes[0]?.id ?? "";
  if (gapTrack !== "") {
    const adopted = await mm("adopt", gapJob, gapTrack, "--from-url", "fixture://skinny-love");
    check(
      adopted.includes("downloaded") && adopted.includes("fixture://skinny-love"),
      "`mm adopt --from-url` downloads it and says which address it came from",
      adopted
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.slice(0, 120) ?? "",
    );

    const filled = await sql<{ state: string; download_path: string | null; raw: unknown }[]>`
      select state, download_path, raw from import_tracks where id = ${gapTrack} limit 1`;
    check(
      filled[0]?.state === "downloaded" && (filled[0]?.download_path ?? "") !== "",
      "the track that had no source now has one, and is an ordinary track again",
      `${filled[0]?.state ?? "?"} ${filled[0]?.download_path ?? ""}`,
    );

    const provenance = await sql<{ n: string }[]>`
      select count(*)::text as n
        from import_tracks
       where id = ${gapTrack}
         and raw -> 'mm_adoption' ->> 'via' = 'url'
         and raw -> 'mm_adoption' ->> 'url' = ${"fixture://skinny-love"}`;
    check(
      Number(provenance[0]?.n ?? "0") === 1,
      "…and `raw` remembers the address, so a rebuild months later says the same thing",
      `${provenance[0]?.n ?? "?"} record(s)`,
    );

    /*
     * And the adopted row rejoins the pipeline with no further gesture.
     *
     * Adopting re-opens a finished import and re-queues it, so the worker picks this track up
     * and carries it on. That it does is asserted here; **that it is skipped by `download`
     * before it can** was a real defect this section caught — the first version of the
     * sourceless guard keyed on `url is null` alone, which is still true of an adopted row
     * (it never had a video and never pretends it did), so the file was never announced on
     * the per-track queue and the re-opened import hung at `fingerprint` for ever.
     *
     * What is deliberately *not* asserted here is the placed file and its COMMENT. A `?gap=`
     * listing steers the matcher to an edition of the record whose MusicBrainz document is not
     * in the recorded set, so `tag` fails the album on `OFFLINE_CACHE_MISS` — a fact about
     * fixture coverage and nothing to do with adoption. That claim is made where it can be
     * made honestly: `adopt.integration.test.ts` takes a replacement download all the way to
     * `place` and reads *Downloaded from … · original source … unavailable* back off the file
     * with ffprobe.
     */
    await waitFor(
      gapJob,
      (row) => row.status !== "pending",
      "the re-opened import to be picked up again",
    );
    const resumed = await sql<{ state: string; url: string | null }[]>`
      select state::text as state, url from import_tracks where id = ${gapTrack} limit 1`;
    check(
      resumed[0]?.state !== "sourceless",
      "the re-opened import carries it on rather than skipping it back to `sourceless`",
      resumed[0]?.state ?? "?",
    );
    check(
      resumed[0]?.url === null,
      "…while the row still admits it never had a video of its own",
      String(resumed[0]?.url),
    );
  }

  /* ---------------------------------------------------------------- */
  section("summary");
  /* ---------------------------------------------------------------- */

  const albums = await sql<{ n: string }[]>`select count(*)::text as n from library_albums`;
  const tracks = await sql<{ n: string }[]>`select count(*)::text as n from library_tracks`;
  const documents = await sql<{ n: string }[]>`select count(*)::text as n from metadata_documents`;
  info(
    `library_albums ${albums[0]?.n ?? "?"} · library_tracks ${tracks[0]?.n ?? "?"} · metadata_documents ${documents[0]?.n ?? "?"}`,
  );

  console.log(
    `\n${failures === 0 ? "OK" : "FAILED"}: ${String(checks - failures)}/${String(checks)} checks passed`,
  );
}

/* ------------------------------------------------------------------ */
/* SSE and the web server                                              */
/* ------------------------------------------------------------------ */

/** Reuse a dev server if one is already running; otherwise start one. */
async function startWebIfNeeded(): Promise<Child | "reused" | null> {
  if (await webAnswers()) {
    info(`reusing the web server already on ${WEB_URL}`);
    return "reused";
  }
  info(`starting the web dev server on ${WEB_URL} (this takes a few seconds)`);
  // Not `bun run --cwd apps/web dev`: that script hardcodes `--port 3000`, which is exactly the
  // fixed port this run must not depend on.
  spawnChild(
    [bun, "x", "vite", "dev", "--port", String(WEB_PORT), "--strictPort"],
    "web",
    join(repoRoot, "apps", "web"),
  );
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (await webAnswers()) {
      info(`web server ready on ${WEB_URL}`);
      return "reused";
    }
    if (Date.now() > deadline) {
      console.log("  ..   the web server did not come up in time; SSE will be reported as failed");
      return null;
    }
    await Bun.sleep(1500);
  }
}

async function webAnswers(): Promise<boolean> {
  try {
    const response = await fetch(`${WEB_URL}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * `curl -N` against the SSE endpoint, exactly as the acceptance criteria spell it, returning
 * the number of `event:` frames it saw. curl rather than fetch on purpose: it proves the
 * endpoint streams to a dumb HTTP client with no framework in the way.
 */
function startSse(importId: string): Promise<number> {
  const curl = Bun.which("curl");
  const url = `${WEB_URL}/api/events?import=${importId}`;
  info(`curl -N "${url}"`);
  if (curl === null) return Promise.resolve(0);
  const child = Bun.spawn([curl, "-sN", "--max-time", "120", url], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (async () => {
    let frames = 0;
    const decoder = new TextDecoder();
    const timer = setTimeout(() => {
      child.kill();
    }, 120_000);
    try {
      for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
        const text = decoder.decode(chunk, { stream: true });
        frames += (text.match(/^event: /gm) ?? []).length;
        if (text.includes("import.done")) break;
      }
    } finally {
      clearTimeout(timer);
      child.kill();
    }
    return frames;
  })();
}

/* ------------------------------------------------------------------ */

try {
  await main();
} finally {
  await stopEverything();
  await sql.end();
  // Leave nothing behind for the next run to trip over: a fresh port and database exist only
  // because this run picked them, so nothing else can depend on them surviving.
  if (process.env["MM_E2E_DB"] === undefined) {
    await dropDatabaseIfExists(ADMIN_DATABASE_URL, TEST_DB);
  }
  if (process.env["MM_E2E_LIBRARY_SUBDIR"] === undefined) {
    rmSync(LIBRARY, { recursive: true, force: true });
  }
}

process.exit(failures === 0 ? 0 : 1);
