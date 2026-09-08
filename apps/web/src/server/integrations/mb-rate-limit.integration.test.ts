/**
 * The one-request-per-second rule, proven across **processes** (decision 164).
 *
 * The old limiter lived in a module variable, which is the right shape for a library and the
 * wrong one for this application: the Console, the worker and `mm` each held their own, so a
 * user importing an album while the worker re-tagged and an MCP session poked around sent two
 * or three requests a second under a single User-Agent. MusicBrainz answered 503, and the
 * wizard — whose loader had no error boundary — turned that into a blank Console. That is the
 * incident of 2026-09-08 and this file is the half of the fix that no unit test can state:
 * a limiter shared by two processes is a claim about two processes.
 *
 * So: a stub MusicBrainz that writes down when each request arrived, two `bun` children that
 * know nothing about each other, and one arithmetic assertion over the arrival times.
 *
 * Needs a postgres, like its neighbours in `services/`. It creates and drops a database of its
 * own name, never one it did not create (`CLAUDE.md` § Worktrees).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const PROBE = join(HERE, "mb-rate-limit.probe.ts");

const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://mm:mm@localhost:5432/mm";
const BASE_DB = /\/([^/?]+)(\?|$)/.exec(BASE_URL)?.[1] ?? "mm";
/** Its own database, like every other integration suite: vitest runs files in parallel. */
const TEST_DB = `${BASE_DB}_mbrate`;
const TEST_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, `/${TEST_DB}$1`);

async function postgresIsUp(): Promise<string | null> {
  try {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin`select 1`;
    await admin.end();
    return null;
  } catch {
    return `no postgres on ${BASE_URL}`;
  }
}

const unavailable = await postgresIsUp();
if (unavailable !== null) {
  console.log(`  (MusicBrainz shared-limiter tests skipped: ${unavailable})`);
}

/* ------------------------------------------------------------------ */
/* the stub MusicBrainz                                                */
/* ------------------------------------------------------------------ */

interface Stub {
  readonly url: string;
  /** One entry per request, in arrival order, as `Date.now()`. */
  readonly arrivals: number[];
  /** Answer the next `n` requests with 503 and this `Retry-After`, in seconds. */
  refuse(times: number, retryAfterSeconds: number): void;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const arrivals: number[] = [];
  let refusals = 0;
  let retryAfter = 0;

