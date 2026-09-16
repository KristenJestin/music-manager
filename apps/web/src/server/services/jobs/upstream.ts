/**
 * Was that a refusal from upstream, or a defect in this import?
 *
 * The 45 albums of the 375-playlist session are the reason this file exists. MusicBrainz
 * answered 503 "busy" to the `match` step; `http.ts` retried three times, gave up, and the
 * `MMError` it threw reached `runStep`, which knows exactly one thing to do with a thrown
 * step — `status: "failed"`, and `failed` is terminal. Forty-five albums were therefore
 * marked as broken imports because a server was busy for a minute, and nothing in the row
 * said which of the two had happened.
 *
 * The rule is a function with a name so that it can be argued with and tested from both
 * sides. It answers one of two words:
 *
 *  - **`upstream`** — a source refused us for a reason that is about the source: a 429, a 5xx,
 *    a timeout, a transport failure. The same request, later, works. The import goes back on
 *    the queue with a growing delay; it does **not** fail.
 *  - **`defect`** — anything the wait cannot repair: a 404, a malformed answer, a bad URL, an
 *    `INVALID_INPUT`. Retrying is a hundred requests for the same sentence, so it fails fast
 *    and asks for a human.
 *
 * Two traps this rule is written around:
 *
 *  1. **`retryable` did not survive `toBody()`.** `MMError` carried the flag, the serialised
 *     body did not, and `job_steps.error` / `imports.error` hold bodies. A classifier that
 *     only read `retryable` would therefore be right in the process that raised the error and
 *     wrong everywhere it is read back. The flag is on the body now (`@mm/contracts`), and
 *     the code and the status are still consulted, because rows written before that change
 *     have no flag at all.
 *  2. **`UNKNOWN` is in `MMError`'s own `RETRYABLE` set.** `MMError.from(new TypeError(...))`
 *     is therefore `retryable: true`, and a parse error in our own code would have qualified
 *     as "the source is busy" and been retried until the cap. So `retryable` is never
 *     sufficient on its own here: the failure must *also* name a source.
 */
import type { MMErrorBody } from "@mm/contracts";
import { backoffMs } from "./machine.ts";

/** The two answers. */
export type FailureKind = "upstream" | "defect";

/**
 * Codes that are a source saying "not now".
 *
 * `SOURCE_*` are raised by `integrations/http.ts`; `TOOLBOX_UNREACHABLE` and `LOCKED` are the
 * same statement made by the container next door, and `RATE_LIMITED` / `TIMEOUT` are the
 * generic pair. The `NAVIDROME_*` pair joins them because `verify` reads the album back
 * through Navidrome, and a Navidrome that is restarting is not a broken import either.
 */
export const UPSTREAM_CODES: ReadonlySet<string> = new Set([
  "SOURCE_UNREACHABLE",
  "SOURCE_UNAVAILABLE",
  "SOURCE_RATE_LIMITED",
  "RATE_LIMITED",
  "TIMEOUT",
  "TOOLBOX_UNREACHABLE",
  "LOCKED",
  "NAVIDROME_UNREACHABLE",
  "NAVIDROME_SCAN_TIMEOUT",
]);

/**
 * Codes that are about *this* import, whatever else the error says.
 *
 * Checked before everything, including the status: `SOURCE_NOT_FOUND` arrives with a 404 and
 * `SOURCE_BAD_RESPONSE` can arrive with a 200, and both mean the request itself is wrong.
 * Waiting changes neither.
 */
export const DEFECT_CODES: ReadonlySet<string> = new Set([
  "SOURCE_NOT_FOUND",
  "SOURCE_BAD_RESPONSE",
  "NOT_FOUND",
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "CANCELLED",
  // The contact is missing from the User-Agent: a settings error, not a busy server.
  "MB_CONTACT_MISSING",
  // The cap was already reached once. Re-classifying it would restart the ladder from zero.
  "UPSTREAM_UNAVAILABLE",
]);

/**
 * The code a give-up carries, so a terminal row says *upstream* and not *this file is bad*.
 */
export const UPSTREAM_EXHAUSTED_CODE = "UPSTREAM_UNAVAILABLE";

/**
 * True when the failure came from somewhere outside this installation.
 *
 * `details.source` is what every `integrations/http.ts` error carries; the `SOURCE_` and
 * `NAVIDROME_` prefixes cover the ones built elsewhere. Without this guard, `retryable` alone
 * would promote our own `UNKNOWN` bugs to "upstream" (trap 2 above).
 */
function namesASource(error: MMErrorBody): boolean {
  if (typeof error.details?.["source"] === "string") return true;
  return (
    error.code.startsWith("SOURCE_") ||
    error.code.startsWith("NAVIDROME_") ||
    UPSTREAM_CODES.has(error.code)
  );
}

/**
 * The rule. One function, two words.
 *
 * Order matters and is the whole design:
 *
 *  1. no error at all is a `defect`. A step that failed without saying why is not evidence
 *     that a server was busy, and silently retrying it forty-five times would hide the bug.
 *  2. a defect code is a `defect`, before any status is looked at.
 *  3. an HTTP status: 429 and 5xx are upstream, every other 4xx is a defect. This is the line
 *     the incident is about, and the one an operator can check by hand.
 *  4. an upstream code is `upstream`. This is the transport failure and the timeout, neither
 *     of which has a status.
 *  5. `retryable: true` **and** the error names a source is `upstream`.
 *  6. anything else is a `defect`.
 */
