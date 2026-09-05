/**
 * Completeness, against the numbers `docs/phases/P01-domaine.md` asks for.
 */

import { describe, expect, it } from "vitest";

import { albumTrack, nightvision, oneMoreTime } from "../testing/discovery.ts";
import { LEVEL_WEIGHT, TAGS } from "../tagmap/tags.ts";
import { albumCompleteness, profileCompleteness, trackCompleteness } from "./index.ts";
import { profileById } from "../tagmap/profiles.ts";
import { emptyDocument } from "../metadata/document.ts";

describe("trackCompleteness — Discovery, track 1", () => {
  const report = trackCompleteness(oneMoreTime());

  it("scores at least 0.95 globally", () => {
    expect(report.score).not.toBeNull();
    expect(report.score ?? 0).toBeGreaterThanOrEqual(0.95);
  });

  it("accounts for every field of the map exactly once", () => {
    expect(report.fields).toHaveLength(TAGS.length);
    expect(report.present.length + report.missing.length + report.na.length).toBe(TAGS.length);
  });

  it("names what is still missing rather than hiding it", () => {
    // WEBSITE comes from the *artist*'s url-rels, which a release lookup does not carry: the
    // fact exists in MusicBrainz and we have not asked for it, so it is missing, not n/a.
    expect(report.missing).toEqual(["website"]);
  });

  it("puts the sourceless fields in n/a, with a reason", () => {
    const reasons = new Map(
      report.fields.filter((f) => f.state === "na").map((f) => [f.field, f.reason]),
    );
    expect(reasons.get("license")).toBe("the release has no licence URL");
    expect(reasons.get("djmixer")).toContain("no such credit relation");
    expect(reasons.get("key")).toContain("off by default");
    expect(reasons.get("acoustid_fingerprint")).toContain("opt-in");
    for (const report_ of report.fields.filter((f) => f.state === "na")) {
      expect(report_.reason, `${report_.field} is n/a without a reason`).toBeTruthy();
    }
  });

  it("weights required 3, recommended 2, optional 1 (§6)", () => {
    const applicable = report.fields
      .filter((f) => f.state !== "na")
      .reduce((total, f) => total + LEVEL_WEIGHT[f.level], 0);
    expect(report.applicable).toBe(applicable);
  });
});

describe("profileCompleteness", () => {
  const document = oneMoreTime();
  const global = trackCompleteness(document);

  it("scores Plex above the global score, because Plex ignores the MBIDs (§5)", () => {
    const plex = global.byProfile.plex.score;
    expect(plex).not.toBeNull();
    expect(plex ?? 0).toBeGreaterThan(global.score ?? 1);
  });

  it("never counts a field the profile does not read", () => {
    const plex = profileById("plex");
    const report = profileCompleteness(document, plex);
    const counted = new Set([...report.present, ...report.missing, ...report.na]);
    for (const field of counted) expect(plex.reads).toContain(field);
    // The MusicBrainz identifiers are written, and simply do not appear in Plex's reading.
    for (const field of counted) expect(field.startsWith("musicbrainz_")).toBe(false);
  });

  it("scores Navidrome, the verified profile, at least as well as the global score", () => {
    expect(global.byProfile.navidrome.score ?? 0).toBeGreaterThanOrEqual(global.score ?? 1);
  });

  it("returns null rather than 0 when nothing applies", () => {
    expect(trackCompleteness(emptyDocument(1)).score).toBe(0);
    expect(
      profileCompleteness(emptyDocument(1), { ...profileById("plex"), reads: [] }).score,
    ).toBeNull();
  });
});

describe("instrumental tracks", () => {
  it("marks LYRICS n/a, not missing (§6)", () => {
    const report = trackCompleteness(nightvision());
    expect(report.na).toContain("lyrics");
    expect(report.missing).not.toContain("lyrics");
    const lyrics = report.fields.find((f) => f.field === "lyrics");
    expect(lyrics?.state).toBe("na");
    expect(lyrics?.reason).toBe("LRCLIB marks this track instrumental");
  });

  it("does not punish the score for the absent lyrics", () => {
    const withLyrics = trackCompleteness(oneMoreTime());
    const instrumental = trackCompleteness(nightvision());
    expect(instrumental.applicable).toBeLessThan(withLyrics.applicable);
    expect(instrumental.missing).not.toContain("lyrics");
  });
});

describe("albumCompleteness", () => {
  const tracks = [1, 2, 3].map(albumTrack);

  it("averages the tracks and reports the album-scope divergences", () => {
    const album = albumCompleteness(tracks);
    expect(album.meanTrackScore).not.toBeNull();
    // Discovery's tracks carry per-recording genres, which is exactly the drift §2 warns about.
    expect(album.divergentFields).toContain("genre");
    expect(album.penalty).toBeGreaterThan(0);
    expect(album.score ?? 1).toBeLessThan(album.meanTrackScore ?? 0);
  });

  it("applies no penalty to a consistent album", () => {
    const one = albumTrack(1);
    const album = albumCompleteness([one, one]);
    expect(album.divergentFields).toEqual([]);
    expect(album.penalty).toBe(0);
    expect(album.score).toBe(album.meanTrackScore);
  });

  it("scores an empty album as null rather than 0", () => {
    expect(albumCompleteness([]).score).toBeNull();
  });
});
