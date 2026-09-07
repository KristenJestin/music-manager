/**
 * What step 2 of the wizard is doing right now, streamed while it does it.
 *
 * Matching an album is two MusicBrainz searches and up to six lookups, and MusicBrainz is
 * rate-limited to one request per second — so eight to ten seconds is the *floor*, not a
 * symptom. The owner's report of the first real import says the screen did nothing at all for
 * that whole time, which is the part that is a bug: the wait is unavoidable, being unable to
 * tell it apart from a hang is not.
 *
 * This is deliberately **not** the `job_events` journal. Those rows are the record of what an
 * import did, kept for ever and read back by the CLI and the job page; a wizard that wrote nine
 * of them every time somebody reloaded step 2 would be filling a permanent log with the
 * progress bar of a screen nobody is looking at any more. The wizard's progress is worth
 * exactly as long as the request that produces it, so it lives in memory, in the process that
 * is doing the work, and disappears with it.
 *
 * One process is the whole assumption, and it holds: `fetchCandidates` runs in the web server,
 * `GET /api/match-progress` is served by the same web server, and `docs/06-stack.md` fixes the
 * orchestrator count at one.
 */

/** What phase of the match a snapshot is about. */
export type MatchPhase = "starting" | "searching" | "looking-up" | "scoring" | "done";

export interface MatchProgress {
  readonly importId: string;
  readonly phase: MatchPhase;
  /** One short sentence, written for the person waiting. */
  readonly label: string;
  readonly searches: number;
  readonly searchesPlanned: number;
  readonly lookups: number;
  readonly lookupsPlanned: number;
}

type Listener = (progress: MatchProgress) => void;

/**
 * The last snapshot per import, so a subscriber that connects mid-match is not told nothing
 * until the next request completes — which, at one request per second, is a second of blank.
 */
const snapshots = new Map<string, MatchProgress>();
const listeners = new Map<string, Set<Listener>>();

/** How long a finished snapshot is kept, for a subscriber that arrives just after the end. */
const KEEP_MS = 30_000;

export function publishProgress(progress: MatchProgress): void {
  snapshots.set(progress.importId, progress);
  for (const listener of listeners.get(progress.importId) ?? []) listener(progress);
  if (progress.phase === "done") {
    const { importId } = progress;
    const timer = setTimeout(() => {
      snapshots.delete(importId);
    }, KEEP_MS);
    // A pending timer must not hold the process open at shutdown.
    timer.unref?.();
  }
}

export function progressSnapshot(importId: string): MatchProgress | null {
  return snapshots.get(importId) ?? null;
}

export function subscribeProgress(importId: string, listener: Listener): () => void {
  const set = listeners.get(importId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(importId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(importId);
  };
}

/**
 * A reporter bound to one import, with the budget already known.
 *
 * The planned counts come from the settings rather than from observation, because a progress
 * bar that discovers its own total is not a progress bar. Two searches and `lookupLimit`
 * lookups is exactly the budget `matching.service.ts` promises and `matching.budget.test.ts`
 * asserts, so the denominator here cannot drift from what actually happens.
 */
export interface MatchReporter {
  (phase: MatchPhase, label: string, done: { searches: number; lookups: number }): void;
  /**
   * Narrow the plan once the match knows its own shape.
   *
   * The ceiling is `1 + matchGroupLimit` searches (decision 151), but a match that finds one
   * usable release group only makes two of them. Announcing the ceiling and then stopping at
   * "2/4" reads like something failed; revising it the moment the group search comes back —
   * which is before the second second of the wait — keeps the denominator a promise rather
   * than a guess. It only ever *narrows*: nothing here may raise the ceiling it was given.
   */
  revise(planned: { searches?: number; lookups?: number }): void;
  /** The current plan, live — the `finally` that publishes `done` reads it rather than guessing. */
  readonly plan: { searches: number; lookups: number };
}

export function matchReporter(
  importId: string,
  planned: { searches: number; lookups: number },
): MatchReporter {
  const plan = { ...planned };
  const emit = (
    phase: MatchPhase,
    label: string,
    done: { searches: number; lookups: number },
  ): void => {
    publishProgress({
      importId,
      phase,
      label,
      searches: done.searches,
      searchesPlanned: plan.searches,
      lookups: done.lookups,
      lookupsPlanned: plan.lookups,
    });
  };
  return Object.assign(emit, {
    plan,
    revise(next: { searches?: number; lookups?: number }): void {
      if (next.searches !== undefined) plan.searches = Math.min(plan.searches, next.searches);
      if (next.lookups !== undefined) plan.lookups = Math.min(plan.lookups, next.lookups);
    },
  });
}

/** `GET /api/match-progress?import=<id>`, as Server-Sent Events. */
export function progressStream(importId: string): Response {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client hung up between the read and the enqueue; `cancel` cleans up.
        }
      };
      // A comment line opens the stream immediately, so no proxy sits on the headers.
      send(`: watching ${importId}\n\n`);

      const frame = (progress: MatchProgress): void => {
        send(`event: match.progress\ndata: ${JSON.stringify(progress)}\n\n`);
      };
      const current = snapshots.get(importId);
      if (current !== undefined) frame(current);
      unsubscribe = subscribeProgress(importId, frame);
      heartbeat = setInterval(() => {
        send(`: heartbeat\n\n`);
      }, 15_000);
    },
    cancel() {
      if (heartbeat !== null) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
