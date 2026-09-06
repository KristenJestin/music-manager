/**
 * The bridge: a MusicBrainz id in, a YouTube URL out.
 *
 * The duration ranking is the part worth pinning. A YouTube search for "Daft Punk One More
 * Time" returns the album version, a radio edit, a ten-hour loop and three live rips, and the
 * only thing that reliably tells them apart is length — the same signal the matcher's mapping
 * already trusts. A test that only checked "it picked something" would pass with the ten-hour
 * loop.
 *
 * The toolbox is a stub rather than a container: this file is about what the bridge *decides*,
 * and the client itself is proven by the toolbox's own pytest suite.
 */
import { describe, expect, it } from "vitest";
import type { ToolboxClient } from "#/server/toolbox/client.ts";
import {
  FIXTURE_URL,
  pickAlbum,
  rankByDuration,
  resolveDiscoverSource,
} from "./discover.bridge.ts";

type Candidate = Parameters<typeof pickAlbum>[0][number];

const album = (over: Partial<Candidate> = {}): Candidate => ({
  kind: "album",
  title: "Discovery",
  artist: "Daft Punk",
  album: "Discovery",
  playlist_id: "OLAK5uy_kHr7Xy3l",
  track_count: 14,
  ...over,
});

/** A `ToolboxClient` with only the two methods the bridge uses. */
function stubToolbox(over: {
  ytmusic?: Candidate[];
  entries?: { title: string; webpage_url?: string | null; duration?: number | null }[];
  throws?: boolean;
}): ToolboxClient {
  return {
    searchYtMusic: () => {
      if (over.throws === true) throw new Error("the toolbox is not running");
      return Promise.resolve({ query: "q", candidates: over.ytmusic ?? [] });
    },
    extract: () => {
      if (over.throws === true) throw new Error("the toolbox is not running");
      return Promise.resolve({
        entries: (over.entries ?? []).map((entry, index) => ({
          id: `v${String(index)}`,
          index,
          title: entry.title,
          webpage_url: entry.webpage_url ?? `https://youtu.be/v${String(index)}`,
          duration: entry.duration ?? null,
        })),
      });
    },
  } as unknown as ToolboxClient;
}

describe("pickAlbum", () => {
  it("prefers the album playlist with the most tracks", () => {
    const chosen = pickAlbum([
      album({ title: "Discovery (single)", track_count: 2, playlist_id: "OLAK5uy_small" }),
      album({ title: "Discovery", track_count: 14, playlist_id: "OLAK5uy_full" }),
    ]);
    expect(chosen?.playlist_id).toBe("OLAK5uy_full");
  });

  it("ignores songs and videos — an album import needs a playlist", () => {
    expect(
      pickAlbum([album({ kind: "song", playlist_id: null, video_id: "abc" })]),
    ).toBeUndefined();
    expect(pickAlbum([album({ playlist_id: null })])).toBeUndefined();
    expect(pickAlbum([])).toBeUndefined();
  });
});

describe("rankByDuration", () => {
  it("puts the closest length first whatever order the search returned", () => {
    const ranked = rankByDuration([{ duration: 600 }, { duration: 321 }, { duration: 180 }], 320);
    expect(ranked[0]?.entry.duration).toBe(321);
    expect(ranked[0]?.delta).toBe(1);
  });

  it("sinks an entry with no duration rather than treating it as perfect", () => {
    const ranked = rankByDuration([{ duration: null }, { duration: 400 }], 320);
    expect(ranked[0]?.entry.duration).toBe(400);
    expect(ranked[1]?.delta).toBe(Number.POSITIVE_INFINITY);
  });

  it("keeps the search order when the recording length is unknown", () => {
    const ranked = rankByDuration([{ duration: 600 }, { duration: 321 }], null);
    expect(ranked[0]?.entry.duration).toBe(600);
  });
});

describe("resolveDiscoverSource", () => {
  it("turns an album into a YouTube Music playlist URL", async () => {
    const found = await resolveDiscoverSource(
      { kind: "album", artist: "Daft Punk", album: "Discovery" },
      { client: stubToolbox({ ytmusic: [album()] }), fixtures: false },
    );
    expect(found.found).toBe(true);
    expect(found.via).toBe("ytmusic");
    expect(found.url).toContain("OLAK5uy_");
    expect(found.label).toContain("14 tracks");
  });

  it("says so, rather than guessing, when YouTube Music has no album", async () => {
    const found = await resolveDiscoverSource(
      { kind: "album", artist: "Nobody", album: "Nothing" },
      { client: stubToolbox({ ytmusic: [] }), fixtures: false },
    );
    expect(found.found).toBe(false);
    expect(found.url).toBe("");
    expect(found.via).toBe("none");
  });

  it("picks the track whose length matches the recording", async () => {
    const found = await resolveDiscoverSource(
      {
        kind: "track",
        artist: "Daft Punk",
        title: "One More Time",
        durationSeconds: 320,
      },
      {
        client: stubToolbox({
          entries: [
            { title: "One More Time (10 hours)", duration: 36_000 },
            { title: "One More Time", duration: 321 },
            { title: "One More Time (Radio Edit)", duration: 240 },
          ],
        }),
        fixtures: false,
      },
    );
    expect(found.via).toBe("ytsearch");
    expect(found.durationDelta).toBe(1);
    expect(found.label).toContain("1s off");
  });

  it("falls back to a YouTube Music song when the search returns nothing usable", async () => {
    const found = await resolveDiscoverSource(
      { kind: "track", artist: "Daft Punk", title: "One More Time" },
      {
        client: stubToolbox({
          entries: [],
          ytmusic: [
            album({ kind: "song", playlist_id: null, video_id: "xyz", title: "One More Time" }),
          ],
        }),
        fixtures: false,
      },
    );
    expect(found.found).toBe(true);
    expect(found.url).toContain("xyz");
  });

  it("resolves to the offline fixture in fixtures mode, while still reporting what it found", async () => {
    const found = await resolveDiscoverSource(
      { kind: "album", artist: "Daft Punk", album: "Discovery" },
      { client: stubToolbox({ ytmusic: [album()] }), fixtures: true },
    );
    expect(found.url).toBe(FIXTURE_URL);
    expect(found.via).toBe("fixtures");
    // The badge stays honest: the search really did find the album.
    expect(found.found).toBe(true);
    expect(found.label).toContain("OLAK5uy_");
  });

  it("still imports the fixture when the toolbox is down in fixtures mode", async () => {
    const found = await resolveDiscoverSource(
      { kind: "album", artist: "Daft Punk", album: "Discovery" },
      { client: stubToolbox({ throws: true }), fixtures: true },
    );
    expect(found.url).toBe(FIXTURE_URL);
    expect(found.found).toBe(false);
  });

  it("reports a stopped toolbox as an answer, not a crash", async () => {
    const found = await resolveDiscoverSource(
      { kind: "album", artist: "Daft Punk", album: "Discovery" },
      { client: stubToolbox({ throws: true }), fixtures: false },
    );
    expect(found.url).toBe("");
    expect(found.label.length).toBeGreaterThan(0);
  });
});
