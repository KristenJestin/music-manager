/**
 * The MusicBrainz match of wizard step 2, running *beside* the request rather than inside it.
 *
 * ## Why this exists
 *
 * `fetchCandidates` used to do the whole match in its own handler: a release-group search, one
 * release search per group kept, and up to `matchLookupLimit` tracklist lookups, at the one
 * request per second MusicBrainz allows. Ten requests is the floor on the defaults and the
 * owner's installation is configured for fourteen. That is eleven to fifteen seconds in which
 * the response writes no bytes at all — and the production runtime closes a connection that has
 * been idle for ten (`server/http/abort.ts`). The request died, the abort escaped as a 500, and
 * the router painted *"Invariant failed"* over the wizard.
 *
 * Raising the connection's ceiling stops the killing. It does not make the design right: a
 * reload during those fifteen seconds started the whole search **again**, from zero, and there
 * was no answer to "what is it doing" that survived leaving the page. So the work moved.
 *
 * ## The shape
 *
 * The same shape `startScan`/`scanStatus` and `startRetag`/`fetchRunStatus` already use, minus
 * the queue: **start it, answer straight away, report progress on a channel, read the result
 * when it lands.** Two differences from those two, both deliberate:
 *
 *  - **It runs here, not in the worker.** A match's output is not a row, it is a ranking; and a
 *    wizard that needed a worker process up before it could show you a candidate would be a
 *    worse wizard. The run is a promise in this process, exactly like the progress channel next
 *    to it, and for the same documented reason: one web process (`docs/06-stack.md`).
 *  - **The registry is in memory, and losing it is survivable.** Every MusicBrainz document a
 *    match reads is written to `source_cache` on the way past, so an import whose registry
 *    entry died with a restart can be re-ranked *offline*, from the database, with no request
 *    at all. The registry is the fast path; the cache is the floor under it.
 *
 * A failure is **read once**. `takeMatchFailure` hands the error to the first request that asks
 * and forgets the entry, so the Retry button — which re-runs the same loader with the same
 * arguments — starts a fresh attempt instead of being handed the same corpse for ever.
 *
 * Progress still travels over `server/services/match-progress.ts` and `/api/match-progress`,
 * unchanged: `rankFor` publishes into it from wherever it happens to be running.
 */
import type { AlbumMatch, SingleMatch } from "#/server/services/matching.service.ts";

/** What one wizard match produces — the same thing `rankFor` returns, held until it is read. */
export type MatchResult = AlbumMatch | SingleMatch;

/** Where a match for one import has got to. Absent from the registry means "none known". */
export type MatchRunStatus = "running" | "done" | "failed";

export interface MatchRun {
  readonly importId: string;
  readonly status: MatchRunStatus;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** Set exactly when `status` is `"done"`: the ranking the run computed, ready to render. */
  readonly result: MatchResult | null;
}

interface Entry {
  readonly importId: string;
  status: MatchRunStatus;
  readonly startedAt: number;
  finishedAt: number | null;
  result: MatchResult | null;
  /** Whatever the run threw, kept until somebody asks for it exactly once. */
  failure: unknown;
  /** Resolves when the run settles, either way. Never rejects: the outcome is in the fields. */
  settled: Promise<void>;
}

const runs = new Map<string, Entry>();

/**
 * How long a finished run is remembered.
 *
 * Long enough that the page which started it, and any reload of that page, finds the answer
 * without asking for the work to be redone; short enough that an import nobody came back to
 * does not hold a ranking in memory for the lifetime of the process. Five minutes is roughly
 * "the wizard session that produced it", and the cost of forgetting too early is one offline
 * re-rank against `source_cache`, not a second trip to MusicBrainz.
 */
const KEEP_MS = 5 * 60_000;

function sweep(now: number): void {
  for (const [id, entry] of runs) {
    if (entry.status === "running") continue;
    // A failure is kept until it is read: it is the only copy, and nothing has seen it yet.
    if (entry.status === "failed") continue;
    if (entry.finishedAt !== null && now - entry.finishedAt > KEEP_MS) runs.delete(id);
  }
}

