/**
 * `bun run dev` — bring the dev stack up, then run the web app.
 *
 * Postgres, Navidrome and the toolbox run in Docker; only the web app runs on the host so
 * that HMR works. Ctrl-C stops the web app and leaves the containers running.
 *
 * The port is `PORT`, default 3000. It stopped being a constant because `:3000` on this
 * machine belongs to an unrelated project as often as not, and because several agents share
 * the host (`CLAUDE.md`'s process-safety note): `PORT=3100 bun run dev` is the normal way to
 * get a server of your own.
 *
 * `.env` is read here and handed to the child explicitly. Bun loads `.env` from the *current
 * directory*, so it happens to be loaded for this script — and is silently **not** loaded by
 * `bun run --cwd apps/web dev`, whose cwd is `apps/web`. That asymmetry is the reason the app
 * behaves differently depending on how you start it, so this script stops relying on it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bunRun, capture, dockerIsRunning, repoRoot, resolveDocker, run, webDir } from "./lib.ts";

const COMPOSE_FILE = "docker-compose.dev.yml";
const READY_TIMEOUT_MS = 120_000;
const PORT = process.env["PORT"] ?? "3000";

/**
 * `KEY=value` pairs from `v2/.env`, minus comments, blanks and surrounding quotes.
 *
 * Deliberately small: this is the same subset `.env.example` documents, and a script that
 * grew a full dotenv parser would be a script that disagreed with Bun's own about something.
 */
function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    if (key === undefined) continue;
    const trimmed = (match[2] ?? "").trim();
    values[key] = /^(".*"|'.*')$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  }
  return values;
}

/** The real environment wins over the file, so `MM_FIXTURES=0 bun run dev` means what it says. */
const fileEnv = readDotEnv(join(repoRoot, ".env"));
const childEnv: Record<string, string> = {
  ...fileEnv,
  ...(process.env as Record<string, string>),
  PORT,
};

/**
 * `MM_WEB_URL` follows the port unless someone has said otherwise.
 *
 * Better Auth checks the browser's origin against it (`server/auth/auth.ts`, `trustedOrigins`)
 * and it defaults to `http://localhost:3000`. So moving the app to another port without moving
 * this too gets you a login form that renders perfectly and answers **“Invalid origin”** — a
 * long way from anything that mentions ports. Deriving it here means `PORT=3100 bun run dev`
 * is one decision, not two. An explicit value, in the environment or in `.env`, still wins:
 * that is the reverse-proxy case, where the browser's origin is not localhost at all.
 */
if (process.env["MM_WEB_URL"] === undefined && fileEnv["MM_WEB_URL"] === undefined) {
  childEnv["MM_WEB_URL"] = `http://localhost:${PORT}`;
}

const docker = resolveDocker();
if (!docker) {
  console.error("docker not found. Install Docker Desktop, or run the app alone with:");
  console.error("  bun run --cwd apps/web dev");
  console.error("note: that command does NOT load v2/.env (Bun reads .env from the cwd, which");
  console.error("      is apps/web there). Export the variables yourself, or use `bun run dev`.");
  process.exit(1);
}

if (!(await dockerIsRunning())) {
  console.error("The Docker daemon is not answering. Start Docker Desktop and try again.");
  process.exit(1);
}

console.log(`=== docker compose -f ${COMPOSE_FILE} up -d ===`);
const up = await run({
  label: "compose up",
  cmd: [docker, "compose", "-f", COMPOSE_FILE, "up", "-d"],
});
if (up !== 0) process.exit(up);

console.log("=== waiting for postgres to report healthy ===");
const deadline = Date.now() + READY_TIMEOUT_MS;
for (;;) {
  const { stdout } = await capture({
    label: "postgres health",
    cmd: [docker, "compose", "-f", COMPOSE_FILE, "ps", "--format", "json"],
    cwd: repoRoot,
  });
  // `compose ps --format json` emits either a JSON array or one object per line.
  const healthy = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .some((line) => line.includes('"postgres"') && line.includes("healthy"));
  if (healthy) break;
  if (Date.now() > deadline) {
    console.error(`postgres was not healthy after ${READY_TIMEOUT_MS / 1000}s; check the logs:`);
    console.error(`  docker compose -f ${COMPOSE_FILE} logs postgres`);
    process.exit(1);
  }
  await Bun.sleep(1000);
}
console.log("postgres is healthy");

console.log(`=== apps/web dev server on http://localhost:${PORT} ===`);
process.exit(await run({ label: "web dev", cmd: bunRun(webDir, "dev"), env: childEnv }));
