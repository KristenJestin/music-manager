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

/**
 * What kind of failure this is, when the failure itself did not say.
 *
 * `typed` is the good case and the only one that existed: an `MMError` arrived with a code, a
 * hint and an action, and the Console can quote all three. The other four are what the Console
 * used to render as *"Invariant failed / UNKNOWN"* — an untyped throw, classified by shape,
 * so that a person gets a sentence about what actually happened instead of a word from a
 * library's assertion helper.
 *
 *  - `aborted`  the request did not finish: the connection closed, or a deadline fired. This is
 *               the client's half of `server/http/abort.ts`, and the failure the owner's
 *               eleven-second match produced.
 *  - `offline`  `fetch` never got a connection at all: the browser is offline, or the Console
 *               is not running. A different sentence, because a different thing is wrong.
 *  - `server`   a 5xx with nothing else to say. The server failed; the browser did not.
 *  - `unknown`  anything else untyped. Still gets a sentence, never the word "UNKNOWN".
 */
export type FailureKind = "typed" | "aborted" | "offline" | "server" | "unknown";

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
  /** How the Console should talk about it when the failure did not carry a code. */
  readonly kind: FailureKind;
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

  const typed = text(body.code) ?? codeFromName(carrier?.name);
  const code = typed ?? "UNKNOWN";
  const bodyStatus = typeof body.status === "number" ? body.status : null;
  const status = bodyStatus ?? (typeof carrier?.status === "number" ? carrier.status : null);
  const kind = classify(typed, error, status);
  return {
    code,
    message: text(body.message) ?? text(carrier?.message) ?? "Something went wrong.",
    hint: text(body.hint),
    action: text(body.action),
    status,
    transient:
      TRANSIENT_CODES.has(code) ||
      (status !== null && status >= 500) ||
      kind === "aborted" ||
      kind === "offline",
    kind,
  };
}

/**
 * The shapes a browser uses to say "the request did not finish".
 *
 * Deliberately the mirror of `server/http/abort.ts`'s list, seen from the other end of the same
 * socket: `AbortError` from `fetch` and from `AbortSignal.timeout`, `TimeoutError` from the
 * latter in newer runtimes, and the sentences the three engines print. A router that cancels an
 * in-flight loader produces the first; a connection the server reclaimed produces the last.
 */
const ABORT_NAMES = new Set(["AbortError", "TimeoutError"]);
const ABORT_MESSAGES =
  /\b(?:aborted|the connection was closed|connection closed|the user aborted a request|signal is aborted|timed? ?out)\b/i;

/**
 * The shapes a browser uses to say "I never got a connection".
 *
 * Every engine words it differently and none of them gives a code: Chromium throws
 * `TypeError: Failed to fetch`, Firefox `TypeError: NetworkError when attempting to fetch
 * resource.`, Safari `TypeError: Load failed`, and undici `TypeError: fetch failed`. The
 * `TypeError` is as close to a marker as the platform offers, so the name is required and the
 * message narrows it — a `TypeError` about something else is a bug, not a network problem.
 */
const OFFLINE_MESSAGES =
  /\b(?:failed to fetch|fetch failed|networkerror|load failed|network request failed|err_(?:network|connection|internet)\w*)\b/i;

function classify(typed: string | null, error: unknown, status: number | null): FailureKind {
  if (typed !== null) return "typed";

  const carrier = error as { name?: unknown; message?: unknown } | null;
  const name = typeof carrier?.name === "string" ? carrier.name : "";
  const message = typeof carrier?.message === "string" ? carrier.message : "";

  if (ABORT_NAMES.has(name) || ABORT_MESSAGES.test(message)) return "aborted";
  if (name === "TypeError" && OFFLINE_MESSAGES.test(message)) return "offline";
  if (status !== null && status >= 500) return "server";
  return "unknown";
}

/**
 * Messages that look like a sentence and are not one.
 *
 * `tiny-invariant` strips its message in a production build and throws the literal string
 * *"Invariant failed"* — which is what the owner read, in a panel headed "This page could not
 * be loaded", above the word UNKNOWN. It says nothing about what broke, and printing it is
 * worse than printing nothing, because it invites the reader to look for an "invariant".
 * TanStack Router's own default panel contributes the second entry.
 */
const NO_INFORMATION = new Set([
  "invariant failed",
  "something went wrong.",
  "something went wrong!",
  "assertion failed",
  "error",
]);

/** True when the failure's message tells a reader nothing at all. */
export function isUninformative(message: string): boolean {
  return NO_INFORMATION.has(message.trim().toLowerCase());
}

/**
 * What a person should be told, per kind — the fallback the error screen had none of.
 *
 * It lives here rather than in the component for two reasons: it is the same vocabulary as
 * `MMError`'s `message`/`hint`/`action`, so it belongs next to the decoder that produces those;
 * and a sentence is worth a unit test, which is much cheaper on a pure function than on a
 * component that needs a router.
 *
 * `label` is what goes on the monospace line under the message. `null` means "print nothing":
 * a code is a thing to quote into a bug report, and `UNKNOWN` is not one — it is the decoder
 * admitting it has no code, which is a fact about the decoder and not about the failure.
 */
export interface FailureCopy {
  readonly message: string;
  readonly hint: string;
  readonly action: string;
  readonly label: string | null;
}

export function describeFailure(failure: ReadableFailure): FailureCopy {
  switch (failure.kind) {
    case "typed":
      return {
        message: failure.message,
        hint: failure.hint ?? "",
        action: failure.action ?? "Retry",
        label: failureLabel(failure),
      };
    case "aborted":
      return {
        message: "The connection closed before the server answered.",
        hint:
          "The page was still loading when the connection dropped — usually because the work " +
          "took longer than the connection stayed open, or because the network moved underneath " +
          "it. Nothing was written, so asking again is safe.",
        action: "Try again",
        label: "Connection interrupted",
      };
    case "offline":
      return {
        message: "Music Manager could not be reached.",
        hint:
          "The browser could not open a connection at all. Check that you are online and that " +
          "the server is still running, then try again.",
        action: "Try again",
        label: "Network unavailable",
      };
    case "server":
      return {
        message: isUninformative(failure.message)
          ? "The server failed while loading this page."
          : failure.message,
        hint:
          "The failure is on the server, not in this browser. Its journal holds the line it " +
          "logged, with the path and the moment.",
        action: "Try again",
        label:
          failure.status === null
            ? "Server error"
            : `Server error (HTTP ${String(failure.status)})`,
      };
    case "unknown":
      return {
        message: isUninformative(failure.message)
          ? "This page's data could not be read."
          : failure.message,
        hint:
          "No error code reached the browser, which usually means the answer itself was " +
          "unreadable. The server's journal holds the full line.",
        action: "Try again",
        label: null,
      };
  }
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
