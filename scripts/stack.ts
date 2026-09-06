#!/usr/bin/env bun
/**
 * `bun run stack:up` / `stack:down` / `stack:info` — the containers **this checkout** owns.
 *
 * It is the same `docker-compose.dev.yml` everywhere; what changes is the project name, and
 * that is the whole point. Compose addresses containers by `<project>_<service>`, so two
 * checkouts running `docker compose up` without `-p` are two callers of the *same* container —
 * and since the file bind-mounts `./.local/library`, relative to whichever copy of the file was
 * used, the second caller silently recreates `mm-dev-toolbox-1` pointing at its own library.
 * That is the incident recorded in `orchestration/reports/P07-verify-1.md` §9. Every compose
 * call here goes through `composeArgs()`, which always passes `-p`.
 *
 * From `v2/` this behaves exactly as `docker compose -f docker-compose.dev.yml up -d` always
 * did: project `mm-dev`, postgres on 5432, toolbox on 8100, navidrome on 4533.
 *
 * From a worktree it brings up **only a toolbox of its own**, on a port derived from the slug,
 * mounting the worktree's `.local/library`; postgres stays shared, because a second postgres
 * would cost a gigabyte to hold one small database, and a database is free. That database
 * (`mm_<slug>`) is created and migrated here if it does not exist yet.
 *
 * Navidrome is not started for a worktree unless `--navidrome` is passed: it is a conformance
 * target, not a dependency of the app, and one scanner per worktree is a lot of scanning.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import {
  bun,
  capture,
  dockerIsRunning,
  ensureDatabase,
  repoRoot,
  resolveDocker,
  run,
  webDir,
} from "./lib.ts";
import { composeArgs, composeEnv, describeCheckout, devEnv, type DevEnv } from "./checkout.ts";

const READY_TIMEOUT_MS = 120_000;

function say(message: string): void {
  console.log(`\n=== ${message} ===`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `docker`, or a clear message and exit — every command here needs it. */
async function needDocker(): Promise<string> {
  const docker = resolveDocker();
  if (!docker) {
    console.error("docker not found. Install Docker Desktop, or run the app alone with:");
    console.error("  bun run --cwd apps/web dev   (does NOT load v2/.env — export it yourself)");
    process.exit(1);
  }
  if (!(await dockerIsRunning())) {
    console.error("The Docker daemon is not answering. Start Docker Desktop and try again.");
    process.exit(1);
  }
  return docker;
}

/* ------------------------------------------------------------------ */
/* waiting                                                             */
/* ------------------------------------------------------------------ */

async function waitFor(label: string, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await probe()) {
      console.log(`${label} is ready`);
      return;
    }
    if (Date.now() > deadline) {
      console.error(`${label} was not ready after ${String(READY_TIMEOUT_MS / 1000)}s.`);
      process.exit(1);
    }
    await Bun.sleep(1000);
  }
}

async function postgresAnswers(url: string): Promise<boolean> {
  try {
    const admin = new SQL(url);
    await admin`select 1`;
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

async function toolboxAnswers(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* up                                                                  */
/* ------------------------------------------------------------------ */

/**
 * Bring this checkout's stack up and leave it up. Returns the resolved environment so that
 * `bun run dev` can hand it straight to the web app.
 */
export async function stackUp(options: { navidrome?: boolean } = {}): Promise<DevEnv> {
  const resolved = devEnv({ preferPortless: process.env["PORTLESS_URL"] !== undefined });
  const info = resolved.checkout;
  const docker = await needDocker();

  console.log("\n=== this checkout ===");
  console.log(describeCheckout(resolved));

  // Docker creates a missing bind-mount source as root-owned on Linux; make it ours first.
  mkdirSync(info.libraryRoot, { recursive: true });

  const services = info.isPrimary
    ? []
    : ["toolbox", ...(options.navidrome === true ? ["navidrome"] : [])];

  say(`docker compose -p ${info.composeProject} up -d ${services.join(" ")}`.trim());
  const code = await run({
    label: "compose up",
    cmd: [docker, ...composeArgs(info), "up", "-d", ...services],
    env: { ...resolved.env, ...composeEnv(info) },
  });
  if (code !== 0) process.exit(code);

  if (info.isPrimary) {
    say("waiting for postgres to report healthy");
    await waitFor("postgres", async () => {
      const { stdout } = await capture({
        label: "postgres health",
        cmd: [docker, ...composeArgs(info), "ps", "--format", "json"],
        env: { ...resolved.env, ...composeEnv(info) },
      });
      // `compose ps --format json` emits either a JSON array or one object per line.
      return stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .some((line) => line.includes('"postgres"') && line.includes("healthy"));
    });
  } else {
    say("waiting for the shared postgres and this worktree's toolbox");
    if (resolved.adminDatabaseUrl === "") {
      console.error(
        `No DATABASE_URL. A worktree reads it from ${join(info.mainRoot, ".env")}; that file is\n` +
          "gitignored, so make sure the primary checkout has one, or add a .env here.",
      );
      process.exit(1);
    }
    await waitFor("postgres", () => postgresAnswers(resolved.adminDatabaseUrl));
    await waitFor("toolbox", () =>
      toolboxAnswers(resolved.env["MM_TOOLBOX_URL"] ?? "http://localhost:8100"),
    );
    await ensureWorktreeDatabase(resolved);
  }

  return resolved;
}

/**
 * `mm_<slug>`, created once and migrated on every `up` — the migration runner is idempotent,
 * and a worktree that has just pulled new migrations should not need a second command to be
 * usable.
 */
async function ensureWorktreeDatabase(resolved: DevEnv): Promise<void> {
  const name = new URL(resolved.databaseUrl).pathname.replace(/^\//, "");
  say(`database ${name}`);
  try {
    const created = await ensureDatabase(resolved.adminDatabaseUrl, name);
    console.log(created ? `created ${name}` : `${name} already exists`);
  } catch (error) {
    console.error(`could not create ${name}: ${describe(error)}`);
    process.exit(1);
  }

  const code = await run({
    label: "migrate",
    cmd: [bun, "run", join(webDir, "src", "server", "db", "migrate.ts")],
    cwd: repoRoot,
    env: resolved.env,
  });
  if (code !== 0) process.exit(code);
}

/* ------------------------------------------------------------------ */
/* down                                                                */
/* ------------------------------------------------------------------ */

async function stackDown(): Promise<void> {
  const resolved = devEnv();
  const info = resolved.checkout;
  const docker = await needDocker();
  say(`docker compose -p ${info.composeProject} down`);
  const code = await run({
    label: "compose down",
    cmd: [docker, ...composeArgs(info), "down"],
    env: { ...resolved.env, ...composeEnv(info) },
  });
  process.exit(code);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

// Only when run directly: `scripts/dev.ts` imports `stackUp` from here.
if (import.meta.main) {
  const command = process.argv[2] ?? "info";
  switch (command) {
    case "up":
      await stackUp({ navidrome: process.argv.includes("--navidrome") });
      break;
    case "down":
      await stackDown();
      break;
    case "info":
      console.log(describeCheckout(devEnv()));
      break;
    default:
      console.error(`unknown command "${command}". Use: up | down | info`);
      process.exit(2);
  }
}