  const handler = (_request: IncomingMessage, response: ServerResponse): void => {
    arrivals.push(Date.now());
    if (refusals > 0) {
      refusals -= 1;
      response.writeHead(503, {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      });
      response.end(JSON.stringify({ error: "slow down" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ releases: [] }));
  };

  const server: Server = createServer(handler);
  await new Promise<void>((done) => {
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    arrivals,
    refuse(times, retryAfterSeconds) {
      refusals = times;
      retryAfter = retryAfterSeconds;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

/**
 * Where `bun` is, without a shell.
 *
 * Node on Windows cannot run a `.cmd` shim without `shell: true`, and `shell: true` would put
 * the arguments through cmd's quoting rules for no benefit. Bun ships a real `bun.exe`, so the
 * only question is whether PATH is enough; `BUN_INSTALL` is the fallback for the case where a
 * runner inherited a trimmed environment.
 */
function bunExecutable(): string {
  const home = process.env["BUN_INSTALL"] ?? join(process.env["USERPROFILE"] ?? "", ".bun");
  const candidate = join(home, "bin", process.platform === "win32" ? "bun.exe" : "bun");
  return existsSync(candidate) ? candidate : "bun";
}

/** The smallest interval between two consecutive arrivals. */
function minimumGap(arrivals: readonly number[]): number {
  const sorted = [...arrivals].sort((a, b) => a - b);
  let smallest = Infinity;
  for (let n = 1; n < sorted.length; n += 1) {
    smallest = Math.min(smallest, (sorted[n] ?? 0) - (sorted[n - 1] ?? 0));
  }
  return smallest;
}

describe.skipIf(unavailable !== null)("the MusicBrainz limiter, across processes", () => {
  let stub: Stub;

  beforeAll(async () => {
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.unsafe(`create database ${TEST_DB}`);
    await admin.end();

    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(TEST_URL, { max: 1 });
    await migrate(drizzle(client), { migrationsFolder: join(REPO_ROOT, "apps/web/drizzle") });
    await client.end();

    stub = await startStub();
  }, 120_000);

  afterAll(async () => {
    await stub.close();
    const admin = postgres(BASE_URL, { max: 1, onnotice: () => undefined });
    // By its exact name, the one this file created. Never by pattern (CLAUDE.md).
    await admin.unsafe(`drop database if exists ${TEST_DB} with (force)`);
    await admin.end();
  }, 60_000);

  /**
   * The headline claim, and the acceptance criterion of the fix.
   *
   * Two processes, three requests each, started together. Six requests spaced by a second is
   * five seconds; the tolerance is on the *floor* only — a slow machine may space them further
   * apart, and that is still correct. Anything under a second is the bug.
   */
  it("never sends two requests within a second, whichever process asked", async () => {
    stub.arrivals.length = 0;

    /*
     * `node:child_process`, not `Bun.spawn`: vitest runs under Node here, and `CLAUDE.md`'s
     * runtime-portability rule keeps `Bun.*` out of `apps/web/src/**` for exactly this reason.
     * The *children* are `bun`, which is what the probe needs.
     */
    const run = (label: string): Promise<number> =>
      new Promise((done, fail) => {
        const child = spawn(bunExecutable(), ["run", PROBE, stub.url, "3", label], {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: TEST_URL },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", fail);
        child.on("close", (code) => {
          if (code !== 0 && stderr !== "") console.error(`probe ${label}: ${stderr}`);
          done(code ?? -1);
        });
      });

    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(a).toBe(0);
    expect(b).toBe(0);

    expect(stub.arrivals.length).toBe(6);
    /*
     * 850 ms, not 1000, and the slack is on purpose.
     *
     * The rule is enforced on the *departure* instant; what the stub timestamps is the
     * arrival, one loopback hop and one HTTP parse later. Those hops are not equal — the first
     * request of a connection pays a TCP handshake the next ones do not — so a pair of
     * departures exactly a second apart can arrive 940 ms apart, which is what this assertion
     * measured the first time it ran beside a full `bun run check`.
     *
     * The slack costs nothing, because the two hypotheses are nowhere near each other: with a
     * limiter per process these six requests arrive in two bursts of three, minimum gap ~0 ms.
     * That is the failure this test saw when it was checked against the old code, and 850 ms
     * separates it from 1000 with room for any machine.
     */
    expect(minimumGap(stub.arrivals)).toBeGreaterThanOrEqual(850);
    // And the run as a whole took the five seconds six paced requests cost.
    expect(Math.max(...stub.arrivals) - Math.min(...stub.arrivals)).toBeGreaterThanOrEqual(4_500);
  }, 120_000);

  /**
   * `Retry-After` collected by one process is honoured by the others.
   *
   * Two database handles rather than two children: what makes a process "another process" as
   * far as this rule is concerned is that it has its own connection and its own in-memory
   * limiter, and `createDatabase` twice gives exactly that. The claim is about the row in
   * `source_rate_limit`, and this states it in two seconds instead of thirty.
   */
  it("holds every process back when one of them is told to slow down", async () => {
    stub.arrivals.length = 0;
    stub.refuse(1, 3);

    const { createDatabase } = await import("#/server/db/client.ts");
    const { gateFor } = await import("./rate-gate.ts");
    const { getJson } = await import("./http.ts");
    const { resetLimiters } = await import("./http.ts");
    resetLimiters();

    const first = createDatabase(TEST_URL, 1);
    const second = createDatabase(TEST_URL, 1);

    // Process one walks into the 503 and takes the penalty on everybody's behalf.
    await expect(
      getJson({
        source: "musicbrainz",
        url: `${stub.url}/ws/2/release?probe=refused`,
        gate: gateFor(first, "musicbrainz", 1_000),
        attempts: 1,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503 });

    // Process two knows nothing about it, and still waits.
    resetLimiters();
    const started = Date.now();
    await gateFor(second, "musicbrainz", 1_000).acquire();
    const waited = Date.now() - started;

    expect(waited).toBeGreaterThanOrEqual(2_500);
  }, 60_000);
});
