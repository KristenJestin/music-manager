import { describe, expect, it } from "vitest";

import {
  albumFolder,
  bookletPath,
  sanitizeSegment,
  sidecarPaths,
  trackFileName,
  trackPath,
  type TrackPathInput,
} from "./index.ts";

const discovery: TrackPathInput = {
  albumArtist: "Daft Punk",
  album: "Discovery",
  year: 2001,
  discNumber: 1,
  totalDiscs: 1,
  trackNumber: 1,
  title: "One More Time",
  extension: "opus",
};

describe("trackPath", () => {
  it("renders the layout of docs/04, step `place`", () => {
    expect(trackPath(discovery)).toBe("Daft Punk/Discovery (2001)/01 - One More Time.opus");
  });

  it("pads the track number to two digits so players sort correctly", () => {
    expect(trackFileName({ ...discovery, trackNumber: 9 })).toBe("09 - One More Time.opus");
    expect(trackFileName({ ...discovery, trackNumber: 14 })).toBe("14 - One More Time.opus");
    expect(trackFileName({ ...discovery, trackNumber: 101 })).toBe("101 - One More Time.opus");
  });

  it("adds the disc prefix only when the release has several discs", () => {
    expect(trackFileName({ ...discovery, totalDiscs: 1, discNumber: 1 })).toBe(
      "01 - One More Time.opus",
    );
    expect(trackFileName({ ...discovery, totalDiscs: 2, discNumber: 2, trackNumber: 3 })).toBe(
      "2-03 - One More Time.opus",
    );
  });

  it("omits the year when it is unknown", () => {
    const { year: _dropped, ...noYear } = discovery;
    expect(albumFolder(noYear)).toBe("Daft Punk/Discovery");
  });
});

describe("sanitizeSegment", () => {
  it("replaces the path separators, whatever the mode", () => {
    for (const mode of ["unicode", "windows", "strict"] as const) {
      expect(sanitizeSegment("AC/DC", { mode })).toBe("AC-DC");
      expect(sanitizeSegment("a\\b", { mode })).toBe("a-b");
    }
  });

  it("keeps Unicode in `unicode` mode and folds it in `strict`", () => {
    expect(sanitizeSegment("Café del Mar", { mode: "unicode" })).toBe("Café del Mar");
    expect(sanitizeSegment("Café del Mar", { mode: "strict" })).toBe("Cafe del Mar");
    expect(sanitizeSegment("Sigur Rós", { mode: "strict" })).toBe("Sigur Ros");
  });

  it("drops the characters Windows forbids, but only outside `unicode` mode", () => {
    expect(sanitizeSegment('Who? What: "Yes"', { mode: "windows" })).toBe("Who- What- -Yes-");
    expect(sanitizeSegment('Who? What: "Yes"', { mode: "unicode" })).toBe('Who? What: "Yes"');
  });

  it("neutralises the Windows device names", () => {
    expect(sanitizeSegment("CON")).toBe("CON-");
    expect(sanitizeSegment("nul")).toBe("nul-");
    expect(sanitizeSegment("CONCERT")).toBe("CONCERT");
    expect(sanitizeSegment("CON", { mode: "unicode" })).toBe("CON");
  });

  it("trims the trailing dots and spaces Explorer silently drops", () => {
    expect(sanitizeSegment("Untitled.")).toBe("Untitled");
    expect(sanitizeSegment("Untitled ")).toBe("Untitled");
    expect(sanitizeSegment("Untitled...", { mode: "unicode" })).toBe("Untitled...");
  });

  it("collapses whitespace and trims", () => {
    expect(sanitizeSegment("  Too    Long  ")).toBe("Too Long");
  });

  it("truncates a segment that would exceed the filesystem limit", () => {
    const long = "x".repeat(400);
    expect(sanitizeSegment(long).length).toBe(200);
    expect(sanitizeSegment(long, { maxSegmentLength: 20 }).length).toBe(20);
  });

  it("never returns an empty segment", () => {
    expect(sanitizeSegment("")).toBe("_");
    expect(sanitizeSegment("...")).toBe("_");
    expect(sanitizeSegment("///")).toBe("---");
  });

  it("is idempotent", () => {
    for (const raw of ["AC/DC: Live", "CON", "Café ", "x".repeat(400)]) {
      expect(sanitizeSegment(sanitizeSegment(raw))).toBe(sanitizeSegment(raw));
    }
  });
});

describe("sidecarPaths", () => {
  const paths = sidecarPaths(discovery);

  it("puts the album images beside the tracks and the artist image one level up (§3)", () => {
    expect(paths.cover).toBe("Daft Punk/Discovery (2001)/cover.jpg");
    expect(paths.back).toBe("Daft Punk/Discovery (2001)/back.jpg");
    expect(paths.medium).toBe("Daft Punk/Discovery (2001)/medium.jpg");
    expect(paths.artistImage).toBe("Daft Punk/artist.jpg");
  });

  it("names the NFO files the way Kodi expects", () => {
    expect(paths.albumNfo).toBe("Daft Punk/Discovery (2001)/album.nfo");
    expect(paths.artistNfo).toBe("Daft Punk/artist.nfo");
  });

  it("names the .lrc after the audio file, which is what readers look for", () => {
    expect(paths.lyrics).toBe("Daft Punk/Discovery (2001)/01 - One More Time.lrc");
    expect(paths.lyrics.replace(/\.lrc$/, ".opus")).toBe(trackPath(discovery));
  });

  it("numbers the booklet pages", () => {
    expect(bookletPath(discovery, 1)).toBe("Daft Punk/Discovery (2001)/booklet-01.jpg");
    expect(bookletPath(discovery, 12)).toBe("Daft Punk/Discovery (2001)/booklet-12.jpg");
  });
});

describe("hostile names", () => {
  it("survives a title that is nothing but forbidden characters", () => {
    const path = trackPath({ ...discovery, title: "???", albumArtist: "//" });
    expect(path.split("/").filter((segment) => segment === "")).toHaveLength(0);
    expect(path).toBe("--/Discovery (2001)/01 - ---.opus");
  });

  it("never produces a segment that escapes the library root", () => {
    const path = trackPath({ ...discovery, album: "../../etc", albumArtist: ".." });
    expect(path.split("/")).not.toContain("..");
  });
});
