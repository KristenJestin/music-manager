import { describe, expect, it } from "vitest";
import { albumSourceLink, isPlaylistUrl, isWebUrl, webpageUrlOf } from "./source-url.ts";

const OLAK = "https://music.youtube.com/playlist?list=OLAK5uy_kHr7Xy3l-yQo1cV6XFAAWz-zLdlaBWYI";
const WATCH = "https://www.youtube.com/watch?v=eZKgoOjJmrp";

describe("isPlaylistUrl", () => {
  it("recognises YouTube Music's album playlists", () => {
    expect(isPlaylistUrl(OLAK)).toBe(true);
    expect(isPlaylistUrl("https://www.youtube.com/playlist?list=PL1234")).toBe(true);
  });

  it("recognises a watch URL opened inside a playlist", () => {
    expect(isPlaylistUrl("https://www.youtube.com/watch?v=abc&list=PL1234")).toBe(true);
  });

  it("does not mistake a lone video for a listing", () => {
    expect(isPlaylistUrl(WATCH)).toBe(false);
    expect(isPlaylistUrl("https://youtu.be/eZKgoOjJmrp")).toBe(false);
    expect(isPlaylistUrl(null)).toBe(false);
  });
});

describe("isWebUrl", () => {
  it("accepts http and https only", () => {
    expect(isWebUrl(WATCH)).toBe(true);
    expect(isWebUrl("http://example.test/a")).toBe(true);
  });

  it("refuses the provenance that is not a destination", () => {
    // Fixtures mode submits this, and it must never become a link.
    expect(isWebUrl("fixture://discovery")).toBe(false);
    expect(isWebUrl("")).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });
});

describe("webpageUrlOf", () => {
  it("reads the yt-dlp entry kept in import_tracks.raw", () => {
    expect(webpageUrlOf({ id: "x", webpage_url: WATCH })).toBe(WATCH);
  });

  it("is null for a raw that has none, and for anything that is not an object", () => {
    expect(webpageUrlOf({})).toBeNull();
    expect(webpageUrlOf({ webpage_url: "" })).toBeNull();
    expect(webpageUrlOf(null)).toBeNull();
  });
});

describe("albumSourceLink", () => {
  it("prefers the submitted playlist — that is the link somebody wants back", () => {
    expect(albumSourceLink(OLAK, [WATCH])).toEqual({
      url: OLAK,
      kind: "playlist",
      label: "Open the source playlist on YouTube",
    });
  });

  it("falls back to the first track's video when the submission was one video", () => {
    const link = albumSourceLink(WATCH, [WATCH]);
    expect(link?.kind).toBe("video");
    expect(link?.url).toBe(WATCH);
  });

  it("falls back to the video when the submission is not a web address at all", () => {
    // What fixtures mode produces: `imports.url` is `fixture://discovery`, and the entries
    // still carry the realistic `webpage_url` the recorded listing was made with.
    const link = albumSourceLink("fixture://discovery", [WATCH, "https://youtu.be/second"]);
    expect(link).toEqual({
      url: WATCH,
      kind: "video",
      label: "Open the source video on YouTube",
    });
  });

  it("skips tracks with no usable entry rather than giving up", () => {
    expect(
      albumSourceLink("fixture://discovery", [null, "fixture://discovery#1", WATCH])?.url,
    ).toBe(WATCH);
  });

  it("links the migrated-from-v1 album to the v1 parent playlist", () => {
    // `imports.url` is the v1 `SourceUrlParent`; `raw.webpage_url` is the fabricated entry's
    // `SourceUrl`, which is a real video URL built from the video id.
    const link = albumSourceLink("https://www.youtube.com/playlist?list=OLAK5uy_v1discovery", [
      "https://www.youtube.com/watch?v=dpDiscovery01",
    ]);
    expect(link?.kind).toBe("playlist");
    expect(link?.url).toContain("OLAK5uy_v1discovery");
  });

  it("links a migrated v1 song with no parent to its own video", () => {
    const link = albumSourceLink("https://www.youtube.com/watch?v=lonely01", [
      "https://www.youtube.com/watch?v=lonely01",
    ]);
    expect(link?.kind).toBe("video");
  });

  it("says nothing when the provenance names nothing openable", () => {
    expect(albumSourceLink("fixture://discovery", [null, null])).toBeNull();
    expect(albumSourceLink(null, [])).toBeNull();
  });
});
