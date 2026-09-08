import { afterEach, describe, expect, it } from "vitest";
import { gatewayForUrl, parseMbid } from "./matching.queries.ts";
import { resetOutages } from "./matching.gateway.ts";

afterEach(() => {
  resetOutages();
});

/**
 * The read-only half of the matcher, at the two points where it can be tested without rows.
 *
 * The important claim is the gateway's: **the choice follows the URL, not the mode**. A
 * `fixture://` job replays its recorded cassette whatever `MM_FIXTURES` says, which is what
 * keeps the wizard offline in a test, in the demo, and on a developer's laptop with the
 * environment set every which way. If this ever fell through to `liveGateway` the wizard would
 * quietly start talking to MusicBrainz during `bun run check`.
 */
describe("parseMbid", () => {
  it("accepts a bare MBID", () => {
    expect(parseMbid("d073287b-d1bd-4f11-a933-a4386f8cf701")).toBe(
      "d073287b-d1bd-4f11-a933-a4386f8cf701",
    );
  });

  it("accepts a musicbrainz.org URL, which is what people actually paste", () => {
    expect(parseMbid("https://musicbrainz.org/release/d073287b-d1bd-4f11-a933-a4386f8cf701")).toBe(
      "d073287b-d1bd-4f11-a933-a4386f8cf701",
    );
  });

  it("normalises case and surrounding whitespace", () => {
    expect(parseMbid("  D073287B-D1BD-4F11-A933-A4386F8CF701 ")).toBe(
      "d073287b-d1bd-4f11-a933-a4386f8cf701",
    );
  });

  it("says no to free text, so the search box can fall back to searching", () => {
    expect(parseMbid("daft punk discovery")).toBeNull();
    expect(parseMbid("")).toBeNull();
    expect(parseMbid("d073287b-d1bd-4f11-a933")).toBeNull();
  });
});

describe("gatewayForUrl", () => {
  it("replays the cassette for a fixture URL, without a database or a socket", async () => {
    const gateway = await gatewayForUrl("fixture://discovery");
    const release = await gateway.lookupRelease("d073287b-d1bd-4f11-a933-a4386f8cf701");
    expect(release?.title).toBe("Discovery");
    expect(gateway.calls).toEqual({ searches: 0, lookups: 1 });
  });

  it("keeps the query string, because that is what carries the scenario switches", async () => {
    const gateway = await gatewayForUrl("fixture://discovery?fp=mismatch");
    const release = await gateway.lookupRelease("d073287b-d1bd-4f11-a933-a4386f8cf701");
    expect(release?.title).toBe("Discovery");
  });

  /**
   * `?mb=503` is the offline reproduction of the 2026-09-08 incident (decision 165).
   *
   * It has to fail with the *real* error — the one `integrations/http.ts` builds for a 503 —
   * or the wizard's "is this a source outage?" test would be passing on a lookalike, and the
   * browser spec that drives this would prove nothing about a genuine MusicBrainz refusal.
   */
  it("refuses once for ?mb=503, with the error a real 503 produces", async () => {
    const url = "fixture://discovery?mb=503&case=unit-once";
    const gateway = await gatewayForUrl(url);
    await expect(
      gateway.lookupRelease("d073287b-d1bd-4f11-a933-a4386f8cf701"),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", status: 503, retryable: true });

    // Exhausted: a second gateway over the same URL is the plain cassette again, which is what
    // makes Retry a meaningful thing for the spec to press.
    const after = await gatewayForUrl(url);
    expect((await after.lookupRelease("d073287b-d1bd-4f11-a933-a4386f8cf701"))?.title).toBe(
      "Discovery",
    );
  });

  it("refuses `mbtimes` times, which is what defeats the wizard's cache fallback", async () => {
    const url = "fixture://discovery?mb=503&mbtimes=2&case=unit-twice";
    const mbid = "d073287b-d1bd-4f11-a933-a4386f8cf701";
    await expect((await gatewayForUrl(url)).lookupRelease(mbid)).rejects.toMatchObject({
      status: 503,
    });
    await expect((await gatewayForUrl(url)).lookupRelease(mbid)).rejects.toMatchObject({
      status: 503,
    });
    expect((await (await gatewayForUrl(url)).lookupRelease(mbid))?.title).toBe("Discovery");
  });

  it("ignores an mb= that is not a plausible HTTP status", async () => {
    const gateway = await gatewayForUrl("fixture://discovery?mb=banana");
    expect((await gateway.lookupRelease("d073287b-d1bd-4f11-a933-a4386f8cf701"))?.title).toBe(
      "Discovery",
    );
  });

  it("refuses a document the cassette never recorded, rather than answering null", async () => {
    // A gateway that quietly returned null would let the request pattern drift without any
    // test noticing, and the cassette would stop being a recording of the algorithm.
    const gateway = await gatewayForUrl("fixture://discovery");
    await expect(gateway.lookupRelease("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /has no document/,
    );
  });
});
