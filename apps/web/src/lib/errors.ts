/**
 * Reading a failure back on the client.
 *
 * `server/functions/base.ts`'s `toFailure` attaches the whole `MMError` body — `code`,
 * `message`, `hint`, `action`, `details`, `status` — to the `Error` it rethrows, precisely so
 * the Console can offer a sentence and a button instead of a stack trace. Until now nothing
 * read it: every catch site did `error instanceof Error ? error.message : "…"` and threw the
 * other four fields away, and a loader that rejected reached TanStack Router's built-in panel,
 * which replaces the entire document with *"Something went wrong!"* and the bare message. That
 * is what the owner saw on 2026-09-08 — a whole Console replaced by
 * *"musicbrainz answered HTTP 503."* mid-import.
 *
 * This module is the other half of `toFailure`, and it lives in `lib/` rather than next to it
 * because it has to reach the browser: it imports nothing, not even at type level anything
 * that carries a runtime value, so `client-boundary.guard.test.ts` stays satisfied.
 */

/** A failure as the Console can use it: never `undefined` where a sentence is expected. */
export interface ReadableFailure {
  readonly code: string;
  readonly message: string;
  readonly hint: string | null;
  /** What the user can do about it, in the source's own words. */
  readonly action: string | null;
  /** The HTTP status, when the failure arrived over one. */
  readonly status: number | null;
  /** True for the codes that mean "the outside world, not you, and probably not for long". */
  readonly transient: boolean;
}

/**
 * The codes that describe an external source rather than this application.
 *
 * They share one property that matters to the UI: **Retry is a real answer**. Everything else
 * — a bad identifier, a missing session, an invalid payload — does not get better by asking
 * again, so offering a Retry button for those would be a lie.
 */
const TRANSIENT_CODES = new Set([
  "SOURCE_UNAVAILABLE",
  "SOURCE_RATE_LIMITED",
  "SOURCE_UNREACHABLE",
  "TOOLBOX_UNREACHABLE",
  "NAVIDROME_UNREACHABLE",
  "NAVIDROME_SCAN_TIMEOUT",
  "TIMEOUT",
  "RATE_LIMITED",
  "LOCKED",
]);

interface WireFailure {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly hint?: unknown;
  readonly action?: unknown;
  readonly status?: unknown;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * An `Error.name` that is one of our codes rather than a JavaScript one.
 *
 * `toFailure` writes the code there as well as into `mm`, so a failure that arrives with its
 * custom properties stripped — anything that has been through a structured clone, a log, a
 * `new Error(String(cause))` — still says what kind of failure it was. `Error`, `TypeError`,
 * `RangeError` and friends are not codes, and neither is anything in mixed case, so the shape
 * is the test: screaming snake case only.
 *
 * It does **not** rescue the SSR case: the router inlines a rejected loader's error as its
 * message alone, and nothing else comes through. That is measured in `e2e/mb-outage.spec.ts`
 * and is why the wizard carries a source outage in its loader data instead.
 */
function codeFromName(value: unknown): string | null {
  const name = text(value);
  return name !== null && /^[A-Z][A-Z0-9_]*$/.test(name) && name !== "ERROR" ? name : null;
}

/**
 * Anything thrown, as something renderable.
 *
 * Three shapes arrive here and all three are handled without a branch the caller can see: the
 * `Error` with `mm` that a server function rejected with, an `MMError` thrown in the same
 * process (SSR), and a plain `Error` from anywhere else.
 */
export function readFailure(error: unknown): ReadableFailure {
  const carrier = error as {
    mm?: WireFailure;
    status?: unknown;
    message?: unknown;
    name?: unknown;
  } | null;
  const body: WireFailure = carrier?.mm ?? (carrier as WireFailure | null) ?? {};

  const code = text(body.code) ?? codeFromName(carrier?.name) ?? "UNKNOWN";
  const status = typeof body.status === "number" ? body.status : null;
  return {
    code,
    message: text(body.message) ?? text(carrier?.message) ?? "Something went wrong.",
    hint: text(body.hint),
    action: text(body.action),
    status: status ?? (typeof carrier?.status === "number" ? carrier.status : null),
    transient: TRANSIENT_CODES.has(code) || (status !== null && status >= 500),
  };
}

/**
 * "The outside world", as opposed to "this request was wrong".
 *
 * The distinction decides two behaviours, on both sides of the wire: whether a failed loader
 * keeps its page (a source outage) or hands over to the error boundary (a bug or a bad id),
 * and whether Retry is offered at all. `NOT_FOUND` retried is `NOT_FOUND` again, slower.
 */
export function isSourceOutage(error: unknown): boolean {
  const code = readFailure(error).code;
  return (
    code === "SOURCE_UNAVAILABLE" || code === "SOURCE_RATE_LIMITED" || code === "SOURCE_UNREACHABLE"
  );
}

/** `SOURCE_UNAVAILABLE (HTTP 503)` — the one line a reader can quote into a bug report. */
export function failureLabel(failure: ReadableFailure): string {
  return failure.status === null
    ? failure.code
    : `${failure.code} (HTTP ${String(failure.status)})`;
}
