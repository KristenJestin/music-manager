/**
 * The registry that lets wizard step 2 stop living inside its own HTTP request.
 *
 * No database and no network: the registry is a `Map` and a promise, which is the whole reason
 * it can be tested at all. What it has to get right is the four things below, and each of them
 * corresponds to a bug the synchronous version had.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  forgetMatchRun,
  matchRun,
  resetMatchRuns,
  settleMatchRun,
  startMatchRun,
  takeMatchFailure,
  type MatchResult,
} from "#/server/services/match-runs.ts";

afterEach(() => {
  resetMatchRuns();
});

/** The smallest thing that satisfies `MatchResult`. Its contents are nobody's business here. */
function ranking(queries: readonly string[] = ["q"]): MatchResult {
  return {
    kind: "single",
    ranking: { candidates: [], preselected: null, ambiguous: false, margin: null },
    budget: { searches: 1, lookups: 0 },
    planned: { searches: 2, lookups: 6 },
    queries,
  } as MatchResult;
}

/** A promise a test can settle when it chooses, which is how "still running" is observed. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("startMatchRun", () => {
  it("knows nothing until something starts", () => {
    expect(matchRun("i1")).toBeNull();
  });

  it("joins a run in flight instead of starting a second one", async () => {
    /*
     * This is the reload, and it is the behaviour the owner asked for in so many words: "a
     * reload mid-search resumes the display instead of restarting the search". The old handler
     * had no way to express it — every request ran its own match — so a refresh at second nine
     * of a fifteen-second search bought a fresh fifteen seconds and threw away the nine.
     */
    const gate = deferred<MatchResult>();
    let started = 0;
    const work = (): Promise<MatchResult> => {
      started += 1;
      return gate.promise;
    };

    const first = startMatchRun("i1", work);
    const second = startMatchRun("i1", work);
    const third = startMatchRun("i1", work);

    expect(started).toBe(1);
    expect(first.status).toBe("running");
    expect(second.status).toBe("running");
    expect(third.startedAt).toBe(first.startedAt);

    gate.resolve(ranking());
    await gate.promise;
    expect(matchRun("i1")?.status).toBe("done");
  });

  it("keeps the ranking, so the request that comes back recomputes nothing", async () => {
    const result = ranking(["the one query"]);
    startMatchRun("i1", () => Promise.resolve(result));
    await settleMatchRun("i1", 50);

    const run = matchRun("i1");
    expect(run?.status).toBe("done");
    expect(run?.result).toBe(result);
    expect(run?.finishedAt).not.toBeNull();
  });

  it("never rejects out of the detached promise", async () => {
    /*
     * Nothing awaits `work()` — that is the point — so a rejection escaping here would be an
     * unhandled rejection in the web process. The failure has to become a *field*.
     */
    startMatchRun("i1", () => Promise.reject(new Error("musicbrainz answered HTTP 503")));
    await settleMatchRun("i1", 50);
    expect(matchRun("i1")?.status).toBe("failed");
  });

  it("starts again once the previous run has been forgotten", async () => {
    let started = 0;
    const work = (): Promise<MatchResult> => {
      started += 1;
      return Promise.resolve(ranking());
    };
    startMatchRun("i1", work);
    await settleMatchRun("i1", 50);
    forgetMatchRun("i1");
    expect(matchRun("i1")).toBeNull();
    startMatchRun("i1", work);
    expect(started).toBe(2);
  });
});

describe("settleMatchRun", () => {
  it("returns the answer when the match is instant", async () => {
    // The cassette and warm-cache case. Making it cost a second round trip and a flash of the
    // waiting screen would be a regression dressed as a fix, so the request lingers a moment.
    startMatchRun("i1", () => Promise.resolve(ranking()));
    const settled = await settleMatchRun("i1", 1_000);
    expect(settled?.status).toBe("done");
  });

  it("gives up on a slow one and leaves it running", async () => {
    // The real MusicBrainz case: ten to fourteen requests at one per second cannot finish in
    // the grace, so the request answers "pending" and the screen follows the progress stream.
    const gate = deferred<MatchResult>();
    startMatchRun("i1", () => gate.promise);

    const started = Date.now();
    const settled = await settleMatchRun("i1", 20);
    expect(settled?.status).toBe("running");
    // It waited, and it did not wait for the work.
    expect(Date.now() - started).toBeLessThan(1_000);

    gate.resolve(ranking());
    await gate.promise;
    expect(matchRun("i1")?.status).toBe("done");
  });

  it("says nothing about an import with no run", async () => {
    expect(await settleMatchRun("nobody", 10)).toBeNull();
  });
});

describe("takeMatchFailure", () => {
  it("hands the failure over exactly once, so that Retry is a real retry", async () => {
    /*
     * Leaving the failure in place would make the error screen's Retry button — which re-runs
     * the same loader with the same arguments — a button that redisplays the same error without
     * trying anything. Read-once means the next call finds an empty registry and starts afresh.
     */
    const boom = new Error("musicbrainz answered HTTP 503");
    startMatchRun("i1", () => Promise.reject(boom));
    await settleMatchRun("i1", 50);

    expect(takeMatchFailure("i1")).toBe(boom);
    expect(matchRun("i1")).toBeNull();
    expect(takeMatchFailure("i1")).toBeUndefined();
  });

  it("refuses to hand over a failure a successful run does not have", async () => {
    startMatchRun("i1", () => Promise.resolve(ranking()));
    await settleMatchRun("i1", 50);
    expect(takeMatchFailure("i1")).toBeUndefined();
    // …and the successful run is still there, which is the point of the distinction.
    expect(matchRun("i1")?.status).toBe("done");
  });

  it("always has something to hand over, even from a run that threw nothing", async () => {
    // `throw null` and `throw undefined` are legal and do happen. `undefined` is the only value
    // that means "no failure here", so the registry has to substitute something readable.
    startMatchRun("i1", () => Promise.reject(null));
    await settleMatchRun("i1", 50);
    expect(matchRun("i1")?.status).toBe("failed");
    expect(takeMatchFailure("i1")).toBeInstanceOf(Error);
  });
});
