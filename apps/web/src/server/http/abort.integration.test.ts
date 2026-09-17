/**
 * The bug, reproduced against a real `Bun.serve`, and the fix, measured against the same one.
 *
 * ## Why this test is shaped like this
 *
 * Production serves every request through Nitro's **bun** preset: `bun .output/server/index.mjs`
 * reaches `Bun.serve()` through `srvx/bun`, which passes no options of its own. `Bun.serve()`'s
 * `idleTimeout` therefore keeps its default of **ten seconds**, and a connection on which no
 * byte has moved for ten seconds is closed by the server. A server function computes for ten or
 * fifteen seconds and writes its body once, at the end, so it is idle for the whole of it.
 *
 * Nothing else in this repository can see that. `bun run dev` serves SSR under Node (`vite dev`
 * is a `#!/usr/bin/env node` bin), Playwright drives that same dev server, and vitest runs under
 * Node too — `globalThis.Bun` is `undefined` in this very file. That is exactly why the bug only
 * ever appeared in production, and it is why this test **spawns a real Bun** instead of asserting
 * about one.
 *
 * The spawned server is deliberately minimal and deliberately *not* the app: what is under test
 * is the runtime's behaviour and `extendRequestTimeout`'s effect on it, and an app in the way
 * would only add ways for the measurement to be wrong. `idleTimeout: 1` stands in for the
 * ten-second default so the whole thing costs seconds rather than a minute; the mechanism is the
 * same one, and `server/http/abort.ts` records the ten-second measurement it was derived from.
 *
 * `request.runtime.bun.server` is attached the way `srvx/bun` attaches it. That shape is the one
 * assumption this cannot verify from here, so it was verified where it matters instead: a
 * production `vite build`, run with `bun .output/server/index.mjs`, reports `hasRuntime: true,
 * hasServer: true, hasTimeout: "function"` on a real request, and a fifteen-second response
 * comes back `200` in 15.75 s with the lever and dies at 10.99 s without it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/** The module under test, as a URL the spawned Bun can import. Bun reads TypeScript directly. */
const ABORT_MODULE = new URL("./abort.ts", import.meta.url).href;

/** Longer than the server's idle timeout, short enough that the suite stays a suite. */
const WORK_MS = 6_000;
const IDLE_S = 1;
/**
 * Bun rounds the idle timeout up to its own timer granularity — roughly four seconds at the
 * bottom of the range, which is why the default of ten fires at about eleven. `WORK_MS` is
 * therefore comfortably past the *observed* deadline, not past the configured one.
 */
const OBSERVED_DEADLINE_MS = 4_500;

/** The access log, so the third case can assert on the line an operator would grep. */
const LOG_MODULE = new URL("./log.ts", import.meta.url).href;

/**
 * What the spawned server does with a request.
 *
 *  - `bare`    sleep past the deadline and answer. The runtime's behaviour, nothing else.
 *  - `lever`   the same, after `extendRequestTimeout` — the real one, from the real module.
 *  - `entry`   the shape `src/server-entry.ts` now has: sleep, `throwIfAborted` (which is what
 *              the framework does, and what the owner's production stack trace shows), then
 *              catch, classify and log. This is the case that proves a disconnection does not
 *              become a 500.
 */
type Mode = "bare" | "lever" | "entry";

function serverSource(port: number, mode: Mode): string {
  const body =
    mode === "entry"
      ? `
        const started = Date.now();
        try {
          await Bun.sleep(${String(WORK_MS)});
          // Precisely what the framework does, and what the owner's stack trace shows at the
          // top of the throw: \`throwIfAborted@[native code]\`.
          request.signal.throwIfAborted();
          return new Response("late but fine");
        } catch (error) {
          if (!isClientAbort(error, request)) throw error;
          logAccess("info", {
            method: request.method,
            path: new URL(request.url).pathname,
            status: CLIENT_CLOSED,
            ms: Date.now() - started,
          });
          return new Response(null, { status: CLIENT_CLOSED });
        }`
      : `
        ${mode === "lever" ? `extendRequestTimeout(request, 60);` : ``}
        await Bun.sleep(${String(WORK_MS)});
        return new Response(JSON.stringify({ ok: true, aborted: request.signal.aborted }), {
          headers: { "content-type": "application/json" },
        });`;

  return `
    const { extendRequestTimeout, isClientAbort, CLIENT_CLOSED } =
      await import(${JSON.stringify(ABORT_MODULE)});
    const { logAccess } = await import(${JSON.stringify(LOG_MODULE)});
    const server = Bun.serve({
      port: ${String(port)},
      idleTimeout: ${String(IDLE_S)},
      async fetch(request, bun) {
        // Exactly how srvx/bun hands the Bun server to the application.
        Object.defineProperty(request, "runtime", { value: { bun: { server: bun } } });
        ${body}
      },
    });
    console.log("ready " + String(server.port));
  `;
}

interface Spawned {
  readonly process: ChildProcess;
  readonly port: number;
  /** Everything the child has printed, so a test can read the access line it emitted. */
  lines(): readonly string[];
}