function view(entry: Entry): MatchRun {
  return {
    importId: entry.importId,
    status: entry.status,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    result: entry.result,
  };
}

/** What is known about this import's match, or `null` when nothing is. */
export function matchRun(importId: string): MatchRun | null {
  sweep(Date.now());
  const entry = runs.get(importId);
  return entry === undefined ? null : view(entry);
}

/**
 * Start the match, unless one is already in flight for this import.
 *
 * Returns the run either way, so the caller cannot accidentally start two: a reload arriving
 * three seconds into a fifteen-second match must **join** it, not race it. That is the whole of
 * "a reload mid-search resumes the display instead of restarting the search", and it is why the
 * check and the insert happen in the same synchronous block — a `Map` mutated between two
 * `await`s is the classic way to end up with two of something.
 */
export function startMatchRun(importId: string, work: () => Promise<MatchResult>): MatchRun {
  const held = runs.get(importId);
  if (held?.status === "running") return view(held);

  const entry: Entry = {
    importId,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    result: null,
    failure: undefined,
    settled: Promise.resolve(),
  };
  runs.set(importId, entry);

  /*
   * Detached on purpose, and settled into fields rather than awaited.
   *
   * Nothing awaits `work()` — that is the point of the change — so an unhandled rejection would
   * be an unhandled rejection in the web process, which under Bun is a log line at best and a
   * dead process at worst. The failure is *data* here, read back by the next request. `settled`
   * exists so a caller may choose to wait a moment for a match that turns out to be instant,
   * and it never rejects for the same reason.
   */
  entry.settled = work().then(
    (result) => {
      entry.status = "done";
      entry.finishedAt = Date.now();
      entry.result = result;
    },
    (error: unknown) => {
      entry.status = "failed";
      entry.finishedAt = Date.now();
      // `null` would be indistinguishable from "no failure": an error can be anything, and
      // `undefined` is the only value `takeMatchFailure` treats as absent.
      entry.failure = error ?? new Error("The match failed without saying why.");
    },
  );

  return view(entry);
}

/**
 * Wait up to `ms` for a run to settle, then answer whatever it has become.
 *
 * The one concession to "a match is not always slow". A wizard opened on an import whose
 * documents are already in `source_cache`, or on a `fixture://` source answered from a
 * cassette, finishes in milliseconds — and making *that* cost a second round trip and a flash
 * of the waiting screen would be a regression dressed as a fix. So the request lingers for a
 * moment, and returns the answer when it arrives inside it.
 *
 * The grace must stay far below the connection's own patience, which is the thing this whole
 * change exists to respect. `GRACE_MS` in `functions/wizard.ts` is a small fraction of it.
 */
export async function settleMatchRun(importId: string, ms: number): Promise<MatchRun | null> {
  const entry = runs.get(importId);
  if (entry === undefined) return null;
  if (entry.status !== "running") return view(entry);

  let timer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    entry.settled,
    new Promise<void>((done) => {
      timer = setTimeout(done, ms);
      // A pending timer must not hold the process open at shutdown.
      timer.unref?.();
    }),
  ]);
  if (timer !== null) clearTimeout(timer);
  return view(entry);
}

/**
 * The failure of a finished run, handed over exactly once.
 *
 * Read-once because the only thing that asks is the loader, and the only reason the loader asks
 * twice is that the user pressed Retry. Leaving the failure in place would make Retry a button
 * that redisplays the same error without trying anything, which is worse than no button at all.
 * The entry goes with it, so the next call starts a fresh run.
 */
export function takeMatchFailure(importId: string): unknown {
  const entry = runs.get(importId);
  if (entry === undefined || entry.status !== "failed") return undefined;
  runs.delete(importId);
  return entry.failure;
}

/** Drop what is known about an import's match. */
export function forgetMatchRun(importId: string): void {
  runs.delete(importId);
}

/** Test seam: a registry that remembers nothing between specs. */
export function resetMatchRuns(): void {
  runs.clear();
}
