/**
 * The shared HTTP layer: the limiter, the retries, the error shape, the counter.
 *
 * Nothing here touches the network — the transport is scripted. The one slow test is the
 * limiter's, and it is slow on purpose: `docs/phases/P04-integrations.md` asks for exactly
 * this proof, "10 concurrent MusicBrainz calls take ≥ 9 s", and a fake clock would prove that
 * the code schedules a delay, not that a caller actually waits for it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MMError } from "@mm/contracts";
import {
  backoffOf,
  getJson,
  RateLimiter,
  redact,
  requestCount,
  resetFetch,
  resetLimiters,
  resetRequestCount,
  countingRequests,
  setFetch,
} from "#/server/integrations/http.ts";
import { MB_MIN_INTERVAL_MS } from "#/server/integrations/musicbrainz.ts";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

afterEach(() => {
  resetFetch();
  resetLimiters();
  resetRequestCount();
});

describe("the rate limiter", () => {
  it("spaces departures by the interval, whoever asked", async () => {
    const limiter = new RateLimiter(20);
    const started = Date.now();
    await Promise.all(Array.from({ length: 5 }, async () => await limiter.acquire()));
    // Five slots, four gaps: the fifth caller leaves at t+80 ms at the earliest.
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });

  /**
   * This one claim is stated on a controlled clock, and it is the exception the header above
   * describes rather than a contradiction of it.
   *
   * What is being proven is that `acquire` moves `nextFreeAt` *before* it awaits, so four
   * callers arriving in the same tick take four different slots instead of all reading the
   * same free instant. Wall-clock arrival times cannot prove that on a busy machine: a
   * starved event loop delivers the four late timers in one batch, every measured gap
   * collapses to zero, and the test fails while the code is perfectly correct. That is what
   * made it flaky whenever the suite ran beside a dev server and Docker. A fake clock states
   * the claim exactly — caller *n* leaves at *n* × the interval, no rounding, no tolerance —
   * and the two neighbouring tests keep the real-time proof that a caller genuinely waits.
   */
  it("reserves the slot before waiting, so concurrency cannot collapse the queue", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter(50);
      const at: number[] = [];
      const started = Date.now();
      const all = Promise.all(
        Array.from({ length: 4 }, async () => {
          await limiter.acquire();
          at.push(Date.now() - started);
        }),
      );
      await vi.advanceTimersByTimeAsync(500);
      await all;
      expect(at).toEqual([0, 50, 100, 150]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds MusicBrainz to one request per second: ten concurrent calls take at least nine", async () => {
    setFetch(() => Promise.resolve(json({ ok: true })));
    const started = Date.now();
    await Promise.all(
      Array.from(
        { length: 10 },
        async (_unused, index) =>
          await getJson({
            source: "musicbrainz",
            url: `https://musicbrainz.org/ws/2/release/${String(index)}?fmt=json`,
            minIntervalMs: MB_MIN_INTERVAL_MS,
          }),
      ),
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(requestCount()).toBe(10);
  }, 30_000);
});

