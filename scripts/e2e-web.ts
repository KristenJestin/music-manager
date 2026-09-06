#!/usr/bin/env bun
/**
 * `bun run e2e` — the Console's browser tests, with the stack they need.
 *
 * It owns everything the tests assume and cleans up after itself:
 *
 *  1. checks that Postgres and the toolbox are up, and that the toolbox is in fixtures mode;
 *  2. drops and recreates a database of its own (`<db>_web_e2e`), migrates it, and seeds the
 *     recorded sources so `tag` can build a document offline;
 *  3. starts the web app and the worker on a dedicated port, in fixtures mode, with a known
 *     administrator;
 *  4. runs Playwright **under Node**;
 *  5. stops everything it started, and nothing it did not.
 *
 * Two choices deserve their reasons.
 *
 * **Its own database.** The tests count jobs and read the Inbox, so they cannot share a
 * database with a developer's own imports without becoming order-dependent on somebody else's
 * data. A fresh one costs a second and makes every assertion absolute.
 *
 * **Playwright runs on Node, not Bun.** Playwright talks to Chromium over a `--remote-debugging-pipe`
 * on file descriptors 3 and 4; Bun does not pass those through, so every `launch()` hangs until
 * the timeout with no error worth reading. Node is already on the machine (the route generator
 * uses it), so the runner shells out to it rather than pretending the problem does not exist.
 * Everything else here is Bun, and the entry point is still `bun run e2e`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import {
  bun,
  createFreshDatabase,
  dropDatabaseIfExists,
  findFreePort,
  repoRoot,
  webDir,
  withDatabaseName,
} from "./lib.ts";

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

const ADMIN_DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const TOOLBOX_URL = process.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100";

/**
 * A port of its own, chosen fresh by the OS unless `MM_E2E_PORT` pins one. Several agents run
 * on this machine at once (`CLAUDE.md`'s process-safety note); a fixed default — `:3000` most
 * of all, but a fixed `:3170` has the same problem between two concurrent `bun run e2e` — is
 * exactly the kind of collision that made two runs fight over one database (see below).
 */
const PORT = process.env["MM_E2E_PORT"]
  ? Number.parseInt(process.env["MM_E2E_PORT"], 10)
  : await findFreePort();
const BASE_URL = `http://localhost:${String(PORT)}`;

/**
 * A database of its own, per process. `MM_E2E_DB` pins one for a caller that wants a stable
 * name; otherwise the PID makes two concurrent runs use two different databases instead of
 * dropping and recreating the same `mm_web_e2e` out from under each other — the failure P07a
 * and P07b hit running `bun run e2e` at the same time (`orchestration/reports/P07a-build-1.md`
 * §6, "non fait").
 */
const TEST_DB = process.env["MM_E2E_DB"] ?? `mm_web_e2e_${String(process.pid)}`;
const TEST_DATABASE_URL = withDatabaseName(ADMIN_DATABASE_URL, TEST_DB);

const ADMIN_EMAIL = "e2e@music-manager.test";
const ADMIN_PASSWORD = "e2e-password-01";

/** The fixture downloads are a file copy; pace them fast so a run is a minute, not ten. */
const FIXTURE_DELAY_MS = "10";

const childEnv: Record<string, string> = {
  ...(process.env as Record<string, string>),
  DATABASE_URL: TEST_DATABASE_URL,
  MM_TOOLBOX_URL: TOOLBOX_URL,
  MM_FIXTURES: "1",
  MM_TOOLBOX_FIXTURES: "1",
  MM_TOOLBOX_FIXTURE_DELAY_MS: FIXTURE_DELAY_MS,
  MM_WEB_URL: BASE_URL,
  MM_ADMIN_EMAIL: ADMIN_EMAIL,
  MM_ADMIN_PASSWORD: ADMIN_PASSWORD,
  // Stable across runs so a session cookie kept between them stays valid.
  MM_AUTH_SECRET: "music-manager-e2e-secret-not-for-production",
  MM_LIBRARY_ROOT: join(repoRoot, ".local", "library", ".mm-e2e"),
  MM_TOOLBOX_LIBRARY_ROOT: "/library/.mm-e2e",
};

function say(message: string): void {
  console.log(`\n=== ${message} ===`);
}

/* ------------------------------------------------------------------ */
/* preflight                                                           */
/* ------------------------------------------------------------------ */

