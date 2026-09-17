/**
 * One JSON line per request, on stdout (`docs/phases/P10-production.md` § Exploitation:
 * *logs JSON sur stdout des trois services ; niveau configurable*).
 *
 * The three services now agree on a shape. The toolbox emits `structlog` JSON, the worker
 * already prints `{at, source: "worker", message, …}` (`src/worker/index.ts`), and this is the
 * web's half: `{at, source: "web", level, msg, method, path, status, ms}`. `docker compose
 * logs` therefore produces something a `jq` filter can read across all three, which is the
 * whole point — a self-hosted operator's observability budget is `docker logs | jq`.
 *
 * `ms` is the server's own time-to-response, so the SSR budget of `docs/phases/P06-web-coeur.md`
 * ("< 300 ms") is measurable in production from the logs alone rather than from a stopwatch on
 * the far side of a proxy.
 *
 * Pure, and its one import is pure too, so the server entry can use it before anything else is
 * loaded and a test can exercise it without a router, a database or an environment.
 */
import { CLIENT_CLOSED } from "#/server/http/abort.ts";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Parse `MM_LOG_LEVEL`. Anything unrecognised is `info`, which is the safe default. */
export function logLevel(source: Record<string, string | undefined>): LogLevel {
  const raw = (source["MM_LOG_LEVEL"] ?? "").trim().toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : "info";
}

export function enabled(level: LogLevel, at: LogLevel): boolean {
  return ORDER[at] >= ORDER[level];
}

export interface AccessLine {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly ms: number;
}

/**
 * The level a request is logged at.
 *
 * A build asset or a favicon at `info` would bury the twenty lines an operator actually wants
 * under two hundred; a 5xx is an `error` whatever the configured floor, because that is the
 * line someone is grepping for.
 */
export function levelFor(line: AccessLine): LogLevel {
  /*
   * A client that hung up is `info`, and that is the point of the status existing.
   *
   * Before this, a request whose connection Bun reclaimed at ten seconds escaped as an
   * `AbortError`, was turned into a 500 by the framework, and was logged at `error` with the
   * duration of the work that had just been thrown away. Three of those a day is an error rate
   * that means nothing, on a page that is behaving exactly as designed. The disconnection is
   * still worth a line — it is how an operator sees that something is taking too long — but it
   * is not a failure of this server, so it is not filed as one.
   */
  if (line.status === CLIENT_CLOSED) return "info";
  if (line.status >= 500) return "error";
  if (line.status >= 400) return "warn";
  if (line.path.startsWith("/_build/") || line.path.startsWith("/@")) return "debug";
  return "info";
}

/** The line itself, as the string that goes to stdout. Pure, so a test can assert on it. */
export function accessLine(line: AccessLine, now: Date = new Date()): string {
  return JSON.stringify({
    at: now.toISOString(),
    source: "web",
    level: levelFor(line),
    msg: "request",
    method: line.method,
    path: line.path,
    status: line.status,
    ms: line.ms,
  });
}

/** Write it, if the configured level lets it through. */
export function logAccess(level: LogLevel, line: AccessLine): void {
  if (!enabled(level, levelFor(line))) return;
  console.log(accessLine(line));
}
