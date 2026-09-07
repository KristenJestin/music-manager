/**
 * Completeness, the three things the Console keeps apart, and the filters over them.
 *
 * The arithmetic of §6 belongs to `@mm/domain` and is tested there. What is tested here is
 * the *aggregation*: turning a set of documents and a set of library rows into the row a
 * person reads, without ever confusing "the sources never had it" with "the file has not
 * caught up" or with "something changed the file behind our back".
 */
import { describe, expect, it } from "vitest";
import { field, projectDocument, type TrackDocument } from "@mm/domain";
import type { LibraryAlbum, LibraryTrack } from "#/server/db/schema/index.ts";
import { projectionHash } from "#/server/services/jobs/steps/tag.ts";
import {
  actionFor,
  matchesFilter,
  RETAG_ACTION,
  scoreAlbum,
  summarise,
  tagMapRows,
  type LoadedTrack,
} from "./quality.ts";

const AT = "2026-09-05T00:00:00.000Z";

/** A minimal but real document: enough fields that the score is not zero or one. */
function document(overrides: Record<string, unknown> = {}): TrackDocument {
  const fields: Record<string, ReturnType<typeof field>> = {};
  const put = (name: string, value: unknown): void => {
    fields[name] = field(value as never, "musicbrainz", AT);
  };
  put("title", "One More Time");
  put("artist", "Daft Punk");
  put("album", "Discovery");
  put("albumartist", "Daft Punk");
  put("tracknumber", 1);
  put("totaltracks", 14);
  put("discnumber", 1);
  put("totaldiscs", 1);
  put("date", "2001-02-26");
  put("genre", ["house"]);
  put("musicbrainz_recordingid", "60fa767a-d85d-4991-82bc-4294e0b11ae7");
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete fields[name];
    else put(name, value);
  }
  return {
    fields,
    na: { work: { source: "musicbrainz", reason: "the recording has no work relation", at: AT } },
    schemaVersion: 1,
  } as unknown as TrackDocument;
}

function album(overrides: Partial<LibraryAlbum> = {}): LibraryAlbum {
  return {
    id: "alb_1",
    releaseMbid: "d073287b-1e6f-4c7c-8e5f-1f9b6a6f6b8c",
    releaseGroupMbid: null,
    albumArtist: "Daft Punk",
    title: "Discovery",
    year: 2001,
    folder: "Daft Punk/Discovery (2001)",
    trackCount: 2,
    presentCount: 2,
    completeness: null,
    coverPath: "Daft Punk/Discovery (2001)/cover.jpg",
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    ...overrides,
  } as LibraryAlbum;
}

function track(overrides: Partial<LibraryTrack> = {}): LibraryTrack {
  return {
    id: "ltr_1",
    albumId: "alb_1",
    recordingMbid: null,
    trackMbid: null,
    title: "One More Time",
    artist: "Daft Punk",
    discNumber: 1,
    trackNumber: 1,
    path: "Daft Punk/Discovery (2001)/01 One More Time.opus",
    format: "opus",
    size: 1024,
    duration: 320,
    tagSchemaVersion: 1,
    projectionHash: null,
    importId: null,
    importTrackId: "itr_1",
    verifiedAt: null,
    verifyResult: null,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    ...overrides,
  } as LibraryTrack;
}

function loaded(overrides: Partial<LoadedTrack> = {}): LoadedTrack {
  const doc = overrides.document ?? document();
  return {
    track: overrides.track ?? track(),
    document: doc,
    storedHash:
      overrides.storedHash === undefined
        ? doc === null
          ? null
          : projectionHash(projectDocument(doc, "vorbis"))
        : overrides.storedHash,
  };
}

