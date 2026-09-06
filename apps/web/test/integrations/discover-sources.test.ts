/**
 * The two source calls Discover adds, against recorded answers.
 *
 * Same contract as `clients.test.ts`: the production client, its real URL, its real cache key,
 * its real parsing — only the socket is replaced. What this file adds is the pair P04 left as
 * a stub because neither can be recorded without an account: ListenBrainz's collaborative
 * filtering, and the similar-artists fallback to Last.fm.
 *
 * The last assertion is the one that matters most in practice: **a source that answers nothing
 * must not take the page down**. Offline, a key nobody seeded is an error by design, and every
 * call in `recommendations.service` is wrapped so that error becomes an empty block rather than
 * a failed sync.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStore, type CacheStore } from "#/server/integrations/cached.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import {
  resetFetch,
  resetLimiters,
  resetRequestCount,
  setLimiter,
} from "#/server/integrations/http.ts";
import { defaults } from "#/server/services/settings.ts";
import { artistSimilar } from "#/server/integrations/lastfm.ts";
import { recommendations, similarArtists } from "#/server/integrations/listenbrainz.ts";
import { play, type Player } from "../cassette.ts";

const DAFT_PUNK = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

let player: Player;
let store: CacheStore;
let ctx: SourceContext;

beforeEach(() => {
  player = play("listenbrainz", "lastfm", "discover");
  store = memoryStore();
  resetLimiters();
  setLimiter("listenbrainz", 0);
  setLimiter("lastfm", 0);
  resetRequestCount();
  ctx = {
    db: null as never,
    store,
    config: sourcesConfig(defaults(), {
      MM_MB_CONTACT: "tests@example.invalid",
      MM_LASTFM_KEY: "test-key",
    }),
    offline: false,
    refresh: false,
  };
});

afterEach(() => {
  player.restore();
  resetFetch();
  resetLimiters();
});

describe("ListenBrainz collaborative filtering", () => {
  it("reads the recommendation list as recording MBIDs with scores", async () => {
    const answer = await recommendations(ctx, "mm-fixtures", 100);
    const mbids = answer.data?.payload?.mbids ?? [];
    expect(mbids).toHaveLength(3);
    expect(mbids[0]?.recording_mbid).toBe("60fa767a-d85d-4991-82bc-4294e0b11ae7");
    expect(mbids[0]?.score).toBeCloseTo(0.94, 5);
    // Scores arrive already ordered; the recommender still re-scores, but it must not have to
    // re-sort a list ListenBrainz has already ranked.
    expect(mbids.map((one) => one.score ?? 0)).toEqual(
      [...mbids.map((one) => one.score ?? 0)].sort((a, b) => b - a),
    );
  });

  it("goes to the wire once and to the cache afterwards", async () => {
    await recommendations(ctx, "mm-fixtures", 100);
    const second = await recommendations(ctx, "mm-fixtures", 100);
    expect(player.plays()).toBe(1);
    expect(second.fresh).toBe(false);
    expect(second.data?.payload?.mbids).toHaveLength(3);
  });

  it("keys the cache on the user and the count, so two users never collide", async () => {
    await recommendations(ctx, "mm-fixtures", 100);
    expect(
      await store.get("listenbrainz", "cf/recommendation/user/mm-fixtures/recording?count=100"),
    ).not.toBeNull();
    expect(
      await store.get("listenbrainz", "cf/recommendation/user/someone-else/recording?count=100"),
    ).toBeNull();
  });
});

describe("ListenBrainz similar artists", () => {
  it("answers the similarity graph for an artist MBID", async () => {
    const answer = await similarArtists(ctx, DAFT_PUNK);
    const rows = answer.data ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.name).toBeTypeOf("string");
    expect(rows[0]?.artist_mbid).toBeTypeOf("string");
  });
});

describe("Last.fm, the fallback", () => {
  it("answers similar artists with a decimal match, and never leaks the key into the cache key", async () => {
    const answer = await artistSimilar(ctx, "Justice", 20);
    const artists = answer?.data?.similarartists?.artist ?? [];
    expect(artists.map((one) => one.name)).toEqual(["SebastiAn", "Breakbot", "Kavinsky"]);
    // `match` is a string in the Last.fm JSON; the recommender coerces it.
    expect(Number(artists[1]?.match)).toBeCloseTo(0.783, 5);

    const cached = await store.get("lastfm", "artist.getSimilar?artist=justice&limit=20");
    expect(cached).not.toBeNull();
    expect(JSON.stringify(cached)).not.toContain("test-key");
  });

  it("does not ask at all when no key is configured", async () => {
    const keyless: SourceContext = { ...ctx, config: sourcesConfig(defaults(), {}) };
    expect(await artistSimilar(keyless, "Justice", 20)).toBeNull();
    expect(player.plays()).toBe(0);
  });
});

describe("an unrecorded answer, offline", () => {
  it("is an error the caller is expected to swallow, not a silent request", async () => {
    const offline: SourceContext = { ...ctx, offline: true };
    await expect(recommendations(offline, "nobody", 100)).rejects.toThrow(
      /OFFLINE|never been fetched/i,
    );
    expect(player.plays()).toBe(0);
  });
});
