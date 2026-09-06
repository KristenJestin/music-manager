/**
 * `bun run e2e-verify` — the acceptance test of P07b.
 *
 * `docs/03-metadonnees.md` §7 says the read-back is *the only proof of what Feishin and
 * Symfonium will show*. This script produces that proof end to end, against a real Navidrome
 * in Docker and with no network anywhere:
 *
 *  1. import the fixture album offline (the toolbox in fixtures mode, the source cache seeded);
 *  2. let the `verify` step rescan Navidrome, wait for the scan, and read the album back;
 *  3. assert **every required field is `ok`**, and print which ones came back `not indexed` —
 *     because that list is a fact about the server version, and it belongs in the report;
 *  4. delete a file → the scan reports it missing → the re-download keeps the mapping;
 *  5. edit a tag by hand through the toolbox → the scan reports the drift → the fix re-tags.
 *
 * Steps 4 and 5 are the other two acceptance criteria of the phase, and they belong here
 * rather than in a unit test for the same reason: they are only true if the whole chain is.
 *
 *     docker compose -f docker-compose.dev.yml up -d navidrome
 *     bun run e2e-verify
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import {
  bun,
  capture,
  createFreshDatabase,
  dockerIsRunning,
  dropDatabaseIfExists,
  repoRoot,
  resolveDocker,
  withDatabaseName,
} from "./lib.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
/**
 * A database of its own, per process — not the shared `mm` database this used to reset by
 * default, which a concurrent `bun run dev` or another agent's run could be using at the same
 * moment. `MM_E2E_DB` pins a name for a caller that wants a stable one.
 */
const TEST_DB = process.env["MM_E2E_DB"] ?? `mm_e2e_verify_${String(process.pid)}`;
const DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, TEST_DB);
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";
const NAVIDROME_URL = process.env["MM_NAVIDROME_URL"] ?? "http://localhost:4533";
const NAVIDROME_USER = process.env["MM_NAVIDROME_USER"] ?? "admin";
/** `ND_DEVAUTOCREATEADMINPASSWORD` in docker-compose.dev.yml. */
const NAVIDROME_PASSWORD = process.env["MM_NAVIDROME_PASSWORD"] ?? "admin";

/**
 * A library directory of its own, per process, under the bind mount the toolbox and Navidrome
 * both already see — so this run's "delete a file" / "edit a tag by hand" sabotage never lands
 * on an album a developer or another run is looking at.
 *
 * **Not dot-prefixed.** `.mm-work` is dot-prefixed on purpose so Navidrome's scanner ignores it
 * (`CLAUDE.md`) — which is exactly wrong here: this script's whole point is a *real* Navidrome
 * read-back, and a scanner that skips the directory leaves `getAlbumList2` empty forever, so
 * `waitForScan` spins until `NAVIDROME_SCAN_TIMEOUT` no matter how fast Navidrome's own scan
 * actually finishes (confirmed against Navidrome 0.63.2: `getScanStatus` after a normal, real
 * scan of this directory).
 */
const LIBRARY_SUBDIR =
  process.env["MM_E2E_LIBRARY_SUBDIR"] ?? `mm-e2e-verify-${String(process.pid)}`;
const LIBRARY = resolve(repoRoot, ".local/library", LIBRARY_SUBDIR);
const TOOLBOX_LIBRARY_ROOT = `/library/${LIBRARY_SUBDIR}`;
const ALBUM_DIR = join(LIBRARY, "Daft Punk", "Discovery (2001)");
const COMPOSE = ["-f", "docker-compose.dev.yml", "-f", "docker-compose.fixtures.yml"];

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