describe("scoreAlbum", () => {
  it("scores globally and per profile, and the two are different questions", () => {
    const quality = scoreAlbum(album(), [loaded()], 1);
    expect(quality.score).toBeGreaterThan(0);
    expect(quality.score).toBeLessThan(1);
    expect(quality.byProfile.navidrome).not.toBeNull();
    // Navidrome indexes a subset, so a document that has the common fields scores at least
    // as well through its eyes as against the whole superset.
    expect(quality.byProfile.navidrome ?? 0).toBeGreaterThanOrEqual(quality.score ?? 0);
  });

  it("aggregates a missing field over the tracks that lack it, worst level first", () => {
    const quality = scoreAlbum(album(), [loaded(), loaded()], 1);
    expect(quality.missing.length).toBeGreaterThan(0);
    const levels = quality.missing.map((entry) => entry.level);
    expect(levels.indexOf("required") <= levels.lastIndexOf("required")).toBe(true);
    for (const entry of quality.missing) expect(entry.tracks).toBe(2);
  });

  /* §6: a field the release says does not exist leaves the denominator. */
  it("counts an n/a field as n/a rather than as missing", () => {
    const quality = scoreAlbum(album(), [loaded()], 1);
    expect(quality.naCount).toBeGreaterThan(0);
    expect(quality.missing.some((entry) => entry.field === "work")).toBe(false);
  });

  it("separates 'behind the schema' from 'incomplete metadata'", () => {
    const behind = scoreAlbum(album(), [loaded({ track: track({ tagSchemaVersion: 1 }) })], 2);
    expect(behind.filesBehind).toBe(1);
    // The score is untouched: nothing is missing from the database, only from the file.
    expect(behind.score).toBe(scoreAlbum(album(), [loaded()], 1).score);
  });

  it("treats a file with no recorded version as behind", () => {
    const quality = scoreAlbum(album(), [loaded({ track: track({ tagSchemaVersion: null }) })], 1);
    expect(quality.filesBehind).toBe(1);
    expect(quality.schemaVersion).toBeNull();
  });

  it("reports drift when the stored hash no longer matches the projection", () => {
    const stale = loaded({ storedHash: "0000000000000000000000000000dead" });
    expect(scoreAlbum(album(), [stale], 1).driftCount).toBe(1);
    expect(scoreAlbum(album(), [loaded()], 1).driftCount).toBe(0);
  });

  it("says nothing about drift for a file that was never hashed", () => {
    expect(scoreAlbum(album(), [loaded({ storedHash: null })], 1).driftCount).toBe(0);
  });

  it("calls an album with no release untagged", () => {
    expect(scoreAlbum(album({ releaseMbid: null }), [loaded()], 1).untagged).toBe(true);
    expect(scoreAlbum(album(), [loaded()], 1).untagged).toBe(false);
  });

  it("survives a track with no document at all", () => {
    const quality = scoreAlbum(album(), [{ track: track(), document: null, storedHash: null }], 1);
    expect(quality.documentCount).toBe(0);
    expect(quality.score).toBeNull();
    expect(quality.tracks[0]?.hasDocument).toBe(false);
  });

  it("notices lyrics and ReplayGain, which are what the filters are about", () => {
    const rich = loaded({
      document: document({
        lyrics: { synced: "[00:12.40] One more time", plain: null },
        replaygain_track_gain: "-8.10 dB",
      }),
    });
    const quality = scoreAlbum(album(), [rich], 1);
    expect(quality.lyricsCount).toBe(1);
    expect(quality.replayGainCount).toBe(1);
  });

  it("marks a cover that came from YouTube rather than the archive", () => {
    const doc = document();
    const withCover: TrackDocument = {
      ...doc,
      fields: {
        ...doc.fields,
        front_cover: field(
          [{ kind: "front" as const, url: "https://i.ytimg.com/x.jpg", mimeType: "image/jpeg" }],
          "youtube",
          AT,
        ),
      },
    };
    expect(scoreAlbum(album(), [loaded({ document: withCover })], 1).youtubeCover).toBe(true);
  });
});

/*
 * The fourth MCP test report, §1: the album scored 0.04 below every one of its tracks and the
 * response said nothing about why. `divergentFields` was computed and dropped; these are the
 * two numbers that make the gap an answerable question, plus the values in presence.
 */
describe("scoreAlbum names the album-scope divergences, not only their count", () => {
  const withGenre = (genres: readonly string[], number_: number): LoadedTrack =>
    loaded({
      track: track({ id: `trk_${String(number_)}`, trackNumber: number_ }),
      document: document({ genre: genres }),
    });

  it("publishes score = meanTrackScore - penalty", () => {
    const quality = scoreAlbum(
      album(),
      [withGenre(["electropop"], 1), withGenre(["synth-pop"], 2)],
      1,
    );
    expect(quality.divergentFields).toEqual(["genre"]);
    expect(quality.penalty).toBeCloseTo(0.02, 10);
    expect(quality.score).toBeCloseTo((quality.meanTrackScore ?? 0) - 0.02, 10);
  });

  it("names the values in presence, the tracks holding them, and one action", () => {
    const quality = scoreAlbum(
      album(),
      [withGenre(["electropop"], 1), withGenre(["synth-pop"], 2), withGenre(["synth-pop"], 3)],
      1,
    );
    const genre = quality.divergences.find((entry) => entry.field === "genre");
    expect(genre?.vorbis).toBe("GENRE");
    expect(genre?.action).toBe(RETAG_ACTION);
    expect(genre?.medium).toBeNull();
    expect(genre?.rule.length).toBeGreaterThan(10);
    expect(genre?.values.map((value) => value.tracks)).toEqual([[1], [2, 3]]);
  });

  it("says nothing when the tracks agree", () => {
    const quality = scoreAlbum(album(), [withGenre(["house"], 1), withGenre(["house"], 2)], 1);
    expect(quality.divergences).toEqual([]);
    expect(quality.penalty).toBe(0);
    expect(quality.score).toBe(quality.meanTrackScore);
  });
});

