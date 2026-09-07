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
 * No imports, so the server entry can use it before anything else is loaded.
 */

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