const section = (title: string): void => {
  console.log(`\n=== ${title} ===`);
};
const info = (message: string): void => {
  console.log(`  ..   ${message}`);
};
function check(ok: boolean, what: string, detail = ""): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${detail === "" ? "" : `  ${detail}`}`);
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

function spawnChild(cmd: string[], label: string): Child {
  const log = Bun.file(join(repoRoot, ".local", `e2e-verify-${label}.log`)).writer();
  const child = Bun.spawn(cmd, { cwd: repoRoot, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
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

/** Only ever a PID this script started. Nothing is ever killed by name. */
async function stopEverything(): Promise<void> {
  for (const child of [...running]) {
    if (!child.killed) {
      child.kill(9);
      await child.exited;
    }
  }
  running.length = 0;
}

/** Run `mm …`; `allowFailure` is for the commands whose exit code is a finding. */
async function mm(
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<{ stdout: string; code: number }> {
  const result = await capture({
    label: `mm ${args[0] ?? ""}`,
    cmd: [bun, "run", "apps/web/bin/mm.ts", ...args],
    env: childEnv,
  });
  if (result.code !== 0 && options.allowFailure !== true) {
    console.log(result.stdout);
    console.error(result.stderr);
    die(`mm ${args.join(" ")} exited ${String(result.code)}`);
  }
  return { stdout: result.stdout, code: result.code };
}

/* ------------------------------------------------------------------ */
/* database                                                            */
/* ------------------------------------------------------------------ */

const sql = new SQL({ url: DATABASE_URL, max: 2 });

async function waitForImport(importId: string, timeoutMs = 300_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql<{ status: string; step: string }[]>`
      select status::text as status, step::text as step from imports where id = ${importId}`;
    const row = rows[0];
    if (row === undefined) die(`no import ${importId}`);
    if (["done", "failed", "cancelled", "awaiting_review"].includes(row.status)) return row.status;
    if (Date.now() > deadline) die(`timed out with the import at ${row.status}/${row.step}`);
    await Bun.sleep(500);
  }
}

async function latestImport(): Promise<string> {
  const rows = await sql<{ id: string }[]>`select id from imports order by created_at desc limit 1`;
  const id = rows[0]?.id;
  if (id === undefined) die("no import was created");
  return id;
}

/* ------------------------------------------------------------------ */
/* the services                                                        */
/* ------------------------------------------------------------------ */

async function toolboxReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(4000) });
      const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
      if (body.ok === true) {
        if (body.fixtures !== true) die("the toolbox is up but not in fixtures mode");
        return;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) die("the toolbox never became healthy");
    await Bun.sleep(1000);
  }
}

/** The Subsonic auth pair. Written here rather than imported: this script tests the app. */
async function subsonic(view: string, params: Record<string, string> = {}): Promise<never> {
  const salt = Math.random().toString(16).slice(2, 10);
  const token = new Bun.CryptoHasher("md5").update(NAVIDROME_PASSWORD + salt).digest("hex");
  const query = new URLSearchParams({
    u: NAVIDROME_USER,
    t: token,
    s: salt,
    v: "1.16.1",
    c: "mm-e2e",
    f: "json",
    ...params,
  });
  const response = await fetch(`${NAVIDROME_URL}/rest/${view}?${query.toString()}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) die(`navidrome ${view} answered HTTP ${String(response.status)}`);
  const body = (await response.json()) as { "subsonic-response": Record<string, unknown> };
  const envelope = body["subsonic-response"];
  if (envelope["status"] !== "ok") die(`navidrome ${view} failed: ${JSON.stringify(envelope)}`);
  return envelope as never;
}

async function navidromeReady(timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const ping = (await subsonic("ping")) as unknown as { serverVersion?: string };
      return ping.serverVersion ?? "unknown";
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      die(
        `Navidrome never answered on ${NAVIDROME_URL}.\n` +
          "  docker compose -f docker-compose.dev.yml up -d navidrome",
      );
    }
    await Bun.sleep(2000);
  }
}

/** Write one tag straight into a file, behind the app's back. That is the point. */
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