describe("matchesFilter", () => {
  const row = (quality: ReturnType<typeof scoreAlbum>) => ({ album: album(), quality });

  it("selects albums below eighty percent through the chosen profile", () => {
    const poor = scoreAlbum(album(), [loaded({ document: document({ genre: undefined }) })], 1);
    expect(matchesFilter(row(poor), "below80", "global")).toBe(poor.score! < 0.8);
  });

  it("selects the albums a re-tag would touch", () => {
    const behind = scoreAlbum(album(), [loaded()], 2);
    expect(matchesFilter(row(behind), "schema", "global")).toBe(true);
    expect(matchesFilter(row(scoreAlbum(album(), [loaded()], 1)), "schema", "global")).toBe(false);
  });

  it("selects an untagged album", () => {
    const untagged = scoreAlbum(album({ releaseMbid: null }), [loaded()], 1);
    expect(matchesFilter(row(untagged), "untagged", "global")).toBe(true);
  });

  it("`all` really means all", () => {
    expect(matchesFilter(row(scoreAlbum(album(), [], 1)), "all", "global")).toBe(true);
  });
});

describe("summarise", () => {
  it("counts files, not albums, for the schema — that is what a re-tag processes", () => {
    const rows = [
      {
        album: album({ id: "alb_1" }),
        quality: scoreAlbum(album({ id: "alb_1" }), [loaded(), loaded()], 2),
      },
      { album: album({ id: "alb_2" }), quality: scoreAlbum(album({ id: "alb_2" }), [loaded()], 2) },
    ];
    const stats = summarise(rows, 2, false);
    expect(stats.filesBehind).toBe(3);
    expect(stats.albumsBehind).toBe(2);
    expect(stats.albums).toBe(2);
  });

  it("reports the override so the Console can say the number is not the compiled one", () => {
    expect(summarise([], 7, true).schemaOverridden).toBe(true);
    expect(summarise([], 7, true).currentSchema).toBe(7);
  });

  it("averages nothing to null rather than to zero", () => {
    expect(summarise([], 1, false).averageScore).toBeNull();
  });
});

describe("tagMapRows", () => {
  it("returns the whole map, with no album to colour it", () => {
    const rows = tagMapRows();
    expect(rows.length).toBeGreaterThan(90);
    expect(rows.every((row) => row.state === "unknown")).toBe(true);
  });

  it("colours a field present when any track of the album carries it", () => {
    const rows = tagMapRows([document()]);
    expect(rows.find((row) => row.field === "title")?.state).toBe("present");
    expect(rows.find((row) => row.field === "work")?.state).toBe("na");
    expect(rows.find((row) => row.field === "bpm")?.state).toBe("missing");
  });

  it("says which profiles read each field, from the domain and not from a second list", () => {
    const title = tagMapRows().find((row) => row.field === "title");
    expect(title?.readers).toContain("navidrome");
    const mbid = tagMapRows().find((row) => row.field === "musicbrainz_recordingid");
    // Plex runs its own matcher and ignores MusicBrainz identifiers entirely.
    expect(mbid?.readers).not.toContain("plex");
  });
});

/* ------------------------------------------------------------------ */
/* MCP test report §4 and §14                                          */
/* ------------------------------------------------------------------ */

describe("presentCount is a fact about the disk, when the caller has checked", () => {
  const two = [loaded(), loaded({ track: track({ id: "ltr_2", trackNumber: 2 }) })];

  it("counts rows when no set is supplied — the grid, which must not stat the library", () => {
    expect(scoreAlbum(album(), two, 1).presentCount).toBe(2);
  });

  it("counts only what is on disk when the set is supplied", () => {
    // `get_album` answered `13/13 present` over an empty directory while `retag` failed
    // thirteen times with NOT_FOUND. Half a set means half a count.
    expect(scoreAlbum(album(), two, 1, new Set(["ltr_1"])).presentCount).toBe(1);
    expect(scoreAlbum(album(), two, 1, new Set()).presentCount).toBe(0);
  });
});

describe("actionFor never promises MusicBrainz for a field MusicBrainz does not have", () => {
  it("sends `originalfilename` back to the source video, not to MusicBrainz", () => {
    // Its source is `` `<youtube id>.<ext>` ``; the old default said "Fetch from MusicBrainz".
    expect(actionFor("originalfilename")).not.toContain("MusicBrainz");
    expect(actionFor("originalfilename")).toContain("source video");
  });

  it("keeps the actions that were already right", () => {
    expect(actionFor("lyrics")).toBe("Retry LRCLIB");
    expect(actionFor("acoustid")).toBe("Fingerprint");
    expect(actionFor("replaygain_track_gain")).toBe("Run ReplayGain");
  });

  it("still says MusicBrainz for the fields that really come from it", () => {
    for (const field of ["title", "album", "musicbrainz_recordingid", "isrc"]) {
      expect(actionFor(field), field).toBe("Fetch from MusicBrainz");
    }
  });

  it("says so plainly for a field this app writes itself", () => {
    expect(actionFor("musicmanager_tagschema")).toContain("re-tag");
  });

  it("never invents an action for a field the tag map does not know", () => {
    expect(actionFor("not_a_field_at_all")).toBe("Edit by hand");
  });
});