export function classifyFailure(error: MMErrorBody | null | undefined): FailureKind {
  if (error === null || error === undefined) return "defect";
  if (DEFECT_CODES.has(error.code)) return "defect";

  const status = error.status;
  if (typeof status === "number" && status >= 400) {
    return status === 429 || status >= 500 ? "upstream" : "defect";
  }

  if (UPSTREAM_CODES.has(error.code)) return "upstream";
  if (error.retryable === true && namesASource(error)) return "upstream";
  return "defect";
}

/** The readable half of `classifyFailure`, for callers that only ask the one question. */
export function isUpstreamFailure(error: MMErrorBody | null | undefined): boolean {
  return classifyFailure(error) === "upstream";
}

/** Which source refused, when it said so. What makes the row read "waiting on musicbrainz". */
export function sourceOf(error: MMErrorBody | null | undefined): string | null {
  const named = error?.details?.["source"];
  return typeof named === "string" && named !== "" ? named : null;
}

export interface UpstreamPolicy {
  /** Upstream attempts allowed per import before it is given up on. */
  readonly maxAttempts: number;
  /** The pause after the first upstream refusal. It doubles from there. */
  readonly baseMs: number;
  /** The longest pause between two attempts, however many have failed. */
  readonly maxMs: number;
}

export interface UpstreamDecision {
  /** `hold` puts the import back on the queue later; `giveUp` is the terminal answer. */
  readonly action: "hold" | "giveUp";
  /** The attempt this failure *is* — 1 for the first upstream refusal. */
  readonly attempt: number;
  /** How long to wait before the next one. 0 when giving up. */
  readonly delayMs: number;
}

/**
 * What to do about one upstream refusal, given how many there have already been.
 *
 * `attemptsSoFar` is the counter on the import row *before* this failure, so the first
 * refusal produces `attempt: 1` and waits `baseMs` — the same 1-based convention `backoffMs`
 * documents, kept identical on purpose so that the two can be read together.
 */
export function planUpstreamRetry(attemptsSoFar: number, policy: UpstreamPolicy): UpstreamDecision {
  const attempt = Math.max(0, attemptsSoFar) + 1;
  if (attempt > policy.maxAttempts) return { action: "giveUp", attempt, delayMs: 0 };
  return { action: "hold", attempt, delayMs: backoffMs(attempt, policy.baseMs, policy.maxMs) };
}

/**
 * What `runStep` puts on the step's `result` when it holds an import instead of failing it.
 *
 * It travels in `StepResult.data` rather than in a field of its own because that object is
 * already written verbatim to `job_steps.result` and already reaches the journal, the SSE
 * stream and `mm job`. One value, four readers, no extra plumbing — and the worker, which is
 * the only caller that has a pg-boss handle, reads it back with `holdOf` to decide *when* to
 * put the message on the queue again.
 */
export interface UpstreamHold {
  /** Which upstream attempt this was: 1 for the first refusal. */
  readonly attempt: number;
  readonly maxAttempts: number;
  /** How long the queue should sit on the message. */
  readonly delayMs: number;
  /** Absolute instant, so a worker restart can re-derive the remaining wait. */
  readonly nextAttemptAt: string;
  /** Who refused, when the error said. */
  readonly source: string | null;
}

/** The key `UpstreamHold` travels under. Spelled once. */
export const HOLD_KEY = "upstreamHold";

/** Read a hold back out of a step's `data`, or `null` when the step did not hold. */
export function holdOf(data: Record<string, unknown> | undefined | null): UpstreamHold | null {
  const held = data?.[HOLD_KEY];
  if (held === null || held === undefined || typeof held !== "object") return null;
  const candidate = held as Partial<UpstreamHold>;
  if (typeof candidate.delayMs !== "number" || typeof candidate.nextAttemptAt !== "string") {
    return null;
  }
  return {
    attempt: typeof candidate.attempt === "number" ? candidate.attempt : 1,
    maxAttempts: typeof candidate.maxAttempts === "number" ? candidate.maxAttempts : 0,
    delayMs: candidate.delayMs,
    nextAttemptAt: candidate.nextAttemptAt,
    source: typeof candidate.source === "string" ? candidate.source : null,
  };
}

/**
 * Milliseconds still to wait before `at`, floored at zero and capped at `ceiling`.
 *
 * A worker that comes back up an hour after it died must not honour an hour-old reservation
 * as if it were fresh; it must not depart immediately either, because the source may still be
 * refusing. Zero is the right answer for a wait that has already elapsed, and the cap keeps a
 * clock skew from parking a job for a week.
 */
export function remainingMs(at: Date | null, now: Date, ceiling: number): number {
  if (at === null) return 0;
  return Math.min(Math.max(0, at.getTime() - now.getTime()), ceiling);
}

/** A duration a person reads without converting it. */
export function humanDelay(ms: number): string {
  if (ms < 60_000) return `${String(Math.max(1, Math.round(ms / 1000)))}s`;
  return `${String(Math.round(ms / 60_000))} min`;
}

/**
 * "waiting on musicbrainz, attempt 3 of 6, next try in 4 min" — one sentence, every surface.
 *
 * The owner's complaint was never the delay, it was the red row: a job that is waiting has to
 * *say* it is waiting, and say for whom and until when, or it reads as a failure.
 */
export function describeHold(
  decision: UpstreamDecision,
  policy: UpstreamPolicy,
  source: string | null,
): string {
  const who = source === null ? "the source" : source;
  return `waiting on ${who}, attempt ${String(decision.attempt)} of ${String(policy.maxAttempts)}, next try in ${humanDelay(decision.delayMs)}`;
}