async function probeTag(relative: string, key: string): Promise<string> {
  const response = await fetch(`${TOOLBOX_URL}/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: `${TOOLBOX_LIBRARY_ROOT}/${relative}` }),
  });
  if (!response.ok) die(`toolbox /probe failed: HTTP ${String(response.status)}`);
  const body = (await response.json()) as { tags: Record<string, string> };
  return body.tags[key] ?? "";
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

interface VerifyField {
  name: string;
  required: boolean;
  written: string;
  read: string;
  status: "ok" | "mismatch" | "not_indexed";
}
interface Verification {
  server: string;
  serverVersion: string;
  fields: VerifyField[];
  ok: number;
  mismatches: number;
  notIndexed: number;
  requiredMismatches: string[];
  note: string | null;
}

interface ScanReport {
  filesSeen: number;
  orphans: { path: string }[];
  missing: { trackId: string; path: string; title: string }[];
  drift: { trackId: string; path: string; fields: { key: string; db: string; file: string }[] }[];
  duplicates: { recordingMbid: string }[];
}

async function main(): Promise<void> {
  section("preflight");
  if (!(await dockerIsRunning())) die("The Docker daemon is not answering. Start Docker Desktop.");
  const docker = resolveDocker();
  if (docker === null) die("docker not found");

  const up = await capture({
    label: "compose up",
    cmd: [docker, "compose", ...COMPOSE, "up", "-d", "postgres", "toolbox", "navidrome"],
    env: { ...childEnv, MM_TOOLBOX_FIXTURE_DELAY_MS: "20" },
  });
  if (up.code !== 0) die(`compose up failed:\n${up.stderr}`);
  await toolboxReady();
  info(`toolbox healthy at ${TOOLBOX_URL}, fixtures mode on`);
  const serverVersion = await navidromeReady();
  info(`navidrome ${serverVersion} at ${NAVIDROME_URL}`);

  info(`creating ${TEST_DB}`);
  await createFreshDatabase(ADMIN_DATABASE_URL, TEST_DB);
  const migrate = await capture({
    label: "db migrate",
    cmd: [bun, "run", join("apps", "web", "src", "server", "db", "migrate.ts")],
    env: childEnv,
  });
  if (migrate.code !== 0) die(`db migrate failed:\n${migrate.stdout}${migrate.stderr}`);
  const seeded = await capture({
    label: "seed fixtures",
    cmd: [bun, "run", "apps/web/src/server/integrations/seed-fixtures.ts"],
    env: childEnv,
  });
  if (seeded.code !== 0) die(`seeding the cache failed:\n${seeded.stdout}${seeded.stderr}`);
  info("database reset, migrated and seeded");

  rmSync(LIBRARY, { recursive: true, force: true });
  mkdirSync(LIBRARY, { recursive: true });
  info(`library emptied: ${LIBRARY}`);

  /* ---------------------------------------------------------------- */
  section("1 · Navidrome is configured through the settings store");
  /* ---------------------------------------------------------------- */

  await mm(["settings", "set", "navidromeEnabled", "true"]);
  await mm(["settings", "set", "navidromeUrl", NAVIDROME_URL]);
  await mm(["settings", "set", "navidromeUser", NAVIDROME_USER]);
  await mm(["settings", "set", "navidromePassword", NAVIDROME_PASSWORD]);
  await mm(["settings", "set", "navidromeRescanOnVerify", "true"]);
  await mm(["settings", "set", "navidromeWaitTimeoutMs", "300000"]);

  const shown = await mm(["settings", "get", "navidromePassword"]);
  check(
    !shown.stdout.includes(NAVIDROME_PASSWORD) || NAVIDROME_PASSWORD.length > 20,
    "the password is masked when read back",
    shown.stdout.trim(),
  );

  const status = await mm(["tools", "status", "--json"]);
  const tools = JSON.parse(status.stdout) as { navidrome: { ok: boolean; server: string } };
  check(tools.navidrome.ok, "mm tools status reaches Navidrome", tools.navidrome.server);

  /* ---------------------------------------------------------------- */
  section("2 · import the fixture album, offline");
  /* ---------------------------------------------------------------- */

  const worker = spawnChild([bun, "run", "apps/web/src/worker/index.ts"], "worker");
  await Bun.sleep(4000);
  if (worker.killed) die("the worker died on start; see .local/e2e-verify-worker.log");

  await mm(["import", "fixture://discovery", "--yes"]);
  const importId = await latestImport();
  info(`import ${importId}`);
  const finalStatus = await waitForImport(importId);
  check(finalStatus === "done", "the import finished", finalStatus);

  const opus = existsSync(ALBUM_DIR)
    ? readdirSync(ALBUM_DIR).filter((name) => name.endsWith(".opus"))
    : [];
  check(opus.length === 14, "fourteen .opus files are in the library", String(opus.length));

  /* ---------------------------------------------------------------- */
  section("3 · the verify step read the album back through OpenSubsonic");
  /* ---------------------------------------------------------------- */

  const verifyStep = await sql<{ status: string; message: string; result: unknown }[]>`
    select status::text as status, coalesce(message, '') as message, result
      from job_steps where import_id = ${importId} and step = 'verify'`;
  const step = verifyStep[0];
  check(step?.status === "done", "the verify step finished", step?.message ?? "no row");
  const stepData = (step?.result ?? {}) as { method?: string; readBack?: boolean };
  check(
    stepData.method === "opensubsonic",
    "it verified through OpenSubsonic, not by stat()ing files",
    String(stepData.method),
  );

  const stored = await sql<{ id: string; verification: Verification | null }[]>`
    select id, verification from library_albums`;
  const album = stored[0];
  check(album !== undefined, "the album has a library row");
  const verification = album?.verification ?? null;
  check(verification !== null, "the read-back was stored on the album");

  if (verification !== null) {
    console.log("");
    console.log(`  ${verification.server} ${verification.serverVersion}`);
    for (const field of verification.fields) {
      const mark = field.status === "ok" ? "ok  " : field.status === "mismatch" ? "FAIL" : "n/a ";
      console.log(
        `  ${mark} ${field.required ? "R" : " "} ${field.name.padEnd(22)}` +
          ` wrote=${trim(field.written)}  read=${trim(field.read)}`,
      );
    }
    console.log("");

    check(
      verification.note === null,
      "Navidrome had indexed the album",
      verification.note ?? "found",
    );
    check(
      verification.requiredMismatches.length === 0,
      "every required field came back ok",
      verification.requiredMismatches.join(", "),
    );
    const notIndexed = verification.fields.filter((field) => field.status === "not_indexed");
    info(
      notIndexed.length === 0
        ? "nothing came back `not indexed`: this server exposes every field we wrote"
        : `not indexed by ${verification.server} ${verification.serverVersion}: ${notIndexed
            .map((field) => field.name)
            .join(", ")}`,
    );
    info(
      `${String(verification.ok)} ok · ${String(verification.mismatches)} mismatch · ${String(verification.notIndexed)} not indexed`,
    );
  }

  const cliVerify = await mm(["verify", "--all", "--json"], { allowFailure: true });
  const report = JSON.parse(cliVerify.stdout) as { clean: number; withMismatch: number };
  check(cliVerify.code === 0, "`mm verify --all` exits 0", `code ${String(cliVerify.code)}`);
  check(report.clean >= 1, "at least one album is clean", `${String(report.clean)} clean`);

  /* ---------------------------------------------------------------- */
  section("4 · delete a file → the scan reports it missing → re-download");
  /* ---------------------------------------------------------------- */

  const victim = join(ALBUM_DIR, "05 - Crescendolls.opus");
  const victimSize = statSync(victim).size;
  unlinkSync(victim);
  info(`deleted 05 Crescendolls.opus (${String(victimSize)} bytes)`);

  const afterDelete = await mm(["scan", "run", "--json"], { allowFailure: true });
  const scan1 = JSON.parse(afterDelete.stdout) as ScanReport;
  const missing = scan1.missing.find((entry) => entry.path.endsWith("05 - Crescendolls.opus"));
  check(
    missing !== undefined,
    "the scan reports the file as missing",
    missing?.path ?? "not found",
  );
  check(scan1.orphans.length === 0, "and does not call the rest of the album orphaned");

  // The re-download must keep the mapping, which is what makes it a *re*-download.
  const mapping = await sql<{ recording_mbid: string; track_mbid: string; video_id: string }[]>`
    select it.recording_mbid, it.track_mbid, it.video_id
      from library_tracks lt join import_tracks it on it.id = lt.import_track_id
     where lt.path like '%05 Crescendolls.opus'`;
  const before = mapping[0];
  check(before !== undefined, "the missing track still knows which video it came from");

  await sql`update import_tracks set state = 'pending', download_path = null, library_path = null
             where id = (select import_track_id from library_tracks
                          where path like '%05 Crescendolls.opus')`;
  await mm(["retry", importId, "--step", "download"]);
  const resumed = await waitForImport(importId);
  check(resumed === "done", "the re-download finished", resumed);
  check(
    existsSync(victim) && statSync(victim).size > 0,
    "the file is back on disk",
    existsSync(victim) ? `${String(statSync(victim).size)} bytes` : "absent",
  );

  const after = await sql<{ recording_mbid: string; track_mbid: string; video_id: string }[]>`
    select it.recording_mbid, it.track_mbid, it.video_id
      from library_tracks lt join import_tracks it on it.id = lt.import_track_id
     where lt.path like '%05 Crescendolls.opus'`;
  check(
    after[0]?.recording_mbid === before?.recording_mbid &&
      after[0]?.track_mbid === before?.track_mbid &&
      after[0]?.video_id === before?.video_id,
    "the mapping survived the re-download",
    `${String(after[0]?.video_id)} → ${String(after[0]?.recording_mbid)}`,
  );

  /* ---------------------------------------------------------------- */
  section("5 · edit a tag by hand → the scan reports the drift → fix re-tags");
  /* ---------------------------------------------------------------- */

  const drifted = "Daft Punk/Discovery (2001)/01 - One More Time.opus";
  const originalDate = await probeTag(drifted, "DATE");
  await writeTag(drifted, "DATE", "2008");
  check(
    (await probeTag(drifted, "DATE")) === "2008",
    "the tag was edited behind the app's back",
    `${originalDate} → 2008`,
  );

  const afterEdit = await mm(["scan", "run", "--json"], { allowFailure: true });
  const scan2 = JSON.parse(afterEdit.stdout) as ScanReport;
  const drift = scan2.drift.find((entry) => entry.path === drifted);
  check(drift !== undefined, "the scan reports the drift");
  const dateField = drift?.fields.find((field) => field.key === "DATE");
  check(
    dateField?.file === "2008" && dateField.db === originalDate,
    "and says both sides of it",
    `db=${String(dateField?.db)} file=${String(dateField?.file)}`,
  );

  /*
   * "Fix" is the background re-tag of §8, not a patch.
   *
   * The file is rewritten from the document — which is the whole premise of this project:
   * files are a projection, so the way to repair one is to project it again, never to poke
   * the byte that looks wrong.
   */
  const trackId = drift?.trackId ?? "";
  const fixed = await mm(["retag", "--track", trackId], { allowFailure: true });
  check(fixed.code === 0, "the re-tag ran", fixed.stdout.trim().split("\n").at(-1) ?? "");

  const afterFix = await mm(["scan", "run", "--json"], { allowFailure: true });
  const scan3 = JSON.parse(afterFix.stdout) as ScanReport;
  check(
    scan3.drift.find((entry) => entry.path === drifted) === undefined,
    "the fix removed the drift",
    `${String(scan3.drift.length)} drifted file(s) left`,
  );
  check(
    (await probeTag(drifted, "DATE")) === originalDate,
    "and the file carries the document's value again",
    await probeTag(drifted, "DATE"),
  );

  /* ---------------------------------------------------------------- */
  section("result");
  /* ---------------------------------------------------------------- */
  console.log(`  ${String(checks - failures)}/${String(checks)} checks passed`);
  if (failures > 0) die(`${String(failures)} check(s) failed`);
}

const trim = (value: string, width = 34): string =>
  value.length <= width ? value : `${value.slice(0, width - 1)}…`;

async function cleanup(): Promise<void> {
  await stopEverything();
  await sql.end();
  // Leave nothing behind for the next run to trip over: a fresh database and library
  // directory exist only because this run picked them.
  if (process.env["MM_E2E_DB"] === undefined) {
    await dropDatabaseIfExists(ADMIN_DATABASE_URL, TEST_DB);
  }
  if (process.env["MM_E2E_LIBRARY_SUBDIR"] === undefined) {
    rmSync(LIBRARY, { recursive: true, force: true });
  }
}

try {
  await main();
  await cleanup();
  console.log("\ne2e-verify: green\n");
  process.exit(0);
} catch (error) {
  console.error(error);
  await cleanup();
  process.exit(1);
}