describe("retries", () => {
  it("retries a 503 and succeeds when the source recovers", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return Promise.resolve(
        calls < 3 ? new Response("busy", { status: 503 }) : json({ title: "Discovery" }),
      );
    });
    const waits: number[] = [];
    const answer = await getJson<{ title: string }>({
      source: "musicbrainz",
      url: "https://musicbrainz.org/ws/2/release/x",
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(answer?.data.title).toBe("Discovery");
    expect(calls).toBe(3);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("honours Retry-After on a 429 rather than its own backoff", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response("slow down", { status: 429, headers: { "retry-after": "5" } })
          : json({ ok: true }),
      );
    });
    const waits: number[] = [];
    await getJson({
      source: "lastfm",
      url: "https://ws.audioscrobbler.com/2.0/",
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([5_000]);
  });

  it("gives up after the last attempt and reports a retryable error", async () => {
    setFetch(() => Promise.resolve(new Response("nope", { status: 500 })));
    const failed = await getJson({
      source: "deezer",
      url: "https://api.deezer.com/track/isrc:X",
      attempts: 2,
      wait: () => Promise.resolve(),
    }).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(MMError);
    const error = failed as MMError;
    expect(error.code).toBe("SOURCE_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(500);
  });

  it("does not retry a 400: a bad request is not a busy server", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return Promise.resolve(new Response("bad", { status: 400 }));
    });
    await expect(
      getJson({ source: "musicbrainz", url: "https://musicbrainz.org/ws/2/release/nope" }),
    ).rejects.toMatchObject({ code: "SOURCE_HTTP" });
    expect(calls).toBe(1);
  });

  it("retries a transport failure, then reports the source as unreachable", async () => {
    setFetch(() => Promise.reject(new TypeError("fetch failed")));
    const failed = await getJson({
      source: "lrclib",
      url: "https://lrclib.net/api/get",
      attempts: 2,
      wait: () => Promise.resolve(),
    }).catch((error: unknown) => error);
    expect((failed as MMError).code).toBe("SOURCE_UNREACHABLE");
  });

  it("turns a 404 into null when the caller says an absence is a fact", async () => {
    setFetch(() => Promise.resolve(new Response(null, { status: 404 })));
    const answer = await getJson({
      source: "coverartarchive",
      url: "https://coverartarchive.org/release/x",
      nullOn404: true,
    });
    expect(answer).toBeNull();
  });

  it("reports a body that is not JSON rather than throwing a parse error", async () => {
    setFetch(() => Promise.resolve(new Response("<html>maintenance</html>", { status: 200 })));
    await expect(
      getJson({ source: "deezer", url: "https://api.deezer.com/track/isrc:X" }),
    ).rejects.toMatchObject({ code: "SOURCE_BAD_RESPONSE" });
  });
});

describe("backoff", () => {
  it("doubles, and is capped", () => {
    expect(backoffOf(1_000, 1, null)).toBe(1_000);
    expect(backoffOf(1_000, 4, null)).toBe(8_000);
    expect(backoffOf(1_000, 99, null)).toBe(30_000);
  });

  it("prefers a Retry-After it can read, capped at a minute", () => {
    expect(backoffOf(1_000, 1, "3")).toBe(3_000);
    expect(backoffOf(1_000, 1, "9999")).toBe(60_000);
    expect(backoffOf(1_000, 2, "not a number")).toBe(2_000);
  });
});

describe("the request counter and redaction", () => {
  it("counts every attempt, retries included", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return Promise.resolve(calls < 2 ? new Response("", { status: 503 }) : json({ ok: true }));
    });
    const { requests } = await countingRequests(
      async () =>
        await getJson({
          source: "listenbrainz",
          url: "https://api.listenbrainz.org/1/x",
          wait: () => Promise.resolve(),
        }),
    );
    expect(requests).toBe(2);
  });

  it("never lets a key into a URL that will be logged", () => {
    expect(redact("https://ws.audioscrobbler.com/2.0/?method=x&api_key=abc123&format=json")).toBe(
      "https://ws.audioscrobbler.com/2.0/?method=x&api_key=<redacted>&format=json",
    );
    expect(redact("https://api.acoustid.org/v2/lookup?client=SECRET")).toBe(
      "https://api.acoustid.org/v2/lookup?client=<redacted>",
    );
  });

  it("puts the redacted URL, never the raw one, in the error it raises", async () => {
    setFetch(() => Promise.resolve(new Response("", { status: 500 })));
    const failed = (await getJson({
      source: "lastfm",
      url: "https://ws.audioscrobbler.com/2.0/?api_key=SUPERSECRET",
      attempts: 1,
    }).catch((error: unknown) => error)) as MMError;
    expect(JSON.stringify(failed.details)).not.toContain("SUPERSECRET");
    expect(JSON.stringify(failed.details)).toContain("<redacted>");
  });
});
