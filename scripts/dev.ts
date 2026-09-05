/**
 * `bun run dev` — bring the dev stack up, then run the web app on http://localhost:3000.
 *
 * Postgres, Navidrome and the toolbox run in Docker; only the web app runs on the host so
 * that HMR works. Ctrl-C stops the web app and leaves the containers running.
 */
import { bunRun, capture, dockerIsRunning, repoRoot, resolveDocker, run, webDir } from "./lib.ts";

const COMPOSE_FILE = "docker-compose.dev.yml";
const READY_TIMEOUT_MS = 120_000;

const docker = resolveDocker();
if (!docker) {
  console.error("docker not found. Install Docker Desktop, or run the app alone with:");
  console.error("  bun run --cwd apps/web dev");
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

console.log("=== apps/web dev server on http://localhost:3000 ===");
process.exit(await run({ label: "web dev", cmd: bunRun(webDir, "dev") }));
