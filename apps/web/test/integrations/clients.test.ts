/**
 * The eight source clients of `docs/03-metadonnees.md` §4, against their recorded answers.
 *
 * These are not mock tests. The cassettes hold what MusicBrainz, the Cover Art Archive,
 * LRCLIB, Deezer, Last.fm, ListenBrainz and Wikidata really answered on the day they were
 * recorded, and the code under test is the production client — its URL, its `inc` preset, its
 * cache key, its parsing. The only thing replaced is the socket.
 *
 * The MusicBrainz limiter is pinned to zero here. Its one-second rule has its own test
 * (`./http.test.ts`), and paying eight real seconds again to replay eight recordings would
 * buy nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MbRelease } from "@mm/domain";
import { memoryStore, type CacheStore } from "#/server/integrations/cached.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import {
  requestCount,
  resetFetch,
  resetLimiters,
  resetRequestCount,
  setLimiter,
} from "#/server/integrations/http.ts";
import { defaults } from "#/server/services/settings.ts";
import * as caa from "#/server/integrations/coverartarchive.ts";
import * as deezer from "#/server/integrations/deezer.ts";
import * as lastfm from "#/server/integrations/lastfm.ts";
import * as listenbrainz from "#/server/integrations/listenbrainz.ts";
import * as lrclib from "#/server/integrations/lrclib.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import * as wikimedia from "#/server/integrations/wikimedia.ts";
import { play, type Player } from "../cassette.ts";

const RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";
const RECORDING = "60fa767a-d85d-4991-82bc-4294e0b11ae7";
const WORK = "4bb47ffc-9006-32cf-8aa9-e213334550dc";
const ARTIST = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
const ABSENT = "11111111-2222-4333-8444-555555555555";

let player: Player;
let store: CacheStore;
let ctx: SourceContext;

function context(overrides: Partial<SourceContext> = {}): SourceContext {
  const settings = defaults();
  return {
    db: null as never,
    store,
    // The keys the cassettes were recorded with are redacted, so any non-empty value works:
    // what matters is that the client believes it is configured and asks the question.
    config: sourcesConfig(settings, {
      MM_MB_CONTACT: "tests@example.invalid",
      MM_LASTFM_KEY: "test-key",
      MM_FANARTTV_KEY: "test-key",
      MM_ACOUSTID_KEY: "test-key",
    }),
    offline: false,
    refresh: false,
    ...overrides,
  };
}

beforeEach(() => {
  player = play(
    "musicbrainz",
    "coverartarchive",
    "lrclib",
    "deezer",
    "lastfm",
    "listenbrainz",
    "wikimedia",
  );
  store = memoryStore();
  resetLimiters();
  setLimiter("musicbrainz", 0);
  setLimiter("deezer", 0);
  setLimiter("lastfm", 0);
  setLimiter("listenbrainz", 0);
  setLimiter("wikimedia", 0);
  resetRequestCount();
  ctx = context();
});

afterEach(() => {
  player.restore();
  resetFetch();
  resetLimiters();
});

describe("musicbrainz", () => {
  it("reads the release the §4 inc list asks for", async () => {
    const answer = await musicbrainz.lookupRelease(ctx, RELEASE);
    const release = answer.data;
    expect(release?.title).toBe("Discovery");
    expect(release?.date).toBe("2001-02-26");
    expect(release?.country).toBe("FR");
    // The `inc` list is what makes these present at all; a thinner one silently loses them.
    expect(release?.["label-info"]?.length).toBeGreaterThan(0);
    expect(release?.["release-group"]?.["first-release-date"]).toBe("2001-02-26");
    expect(release?.media?.[0]?.tracks?.length).toBe(14);
    expect(answer.fresh).toBe(true);
  });

  it("keys the cache by entity, MBID and preset, and asks only once", async () => {
    await musicbrainz.lookupRelease(ctx, RELEASE);
    const before = requestCount();
    const again = await musicbrainz.lookupRelease(ctx, RELEASE);
    expect(requestCount()).toBe(before);
    expect(again.fresh).toBe(false);
    expect((again.data as MbRelease).title).toBe("Discovery");
    expect(await store.get("musicbrainz", `release/${RELEASE}?inc=releaseFull`)).not.toBeNull();
  });

  it("brings the recording facts a release lookup cannot: ISRCs, genres, the work", async () => {
    const recording = (await musicbrainz.lookupRecording(ctx, RECORDING)).data;
    expect(recording?.title).toBe("One More Time");
    expect(recording?.isrcs).toContain("GBAHT1305744");
    expect((recording?.genres ?? []).length).toBeGreaterThan(0);
    const work = (recording?.relations ?? []).find((rel) => rel["target-type"] === "work");
    expect(work?.work?.id).toBe(WORK);
  });

  it("reads an artist's url-rels, which is the only source of WEBSITE", async () => {
    const artist = (await musicbrainz.lookupArtist(ctx, ARTIST)) as { data: unknown };
    const relations = (artist.data as { relations?: { type?: string }[] }).relations ?? [];
    expect(relations.some((rel) => rel.type === "official homepage")).toBe(true);
    expect(relations.some((rel) => rel.type === "wikidata")).toBe(true);
  });

  it("browses an artist's release groups, and searches by Lucene query", async () => {
    const browsed = await musicbrainz.browseReleaseGroupsByArtist(ctx, ARTIST, { limit: 5 });
    expect((browsed.data?.["release-groups"] ?? []).length).toBeGreaterThan(0);

    const found = await musicbrainz.search(
      ctx,
      "release",
      `release:"Discovery" AND artist:"Daft Punk"`,
      { limit: 5 },
    );
    expect((found.data?.releases ?? []).length).toBeGreaterThan(0);
  });

  it("turns a 404 into a cached absence, so it is never asked twice", async () => {
    const missing = await musicbrainz.lookupRelease(ctx, ABSENT);
    expect(missing.data).toBeNull();
    const before = requestCount();
    const again = await musicbrainz.lookupRelease(ctx, ABSENT);
    expect(again.data).toBeNull();
    expect(requestCount()).toBe(before);
  });

  it("spells the §4 inc lists exactly", () => {
    expect(musicbrainz.incOf("releaseFull")).toBe(
      "artists+artist-credits+labels+recordings+release-groups+media+isrcs+genres+tags+aliases+artist-rels+recording-rels+work-rels+recording-level-rels+work-level-rels+url-rels",
    );
  });
});

describe("coverartarchive", () => {
  it("finds the front cover and its 1200 px thumbnail", async () => {
    const answer = await caa.index(ctx, RELEASE);
    expect((answer.data?.images ?? []).length).toBeGreaterThan(0);
    const front = caa.frontUrl(answer.data, 1200);
    expect(front).toMatch(/^https?:\/\//);
    expect(caa.imagesOfType(answer.data, "Front").length).toBeGreaterThan(0);
  });

  it("treats a 404 as a fact about the release, not as a failure", async () => {
    const answer = await caa.index(ctx, ABSENT);
    expect(answer.data).toBeNull();
    expect(caa.frontUrl(answer.data)).toBeNull();
  });
});

describe("lrclib", () => {
  it("prefers the exact lookup, and returns synchronised lyrics when there are any", async () => {
    const chosen = await lrclib.lyricsFor(ctx, {
      artist: "Daft Punk",
      track: "One More Time",
      album: "Discovery",
      durationSeconds: 320,
    });
    expect(chosen.via).toBe("get");
    expect(chosen.entry?.syncedLyrics).toContain("[00:");
    expect(chosen.entry?.instrumental).toBe(false);
  });

  it("falls back to the search, and reports nothing rather than guessing", async () => {
    const chosen = await lrclib.lyricsFor(ctx, {
      artist: "Daft Punk",
      track: "A Track That Does Not Exist At All",
      album: "Discovery",
      durationSeconds: 123,
    });
    expect(chosen.entry).toBeNull();
    expect(chosen.via).toBe("none");
  });

  it("normalises the cache key, so two spellings of one question are one row", () => {
    expect(
      lrclib.queryKey("get", {
        artist: "  Daft PUNK ",
        track: "One More Time",
        durationSeconds: 320.4,
      }),
    ).toBe("get?artist=daft punk&track=one more time&duration=320");
  });
});

describe("deezer", () => {
  it("answers by ISRC with the two fields nothing else free gives", async () => {
    const answer = await deezer.byIsrc(ctx, "GBAHT1305744");
    expect(answer.data?.title).toBe("One More Time");
    expect(answer.data?.bpm).toBeGreaterThan(0);
    expect(answer.data?.explicit_content_lyrics).toBe(0);
    expect(deezer.isDeezerMiss(answer.data)).toBe(false);
  });

  it("recognises the HTTP 200 that means 'no data'", async () => {
    const answer = await deezer.byIsrc(ctx, "ZZZZZ0000000");
    expect(answer.data?.error?.message).toBe("no data");
    expect(deezer.isDeezerMiss(answer.data)).toBe(true);
  });

  it("walks a recording's ISRCs until one answers", async () => {
    const found = await deezer.firstKnownIsrc(ctx, ["ZZZZZ0000000", "GBAHT1305744"]);
    expect(found?.isrc).toBe("GBAHT1305744");
    expect(found?.track.title).toBe("One More Time");
  });
});

describe("lastfm", () => {
  it("reads the track's top tags, counts included", async () => {
    const answer = await lastfm.trackTopTags(ctx, "Daft Punk", "One More Time");
    const tags = lastfm.tagList(answer?.data ?? null);
    expect(tags.length).toBeGreaterThan(3);
    expect(tags[0]?.name).toBe("electronic");
    expect(tags[0]?.count).toBeGreaterThan(0);
  });

  it("reads the artist's tags and the similar artists", async () => {
    expect(
      lastfm.tagList((await lastfm.artistTopTags(ctx, "Daft Punk"))?.data ?? null).length,
    ).toBeGreaterThan(0);
    const similar = await lastfm.artistSimilar(ctx, "Daft Punk", 5);
    expect((similar?.data?.similarartists?.artist ?? []).length).toBeGreaterThan(0);
  });

  it("does not ask at all when no key is configured", async () => {
    const keyless = context({ config: sourcesConfig(defaults(), {}) });
    const before = requestCount();
    expect(await lastfm.trackTopTags(keyless, "Daft Punk", "One More Time")).toBeNull();
    expect(requestCount()).toBe(before);
  });
});

describe("listenbrainz", () => {
  it("reads community tags by recording MBID, no key needed", async () => {
    const answer = await listenbrainz.recordingTags(ctx, RECORDING);
    const tags = listenbrainz.tagsOf(answer.data, RECORDING, 1);
    expect(tags.length).toBeGreaterThan(0);
  });

  it("drops tags below the vote floor", async () => {
    const answer = await listenbrainz.recordingTags(ctx, RECORDING);
    const all = listenbrainz.tagsOf(answer.data, RECORDING, 0);
    const strict = listenbrainz.tagsOf(answer.data, RECORDING, 1_000);
    expect(strict.length).toBeLessThan(all.length);
    expect(strict).toEqual([]);
  });

  it("reads the similar-artists graph P09 will need", async () => {
    const similar = await listenbrainz.similarArtists(ctx, ARTIST);
    expect((similar.data ?? []).length).toBeGreaterThan(0);
  });
});

describe("wikimedia", () => {
  it("walks MusicBrainz url-rels to Wikidata, and Wikidata's P18 to Commons", async () => {
    const artist = (await musicbrainz.lookupArtist(ctx, ARTIST)).data as never;
    expect(wikimedia.wikidataIdOf(artist)).toBe("Q185828");
    const image = await wikimedia.artistImage(ctx, artist);
    expect(image?.via).toBe("wikimedia");
    expect(image?.url).toContain("commons.wikimedia.org/wiki/Special:FilePath/");
  });

  it("builds a Commons URL that survives a file name with spaces", () => {
    expect(wikimedia.commonsUrl("Daft Punk 2013.jpg", 500)).toBe(
      "https://commons.wikimedia.org/wiki/Special:FilePath/Daft%20Punk%202013.jpg?width=500",
    );
  });
});

describe("offline", () => {
  it("serves what was cached, and refuses to invent what was not", async () => {
    await musicbrainz.lookupRelease(ctx, RELEASE);
    const offline = context({ offline: true });

    const cachedRelease = await musicbrainz.lookupRelease(offline, RELEASE);
    expect((cachedRelease.data as MbRelease).title).toBe("Discovery");

    await expect(musicbrainz.lookupRecording(offline, RECORDING)).rejects.toMatchObject({
      code: "OFFLINE_CACHE_MISS",
    });
  });

  it("makes no outgoing request at all", async () => {
    await musicbrainz.lookupRelease(ctx, RELEASE);
    const offline = context({ offline: true });
    resetRequestCount();
    await musicbrainz.lookupRelease(offline, RELEASE);
    expect(requestCount()).toBe(0);
  });
});
