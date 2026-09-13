/**
 * The Deezer preview resolver, against recorded answers.
 *
 * Same contract as `clients.test.ts`: the code under test is the production resolver — its
 * queries, its cache keys, its scoring — and only the socket is replaced. Two cassettes are
 * mounted, because the resolver genuinely uses two sources: Deezer for the audio and
 * MusicBrainz for the recording length that tells the album cut from the radio edit.
 *
 * The `preview` URLs on the tape are expired signed CDN tickets and nothing here fetches them;
 * what is asserted is *which* track was chosen, which is the part that can be wrong.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memoryStore, type CacheStore } from "#/server/integrations/cached.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import { resetFetch, resetLimiters, setLimiter } from "#/server/integrations/http.ts";
import { defaults } from "#/server/services/settings.ts";
import { resolvePreview } from "#/server/services/preview.ts";
import { play, type Player } from "../cassette.ts";

/** Daft Punk — "One More Time", the recording the whole fixture set is built on. */
const RECORDING = "60fa767a-d85d-4991-82bc-4294e0b11ae7";
const RELEASE_GROUP = "48117b90-a16e-34ca-a514-19c702df1158";
const ARTIST = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

let player: Player;
let store: CacheStore;
let ctx: SourceContext;

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
  player = play("deezer-preview", "musicbrainz");
  store = memoryStore();
  resetLimiters();
  setLimiter("deezer", 0);
  setLimiter("musicbrainz", 0);
  ctx = context();
});

afterEach(() => {
  player.restore();
  resetFetch();
  resetLimiters();
});

describe("resolvePreview", () => {
  it("picks the recording whose duration matches MusicBrainz, not the radio edit", async () => {
    const tracks = await resolvePreview(ctx, {
      subject: `recording:${RECORDING}`,
      title: "One More Time",
      artist: "Daft Punk",
      albumTitle: "Discovery",
    });

    expect(tracks).not.toBeNull();
    expect(tracks).toHaveLength(1);
    const track = tracks?.[0];
    expect(track?.title).toBe("One More Time");
    expect(track?.artist).toBe("Daft Punk");
    expect(track?.source).toBe("deezer");
    expect(track?.src).toMatch(/^https:\/\/.*\.mp3/);
    // The album cut is 320 s; the "Short Radio Edit" in the same answer is 235 s. The duration
    // term is the whole reason the right one wins, so assert the number, not just the title.
    expect(track?.durationSeconds).toBe(320);
    expect(track?.id).toBe("deezer:3135553");
  });

  it("returns the album's tracklist, in order, for a release-group", async () => {
    const tracks = await resolvePreview(ctx, {
      subject: `release-group:${RELEASE_GROUP}`,
      title: "Discovery",
      artist: "Daft Punk",
      albumTitle: "Discovery",
    });

    expect(tracks).not.toBeNull();
    expect(tracks?.length).toBe(14);
    expect(tracks?.[0]?.title).toBe("One More Time");
    expect(tracks?.[1]?.title).toBe("Aerodynamic");
    // Every entry is playable, which is what "queue the album" depends on.
    for (const track of tracks ?? []) {
      expect(track.src).toMatch(/^https:\/\//);
      expect(track.source).toBe("deezer");
    }
  });

  it("returns the artist's top tracks for an artist subject", async () => {
    const tracks = await resolvePreview(ctx, {
      subject: `artist:${ARTIST}`,
      title: "Daft Punk",
      artist: "Daft Punk",
    });

    expect(tracks).not.toBeNull();
    expect(tracks?.length).toBeGreaterThan(1);
    expect(tracks?.every((track) => track.src !== "")).toBe(true);
  });

  it("answers null when Deezer has nothing, rather than throwing", async () => {
    const tracks = await resolvePreview(ctx, {
      subject: `recording:${RECORDING}`,
      title: "Zzzqqx Nonexistent Track",
      artist: "Zzzqqx Nonexistent Artist",
    });

    expect(tracks).toBeNull();
  });

  it("answers null for a subject it does not understand, and asks nothing", async () => {
    const before = player.plays();
    expect(await resolvePreview(ctx, { subject: "work:whatever", title: "x", artist: "y" })).toBe(
      null,
    );
    expect(player.plays()).toBe(before);
  });

  it("answers null when Deezer is switched off in the settings", async () => {
    const off = context({
      config: sourcesConfig({
        ...defaults(),
        sourcesEnabled: { ...defaults().sourcesEnabled, deezer: false },
      }),
    });
    expect(
      await resolvePreview(off, {
        subject: `recording:${RECORDING}`,
        title: "One More Time",
        artist: "Daft Punk",
      }),
    ).toBeNull();
  });
});
