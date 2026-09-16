/**
 * One MusicBrainz budget, and nobody outside it.
 *
 * Decision 164 moved the one-request-per-second reservation into Postgres because "the client"
 * MusicBrainz counts is the *installation*, not the process. That is only true if every call
 * to a MusicBrainz server goes through the gate, and the audit that followed the 503 session
 * found one family that did not: the Cover Art Archive index. `coverartarchive.org/release/…`
 * is answered by MusicBrainz's own front end — only the image bytes live on archive.org — and
 * those two lookups carried no `gate` and no `minIntervalMs` at all.
 *
 * These tests fail if anybody removes the gate again, and they say why in their names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { memoryStore, type CacheStore } from "#/server/integrations/cached.ts";
import { requireContact, sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import { resetFetch, resetLimiters, setFetch } from "#/server/integrations/http.ts";
import { defaults } from "#/server/services/settings.ts";
import * as caa from "#/server/integrations/coverartarchive.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";

const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
const GROUP = "b9f13e0f-0a7d-3e0e-b3e8-9f5f1b5b2a44";

/**
 * Every URL that left, in order.
 *
 * `SourceContext.db` is `null` throughout, which `gateFor` already reads as "this process is
 * alone" — so the gate under test is `http.ts`'s in-process limiter rather than the Postgres
 * one. That is deliberate and sufficient: the two implement the same two verbs behind the same
 * interface, the database one has its own integration test, and what is being asserted here is
 * *which callers consult a gate at all*, which is identical either way.
 */
let departures: string[];
let store: CacheStore;

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  return {
    db: null as never,
    store,
    config: sourcesConfig(defaults(), { MM_MB_CONTACT: "tests@example.invalid" }),
    offline: false,
    refresh: false,
    ...overrides,
  };
}

beforeEach(() => {
  departures = [];
  store = memoryStore();
  resetLimiters();
  setFetch((url) => {
    departures.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ images: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(() => {
  resetFetch();
  resetLimiters();
});

describe("every MusicBrainz door goes through the shared gate", () => {
  it("still reaches the Cover Art Archive index, which MusicBrainz serves", async () => {
    // The regression: these two used to leave with no limiter of any kind, so a cover lookup
    // landed in the same second as the release lookup beside it — two requests, one
    // User-Agent, and the gate none the wiser.
    await caa.index(context(), RELEASE);
    await caa.releaseGroupIndex(context(), GROUP);
    expect(departures).toHaveLength(2);
    expect(departures[0]).toContain("coverartarchive.org/release/");
    expect(departures[1]).toContain("coverartarchive.org/release-group/");
  });

  it("spaces a cover lookup behind a release lookup, on one budget", async () => {
    // A shared budget is the whole claim, and the cheapest proof is that the *same* limiter
    // is used: pinned to a measurable interval, the second departure cannot precede the first.
    const ctx = context();
    const started = Date.now();
    await musicbrainz.lookupRelease(ctx, RELEASE);
    await caa.index(ctx, RELEASE);
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      // One interval between two departures, whichever client asked for them.
      musicbrainz.MB_MIN_INTERVAL_MS - 50,
    );
    expect(departures).toHaveLength(2);
  }, 10_000);
});

describe("an anonymous User-Agent is refused, loudly", () => {
  const anonymous = () => context({ config: sourcesConfig(defaults(), { MM_MB_CONTACT: "" }) });

  it("refuses a MusicBrainz lookup with no contact configured", async () => {
    const failed = await musicbrainz.lookupRelease(anonymous(), RELEASE).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(MMError);
    expect((failed as MMError).code).toBe("MB_CONTACT_MISSING");
    // And it never left: the whole point is not to spend the shared anonymous agent's budget.
    expect(departures).toHaveLength(0);
  });

  it("refuses a Cover Art Archive lookup the same way", async () => {
    const failed = await caa.index(anonymous(), RELEASE).catch((e: unknown) => e);
    expect((failed as MMError).code).toBe("MB_CONTACT_MISSING");
    expect(departures).toHaveLength(0);
  });

  it("names the setting and the environment variable, so the fix is in the message", () => {
    const failed = (() => {
      try {
        requireContact(sourcesConfig(defaults(), { MM_MB_CONTACT: "   " }));
        return null;
      } catch (error) {
        return MMError.from(error);
      }
    })();
    expect(failed?.code).toBe("MB_CONTACT_MISSING");
    expect(failed?.hint).toContain("mbContact");
    expect(failed?.hint).toContain("MM_MB_CONTACT");
    // Not retryable: a wait does not produce a contact, and the step machine must fail fast
    // on it rather than spending six upstream attempts against a settings problem.
    expect(failed?.retryable).toBe(false);
  });

  it("lets a configured contact through untouched", () => {
    expect(() => {
      requireContact(sourcesConfig(defaults(), { MM_MB_CONTACT: "me@example.invalid" }));
    }).not.toThrow();
  });
});
