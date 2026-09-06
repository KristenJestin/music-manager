/**
 * The weighting, and the two ways of getting a listening total wrong.
 *
 * The interesting assertions here are the negative ones: that Discovery appearing in four
 * Subsonic views is 128 plays and not 512, and that reading an artist's top songs does not add
 * their counters to the album counter that already contains them. Both bugs produce a page
 * that looks entirely plausible — the ordering is even roughly right — which is exactly why
 * they need a test rather than a reading.
 */
import { describe, expect, it } from "vitest";
import {
  aggregate,
  affectionWeight,
  observationOfAlbum,
  observationOfSong,
  recencyWeight,
  sourceStrip,
  type Observation,
} from "./signals.ts";
import { defaults } from "./settings.ts";
import { cassetteFetch, loadCassette } from "#/server/integrations/navidrome/cassettes.ts";
import { NavidromeClient } from "#/server/integrations/navidrome/client.ts";

const NOW = new Date("2026-09-06T00:00:00Z");

const observation = (over: Partial<Observation> = {}): Observation => ({
  id: over.id ?? "album:1",
  artist: "Daft Punk",
  album: "Discovery",
  genres: ["french house"],
  playCount: 100,
  played: "2026-09-05T00:00:00Z",
  starred: false,
  rating: null,
  ...over,
});

describe("recencyWeight", () => {
  it("is 1 inside the window", () => {
    expect(recencyWeight("2026-08-20T00:00:00Z", NOW, 30)).toBe(1);
  });

  it("halves once per window past the edge", () => {
    // 60 days old, 30-day window: one window past ⇒ a half.
    expect(recencyWeight("2026-07-08T00:00:00Z", NOW, 30)).toBeCloseTo(0.5, 2);
    // 90 days old: two windows past ⇒ a quarter.
    expect(recencyWeight("2026-06-08T00:00:00Z", NOW, 30)).toBeCloseTo(0.25, 2);
  });

  it("never reaches zero — a hard cut-off would flip the page on one date", () => {
    expect(recencyWeight("2019-01-01T00:00:00Z", NOW, 30)).toBeGreaterThan(0);
  });

  it("gives half a voice to a play the server never dated", () => {
    expect(recencyWeight(null, NOW, 30)).toBe(0.5);
    expect(recencyWeight("not a date", NOW, 30)).toBe(0.5);
  });
});

describe("affectionWeight", () => {
  it("multiplies, and never filters", () => {
    expect(affectionWeight(false, null)).toBe(1);
    expect(affectionWeight(true, null)).toBeCloseTo(1.25, 5);
    expect(affectionWeight(false, 5)).toBeCloseTo(1.2, 5);
    expect(affectionWeight(false, 1)).toBeCloseTo(0.88, 5);
    // A one-star record still counts for something; it is a signal, not a veto.
    expect(affectionWeight(false, 1)).toBeGreaterThan(0);
  });
});

describe("aggregate", () => {
  it("counts an entity once however many views returned it", () => {
    const four = [
      observation({ id: "album:1" }),
      observation({ id: "album:1" }),
      observation({ id: "album:1" }),
      observation({ id: "album:1" }),
    ];
    const one = aggregate([observation({ id: "album:1" })], { now: NOW, windowDays: 30 });
    const many = aggregate(four, { now: NOW, windowDays: 30 });
    expect(many.totalPlays).toBe(one.totalPlays);
    expect(many.artists[0]?.plays).toBe(100);
  });

  it("sums distinct entities, and sorts artists by weighted plays", () => {
    const folded = aggregate(
      [
        observation({ id: "album:1", artist: "Daft Punk", playCount: 100 }),
        observation({ id: "album:2", artist: "Justice", playCount: 140 }),
        observation({ id: "album:3", artist: "Daft Punk", album: "Homework", playCount: 60 }),
      ],
      { now: NOW, windowDays: 30 },
    );
    expect(folded.artists.map((artist) => artist.name)).toEqual(["Daft Punk", "Justice"]);
    expect(folded.artists[0]?.plays).toBe(160);
    expect(folded.artists[0]?.albums).toBe(2);
  });

  it("folds artist names case-insensitively but keeps the first spelling", () => {
    const folded = aggregate(
      [
        observation({ id: "a", artist: "Daft Punk" }),
        observation({ id: "b", artist: "daft punk" }),
      ],
      { now: NOW, windowDays: 30 },
    );
    expect(folded.artists).toHaveLength(1);
    expect(folded.artists[0]?.name).toBe("Daft Punk");
  });

  it("takes genres from every observation, weighted by the same plays", () => {
    const folded = aggregate(
      [
        observation({ id: "a", genres: ["French House", "Electronic"], playCount: 10 }),
        observation({ id: "b", genres: ["electronic"], playCount: 5, artist: "Air" }),
      ],
      { now: NOW, windowDays: 30 },
    );
    expect(folded.genres.map((genre) => genre.name)).toEqual(["electronic", "french house"]);
    expect(folded.genres[0]?.plays).toBe(15);
  });

  it("uses a newer top-song play than the album row knows about", () => {
    const stale = observation({ id: "album:1", played: "2026-06-01T00:00:00Z" });
    const without = aggregate([stale], { now: NOW, windowDays: 30 });
    const with_ = aggregate([stale], {
      now: NOW,
      windowDays: 30,
      latestPlayed: new Map([["daft punk", "2026-09-05T00:00:00Z"]]),
    });
    // Same play count, better recency: the shuffle play is what makes it current again.
    expect(with_.artists[0]?.plays).toBeGreaterThan(without.artists[0]?.plays ?? 0);
    expect(with_.artists[0]?.plays).toBe(100);
  });

  it("ignores an older top-song play", () => {
    const fresh = observation({ id: "album:1", played: "2026-09-05T00:00:00Z" });
    const folded = aggregate([fresh], {
      now: NOW,
      windowDays: 30,
      latestPlayed: new Map([["daft punk", "2020-01-01T00:00:00Z"]]),
    });
    expect(folded.artists[0]?.plays).toBe(100);
  });

  it("drops an artist with no name and an entity with no plays", () => {
    const folded = aggregate(
      [observation({ id: "a", artist: "  " }), observation({ id: "b", playCount: 0 })],
      { now: NOW, windowDays: 30 },
    );
    expect(folded.artists).toEqual([]);
    expect(folded.totalPlays).toBe(0);
  });
});

