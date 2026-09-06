/**
 * `bun run e2e-fixture` — the whole vertical slice, offline, automated.
 *
 * This is the acceptance test of P03 and the regression net for every phase after it. It runs
 * the real worker, the real CLI and the real toolbox container; nothing is stubbed and nothing
 * reaches the network. Four scenarios, in one pass over one library:
 *
 *  1. **resume**       — the worker is killed mid-download and restarted. The job carries on
 *                        and nothing already on disk is fetched twice.
 *  2. **the album**    — fourteen `.opus` files with the right names, a `.lrc` sidecar, a
 *                        `cover.jpg`, and one file probed through the toolbox to prove the
 *                        tags really are in it.
 *  3. **idempotence**  — the same import again: zero downloads, `already present`.
 *  4. **fingerprint**  — `?fp=mismatch` parks the job in `awaiting_review` with Inbox items,
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

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
/**
 * A database of its own, per process, rather than resetting whatever `DATABASE_URL` already
 * pointed at — which was the developer's or another agent's real `mm` database by default.
 * `MM_E2E_DB` pins a name for a caller that wants a stable one.
 */
const TEST_DB = process.env["MM_E2E_DB"] ?? `mm_e2e_fixture_${String(process.pid)}`;
const DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, TEST_DB);
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
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
const LIBRARY_SUBDIR =
  process.env["MM_E2E_LIBRARY_SUBDIR"] ?? `.mm-e2e-fixture-${String(process.pid)}`;
const LIBRARY = resolve(repoRoot, ".local/library", LIBRARY_SUBDIR);
const TOOLBOX_LIBRARY_ROOT = `/library/${LIBRARY_SUBDIR}`;
const COMPOSE = ["-f", "docker-compose.dev.yml", "-f", "docker-compose.fixtures.yml"];

/** Slice pace of the fixture download. Slow enough to interrupt, fast enough to finish. */
const SLOW_MS = "400";
const FAST_MS = "20";

/** The fourteen names `packages/domain/paths` must produce for Discovery. */
const EXPECTED_FILES = [
  "01 One More Time.opus",
  "02 Aerodynamic.opus",
  "03 Digital Love.opus",
  "04 Harder, Better, Faster, Stronger.opus",
  "05 Crescendolls.opus",
  "06 Nightvision.opus",
  "07 Superheroes.opus",
  "08 High Life.opus",
  "09 Something About Us.opus",
  "10 Voyager.opus",
  "11 Veridis Quo.opus",
  "12 Short Circuit.opus",
  "13 Face to Face.opus",
  "14 Too Long.opus",
] as const;

const ALBUM_DIR = join(LIBRARY, "Daft Punk", "Discovery (2001)");

const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
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
    cmd: [docker, "compose", ...COMPOSE, "up", "-d", "toolbox"],
    env: { ...childEnv, MM_TOOLBOX_FIXTURE_DELAY_MS: delayMs },
  });
  if (result.code !== 0) die(`compose up toolbox failed:\n${result.stderr}`);
  await toolboxReady();
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
  if (!(await dockerIsRunning())) die("The Docker daemon is not answering. Start Docker Desktop.");
  const docker = resolveDocker();
  if (docker === null) die("docker not found");

  const up = await capture({
    label: "compose up",
    cmd: [docker, "compose", ...COMPOSE, "up", "-d", "postgres", "toolbox"],
    env: { ...childEnv, MM_TOOLBOX_FIXTURE_DELAY_MS: FAST_MS },
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

  await recreateToolbox(FAST_MS);
  worker = spawnChild([bun, "run", "apps/web/src/worker/index.ts"], "worker");
  info("worker restarted");

  const finished = await waitFor(
    first,
    (row) => row.status === "done",
    "the first import to finish",
  );
  check(finished.status === "done", "the interrupted import finished after a restart");

  const reused = await sql<{ n: string }[]>`
    select count(*)::text as n from job_events
     where import_id = ${first} and type = 'track.skipped'
       and data->>'reason' = 'already downloaded'`;
  check(
    Number(reused[0]?.n ?? "0") >= before - 1,
    "already-downloaded tracks were not fetched again",
    `${reused[0]?.n ?? "0"} reused, ${String(before)} were on disk`,
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

  /* ---------------------------------------------------------------- */
  section("3 · the tags, read back through the toolbox");
  /* ---------------------------------------------------------------- */

  const probed = await probe("Daft Punk/Discovery (2001)/01 One More Time.opus");
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
  section("5 · SSE, while a job runs");
  /* ---------------------------------------------------------------- */

  const web = await startWebIfNeeded();
  let sseLines = 0;

  /* ---------------------------------------------------------------- */
  section("6 · fingerprint mismatch, Inbox, and resuming from it");
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