async function preflight(): Promise<void> {
  say("checking the stack");

  try {
    const response = await fetch(`${TOOLBOX_URL}/health`, { signal: AbortSignal.timeout(4000) });
    const body = (await response.json()) as { ok?: boolean; fixtures?: boolean };
    if (body.ok !== true) throw new Error("the toolbox is not healthy");
    if (body.fixtures !== true) {
      throw new Error(
        "the toolbox is not in fixtures mode — bring it up with:\n" +
          "  docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox",
      );
    }
    console.log(`toolbox ok on ${TOOLBOX_URL} (fixtures)`);
  } catch (error) {
    console.error(`no usable toolbox on ${TOOLBOX_URL}: ${describe(error)}`);
    process.exit(1);
  }

  try {
    const admin = new SQL(ADMIN_DATABASE_URL);
    await admin`select 1`;
    await admin.end();
    console.log(`postgres ok on ${ADMIN_DATABASE_URL.replace(/:[^:@]*@/, ":***@")}`);
  } catch (error) {
    console.error(`no postgres on ${ADMIN_DATABASE_URL}: ${describe(error)}`);
    process.exit(1);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* the database                                                        */
/* ------------------------------------------------------------------ */

async function resetDatabase(): Promise<void> {
  say(`recreating ${TEST_DB}`);
  await createFreshDatabase(ADMIN_DATABASE_URL, TEST_DB);

  await must("migrate", [bun, "run", join(webDir, "src", "server", "db", "migrate.ts")]);
  await must("seed the recorded sources", [
    bun,
    "run",
    join(webDir, "src", "server", "integrations", "seed-fixtures.ts"),
  ]);
}

async function must(label: string, cmd: string[]): Promise<void> {
  const [command, ...args] = cmd;
  if (command === undefined) throw new Error(`empty command for "${label}"`);
  const proc = Bun.spawn([command, ...args], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error(`\n"${label}" failed with exit code ${String(code)}.`);
    process.exit(code);
  }
}

/* ------------------------------------------------------------------ */
/* the processes under test                                            */
/* ------------------------------------------------------------------ */

const started: Bun.Subprocess[] = [];

function spawnBackground(label: string, cmd: string[], cwd: string): Bun.Subprocess {
  const [command, ...args] = cmd;
  if (command === undefined) throw new Error(`empty command for "${label}"`);
  const proc = Bun.spawn([command, ...args], {
    cwd,
    env: childEnv,
    stdio: ["ignore", "inherit", "inherit"],
  });
  started.push(proc);
  return proc;
}

/**
 * Stop only what this script started — **including its children**.
 *
 * `bun x vite` is a launcher that forks the real server, and on Windows killing a process does
 * not kill its descendants. Without the tree kill the Vite process outlives the run, keeps port
 * 3170, and the *next* run's server fails to bind and silently tests the stale one — which is
 * exactly as confusing as it sounds. Every pid below came from a `Bun.spawn` in this file, so
 * nothing else on the machine is ever touched.
 */
function stopEverything(): void {
  for (const proc of started) {
    const pid = proc.pid;
    try {
      if (process.platform === "win32" && pid > 0) {
        Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdio: [null, null, null] });
      }
      proc.kill();
    } catch {
      // Already gone; that is the outcome we wanted.
    }
  }
}

/** Nothing may already be on the port, or the run would test a server it did not start. */
async function portIsFree(): Promise<boolean> {
  try {
    await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

async function waitForHealth(timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      throw new Error(`the web app never answered ${BASE_URL}/health`);
    }
    await Bun.sleep(500);
  }
}

/* ------------------------------------------------------------------ */
/* playwright                                                          */
/* ------------------------------------------------------------------ */

/** Playwright's own CLI, run by Node. See the note at the top of this file. */
function playwrightCli(): string {
  const candidates = [
    join(repoRoot, "node_modules", "@playwright", "test", "cli.js"),
    join(webDir, "node_modules", "@playwright", "test", "cli.js"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (found === undefined) {
    console.error("@playwright/test is not installed. Run `bun install`.");
    process.exit(1);
  }
  return found;
}

async function runPlaywright(extra: string[]): Promise<number> {
  say("playwright");
  const proc = Bun.spawn(["node", playwrightCli(), "test", ...extra], {
    cwd: webDir,
    env: { ...childEnv, MM_E2E_BASE_URL: BASE_URL },
    stdio: ["inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

process.on("SIGINT", () => {
  stopEverything();
  process.exit(130);
});

await preflight();

if (!(await portIsFree())) {
  console.error(
    [
      `Something is already answering on ${BASE_URL}.`,
      "That is almost certainly a web server left behind by an interrupted run: this script",
      "would then test *it* rather than the one it starts, which is worse than failing.",
      "Stop it, or set MM_E2E_PORT to another port.",
    ].join("\n"),
  );
  process.exit(1);
}

await resetDatabase();

say(`starting the web app on ${BASE_URL} and the worker`);
spawnBackground("web", [bun, "x", "vite", "dev", "--port", String(PORT), "--strictPort"], webDir);
spawnBackground("worker", [bun, "run", join(webDir, "src", "worker", "index.ts")], repoRoot);

let code = 1;
try {
  await waitForHealth();
  console.log("the web app is up");
  code = await runPlaywright(process.argv.slice(2));
} catch (error) {
  console.error(describe(error));
  code = 1;
} finally {
  say("stopping what this script started");
  stopEverything();
  // Free the per-PID database rather than leaving it for the next run to trip over — with a
  // fresh port and database every time, there is no reason for one to survive its own run.
  if (process.env["MM_E2E_DB"] === undefined) {
    await dropDatabaseIfExists(ADMIN_DATABASE_URL, TEST_DB);
  }
}

process.exit(code);