describe("the Subsonic projection", () => {
  it("reads the union of `genre` and `genres`, and a star as a boolean", () => {
    const one = observationOfAlbum({
      id: "x",
      name: "Discovery",
      artist: "Daft Punk",
      genre: "French House",
      genres: [{ name: "Electronic" }],
      playCount: 12,
      played: "2026-09-01T00:00:00Z",
      starred: "2026-02-11T09:03:00Z",
      userRating: 5,
    });
    expect(one).toMatchObject({
      id: "album:x",
      artist: "Daft Punk",
      genres: ["French House", "Electronic"],
      starred: true,
      rating: 5,
    });
  });

  it("treats an absent counter as zero rather than as a missing artist", () => {
    const one = observationOfSong({ id: "s", title: "Nightvision", artist: "Daft Punk" });
    expect(one).toMatchObject({ id: "song:s", playCount: 0, starred: false, rating: null });
  });
});

describe("against the recorded Navidrome", () => {
  const client = new NavidromeClient(
    { url: "http://navidrome.invalid", user: "kris", password: "secret" },
    { fetch: cassetteFetch(loadCassette("discover")), salt: () => "fixedsalt" },
  );

  it("reads the four views the phase names", async () => {
    const frequent = await client.getAlbumList2({ type: "frequent", size: 50 });
    const recent = await client.getAlbumList2({ type: "recent", size: 50 });
    const starredList = await client.getAlbumList2({ type: "starred", size: 50 });
    const starred = await client.getStarred2();
    const top = await client.getTopSongs("Daft Punk", 20);

    expect(frequent.length).toBeGreaterThan(1);
    expect(recent.length).toBeGreaterThan(0);
    expect(starredList.length).toBeGreaterThan(0);
    expect(starred.song.length).toBeGreaterThan(0);
    expect(top.length).toBeGreaterThan(0);
    expect(frequent[0]?.playCount).toBeGreaterThan(0);
  });

  it("folds the overlapping views into one honest total", async () => {
    const observations: Observation[] = [];
    for (const type of ["frequent", "recent", "starred"] as const) {
      for (const album of await client.getAlbumList2({ type, size: 50 })) {
        observations.push(observationOfAlbum(album));
      }
    }
    for (const album of (await client.getStarred2()).album) {
      observations.push(observationOfAlbum(album));
    }

    const folded = aggregate(observations, { now: NOW, windowDays: 30 });
    const daft = folded.artists.find((artist) => artist.name === "Daft Punk");
    // Discovery is in all four views with playCount 128, starred, rated 5:
    // 128 × 1.25 × 1.2 = 192 — not 4 × 192.
    expect(daft?.plays).toBe(192);
    expect(folded.genres[0]?.name).toBe("french house");
  });
});

describe("the sources strip", () => {
  it("says why a source is silent rather than showing it as healthy", () => {
    const strip = sourceStrip(
      { ...defaults(), listenbrainzUser: "" },
      {
        navidrome: "off",
        metric: "—",
      },
    );
    expect(strip.map((source) => source.status)).toEqual(["off", "off", "fallback"]);
    expect(strip[1]?.detail).toContain("no ListenBrainz user");
  });

  it("names the user once one is set", () => {
    const strip = sourceStrip(
      { ...defaults(), listenbrainzUser: "kris" },
      {
        navidrome: "ok",
        metric: "1 200 weighted plays",
      },
    );
    expect(strip[1]?.status).toBe("ok");
    expect(strip[1]?.detail).toContain("kris");
  });
});