let running: ChildProcess | null = null;

afterEach(() => {
  // Only ever the child this file started, and only by the handle it holds: never by name and
  // never by a command-line pattern (`AGENTS.md` — this machine runs several agents at once).
  running?.kill();
  running = null;
});

/** The `bun` to spawn. `MM_BUN_BIN` is the escape hatch for a machine where it is not on PATH. */
const BUN = process.env["MM_BUN_BIN"] ?? "bun";

/** A port per mode, high and specific, so two suites on one machine cannot collide. */
const PORTS: Record<Mode, number> = { bare: 39_861, lever: 39_862, entry: 39_863 };

async function startServer(mode: Mode): Promise<Spawned> {
  const port = PORTS[mode];
  const child = spawn(BUN, ["-e", serverSource(port, mode)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  running = child;
  const printed: string[] = [];

  await new Promise<void>((ready, fail) => {
    const timer = setTimeout(() => {
      fail(new Error("the spawned Bun never said it was listening"));
    }, 20_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      printed.push(...chunk.toString().split("\n").filter(Boolean));
      if (chunk.toString().includes("ready")) {
        clearTimeout(timer);
        ready();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`the spawned Bun exited with ${String(code)} before listening`));
    });
  });

  return { process: child, port, lines: () => printed };
}

/** Wait for the child to print a line the predicate likes. Its work outlives the request. */
async function waitForLine(
  spawned: Spawned,
  matches: (line: string) => boolean,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = spawned.lines().find(matches);
    if (found !== undefined) return found;
    await new Promise((tick) => setTimeout(tick, 100));
  }
  return null;
}

/** What `curl` saw, in the two shapes that matter: an answer, or a socket that closed. */
async function ask(port: number): Promise<{ status: number | null; ms: number }> {
  const started = Date.now();
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/`);
    await response.text();
    return { status: response.status, ms: Date.now() - started };
  } catch {
    return { status: null, ms: Date.now() - started };
  }
}

/**
 * Skip rather than fail where there is no Bun to spawn.
 *
 * The same rule as every other integration test in this repository: a suite that cannot see
 * what it is about says so and steps aside, rather than turning a missing tool into a red build.
 * Under `bun run check` this is always true, because `check` is run by Bun.
 */
const available = spawnSync(BUN, ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!available)("a request slower than the connection's idle timeout", () => {
  it("is killed mid-flight when nothing raises the ceiling", async () => {
    /*
     * The control, and the owner's production log in miniature. `status: null` is the socket
     * closing with no response on it at all — `curl` calls this exit 52, "empty reply from
     * server", and a browser calls it a failed fetch. The handler goes on working into nothing
     * and then throws `AbortError: The connection was closed.`, which Nitro turns into the 500
     * that was recorded against the installation.
     */
    const { port } = await startServer("bare");
    const answer = await ask(port);
    expect(answer.status).toBeNull();
    expect(answer.ms).toBeLessThan(WORK_MS);
    expect(answer.ms).toBeLessThan(OBSERVED_DEADLINE_MS + 1_000);
  }, 30_000);

  it("completes when the entry raises it, which is what the entry now does", async () => {
    const { port } = await startServer("lever");
    const answer = await ask(port);
    expect(answer.status).toBe(200);
    // It really did take longer than the idle timeout: the test is measuring the right thing.
    expect(answer.ms).toBeGreaterThanOrEqual(WORK_MS - 100);
  }, 30_000);

  it("is logged at info as 499 when it does happen, and never as a 500", async () => {
    /*
     * The other half of the fix, and the half that matters to an operator's error rate.
     *
     * A disconnection will still happen — a reload, an Escape, a tab closed — and a client that
     * went away is not a failure of this server. Before, it escaped the handler, Nitro turned it
     * into a 500, and `levelFor` filed that at `error`: the owner's production log reads
     * `{"level":"error","status":500,"ms":11316}` for a page that was behaving as designed.
     *
     * Now the same event produces one `info` line at 499, with the path and the duration, and no
     * 500 anywhere. The response is never read — the socket it would travel on is closed, which
     * is the whole point — so what is asserted here is the *log*.
     */
    const spawned = await startServer("entry");
    const answer = await ask(spawned.port);
    expect(answer.status).toBeNull();

    // The handler outlives the request: give it until past its own sleep to print.
    const line = await waitForLine(spawned, (text) => text.includes(`"msg":"request"`), 15_000);
    expect(line).not.toBeNull();

    const logged = JSON.parse(line ?? "{}") as Record<string, unknown>;
    expect(logged["level"]).toBe("info");
    expect(logged["status"]).toBe(499);
    expect(logged["path"]).toBe("/");
    expect(logged["method"]).toBe("GET");
    expect(logged["ms"]).toBeGreaterThanOrEqual(WORK_MS - 100);
    // Nothing anywhere said 500.
    expect(spawned.lines().join("\n")).not.toContain(`"status":500`);
    expect(spawned.lines().join("\n")).not.toContain(`"level":"error"`);
  }, 40_000);
});
