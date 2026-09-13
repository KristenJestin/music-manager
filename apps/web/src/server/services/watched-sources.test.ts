// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  classifyWatchedUrl,
  entryImportUrl,
  verdictFor,
  watchedSourceInputSchema,
} from "./watched-sources.ts";
import type { WatchedSource } from "#/server/db/schema/index.ts";
import type { ExtractEntry } from "#/server/toolbox/client.ts";

/**
 * The pure half of a watched source: what its URL is, what one entry becomes, and which
 * videos a scan is allowed to walk past.
 *
 * The filters are the only place in this feature where something is discarded without being
 * shown to anybody, so each one has to say why in a sentence the row keeps — these tests pin
 * the sentence as much as the verdict.
 */

const SOURCE: WatchedSource = {
  id: "wsr_1",
  url: "https://www.youtube.com/@artist",
  kind: "channel",
  label: "",
  enabled: true,
  autoAccept: false,
  autoAcceptThreshold: null,
  minDuration: null,
  maxDuration: null,
  requireProvidedToYouTube: false,
  lastScanAt: null,
  lastScanStatus: "never",
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function entry(patch: Partial<ExtractEntry> = {}): ExtractEntry {
  return {
    id: "vid00000001",
    title: "Artist - Song",
    duration: 210,
    uploader: "Artist - Topic",
    index: 0,
    track: null,
    artist: null,
    album: null,
    release_year: null,
    description: null,
    thumbnails: [],
    webpage_url: "https://www.youtube.com/watch?v=vid00000001",
    playlist_index: 1,
    availability: "public",
    unavailable: false,
    ...patch,
  } as ExtractEntry;
}

describe("classifyWatchedUrl", () => {
  it("reads a channel off its URL shape, and calls everything else a playlist", () => {
    expect(classifyWatchedUrl("https://www.youtube.com/@daftpunk")).toBe("channel");
    expect(classifyWatchedUrl("https://www.youtube.com/channel/UC123")).toBe("channel");
    expect(classifyWatchedUrl("https://www.youtube.com/c/daftpunk")).toBe("channel");
    expect(classifyWatchedUrl("https://www.youtube.com/playlist?list=OLAK5uy_x")).toBe("playlist");
    expect(classifyWatchedUrl("fixture://watched?snapshot=1")).toBe("playlist");
  });
});

describe("watchedSourceInputSchema", () => {
  it("refuses anything that is not a URL this app could ever scan", () => {
    expect(watchedSourceInputSchema.safeParse({ url: "daft punk" }).success).toBe(false);
    expect(watchedSourceInputSchema.safeParse({ url: "  " }).success).toBe(false);
    expect(
      watchedSourceInputSchema.safeParse({ url: "https://www.youtube.com/@artist" }).success,
    ).toBe(true);
  });

  it("keeps the auto-accept threshold inside [0, 1], and lets it be cleared", () => {
    const base = { url: "https://www.youtube.com/@artist" };
    expect(watchedSourceInputSchema.safeParse({ ...base, autoAcceptThreshold: 1.2 }).success).toBe(
      false,
    );
    expect(watchedSourceInputSchema.safeParse({ ...base, autoAcceptThreshold: null }).success).toBe(
      true,
    );
  });
});

describe("entryImportUrl", () => {
  it("prefers the URL the listing gave, and builds a watch URL when it gave none", () => {
    expect(entryImportUrl(entry({ webpage_url: "fixture://skinny-love" }))).toBe(
      "fixture://skinny-love",
    );
    expect(entryImportUrl(entry({ webpage_url: null }))).toBe(
      "https://www.youtube.com/watch?v=vid00000001",
    );
    expect(entryImportUrl(entry({ webpage_url: null, id: "" }))).toBeNull();
  });
});

describe("verdictFor", () => {
  it("accepts an ordinary music video", () => {
    expect(verdictFor(entry(), SOURCE).accept).toBe(true);
  });

  it("skips an entry YouTube will not serve, and says which kind", () => {
    const verdict = verdictFor(entry({ unavailable: true, availability: "private" }), SOURCE);
    expect(verdict.accept).toBe(false);
    expect(verdict.reason).toContain("private");
  });

  it("skips the things a channel carries that are not records", () => {
    for (const title of [
      "Artist — Interview with NME",
      "Album trailer",
      "Behind the scenes of the video",
      "Tour announcement 2026",
      "Dancing #shorts",
    ]) {
      expect(verdictFor(entry({ title }), SOURCE).accept).toBe(false);
    }
  });

  it("does not treat a live album as a non-record", () => {
    expect(verdictFor(entry({ title: "Artist - Song (Live at Hyde Park)" }), SOURCE).accept).toBe(
      true,
    );
  });

  it("applies the duration floor and ceiling, and names the number it refused", () => {
    const source = { ...SOURCE, minDuration: 60, maxDuration: 600 };
    expect(verdictFor(entry({ duration: 30 }), source).reason).toContain("60s floor");
    expect(verdictFor(entry({ duration: 1200 }), source).reason).toContain("600s ceiling");
    expect(verdictFor(entry({ duration: 210 }), source).accept).toBe(true);
  });

  it("lets a duration-less entry through rather than guessing about it", () => {
    // A flat listing genuinely does not always know the duration. Refusing on a `null` would
    // silently drop every entry of a source whose extractor stopped reporting it.
    const source = { ...SOURCE, minDuration: 60 };
    expect(verdictFor(entry({ duration: null }), source).accept).toBe(true);
  });
});
