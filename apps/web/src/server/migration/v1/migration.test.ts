/**
 * The pure half of the migration, tested without a database, a filesystem or a toolbox.
 *
 * Everything here is a claim about v1 that the reader had to make by reading v1's C#. If one
 * of these assertions is wrong, the migration silently mangles somebody's library — so they
 * are written against the source they came from, with the file and method named.
 */
import { describe, expect, it } from "vitest";
import { TAG_SCHEMA_VERSION, merge } from "@mm/domain";
import { classify, importStatusFor, needsImport } from "./classify.ts";
import { libraryPrefixOf } from "./inventory.ts";
import { normalizeV1Path, padD2, pathKey, predictV1Path, sanitizeV1 } from "./paths.ts";
import { playlistFileName, renderPlaylist } from "./playlists.ts";
import { redactUrl } from "./reader.ts";
import { commentVideoId, reconcile, recordingMbidOf, type ScannedFile } from "./reconcile.ts";
import {
  identifiersOf,
  splitForcedList,
  splitList,
  sourceVideoId,
  videoIdFromUrl,
  type V1ForceMetadata,
  type V1Song,
} from "./schema.ts";
import { albumKeyOf, seedDocument } from "./seed.ts";

/* ------------------------------------------------------------------ */
/* a song                                                              */
/* ------------------------------------------------------------------ */

function song(overrides: Partial<V1Song> = {}): V1Song {
  return {
    id: 1,
    sourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    sourceUrlParent: null,
    platform: "YouTube",
    sourceId: "abcdefghijk",
    sourceIdParent: null,
    sourceTitle: "Daft Punk - One More Time",
    sourceDescription: null,
    title: "One More Time",
    subtitle: null,
    artist: "Daft Punk",
    performers: ["Daft Punk"],
    album: "Discovery",
    isrc: null,
    albumArtists: ["Daft Punk"],
    year: 2001,
    trackNumber: 1,
    trackCount: 14,
    discNumber: 1,
    discCount: 1,
    publisher: "Virgin",
    genres: ["Electronic"],
    duration: 320840,
    downloadStatus: "Present",
    finalFilePath: "Daft Punk/Discovery (2001)/01 - One More Time.opus",
    lastAttempt: null,
    errorMessage: null,
    musicBrainzRecordingId: "60fa767a-d85d-4991-82bc-4294e0b11ae7",
    musicBrainzReleaseId: "d073287b-d1bd-4f11-a933-a4386f8cf701",
    musicBrainzReleaseGroupId: null,
    musicBrainzArtistId: null,
    musicBrainzAlbumArtistId: null,
    musicBrainzReleaseStatus: "Official",
    musicBrainzReleaseCountry: "FR",
    musicBrainzForced: false,
    musicBrainzRecordingIdForce: null,
    musicBrainzReleaseIdForce: null,
    forceSongMetadata: false,
    forceSourceMetadata: false,
    createdAt: null,
    updatedAt: new Date("2025-04-18T09:32:00Z"),
    ...overrides,
  };
}

function file(path: string, tags: Record<string, string> = {}): ScannedFile {
  return { path, tags };
}

/* ------------------------------------------------------------------ */
/* `;`-joined lists                                                    */
/* ------------------------------------------------------------------ */

describe("v1 list columns", () => {
  it("splits on a bare semicolon and drops the empties, as the Songs converter does", () => {
    // ApplicationDbContext: `v.Split(';', StringSplitOptions.RemoveEmptyEntries).ToList()`
    expect(splitList("Electronic;House")).toEqual(["Electronic", "House"]);
    expect(splitList("a;;b")).toEqual(["a", "b"]);
    expect(splitList("")).toEqual([]);
    expect(splitList(null)).toEqual([]);
  });

  it("does not trim, because v1 does not either", () => {
    expect(splitList("Daft Punk; Justice")).toEqual(["Daft Punk", " Justice"]);
  });

  it("uses the other rule for a forced value: keep empties, trim each item", () => {
    // ProcessSongJob.ApplyForceMetadata: `force.Value.Split(';').Select(s => s.Trim())`
    expect(splitForcedList("Justice; Gaspard Augé")).toEqual(["Justice", "Gaspard Augé"]);
    expect(splitForcedList("a;;b")).toEqual(["a", "", "b"]);
    expect(splitForcedList("   ")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* the path v1 wrote                                                   */
/* ------------------------------------------------------------------ */

describe("v1 path generation", () => {
  it("pads the track number to two digits and no further", () => {
    expect(padD2(1)).toBe("01");
    expect(padD2(7)).toBe("07");
    expect(padD2(12)).toBe("12");
    expect(padD2(123)).toBe("123");
  });

  it("builds Artist/Album (Year)/[Disc N - ]NN - Title.opus", () => {
    // `DiscNumber >= 1` is the condition, so a single-disc row whose DiscNumber is 1 — which
    // is what a MusicBrainz medium gives it — really does get a `Disc 1 - ` prefix in v1.
    // The phase spec calls the prefix multi-disc-only; the code disagrees, and the code is
    // what wrote the paths we have to recognise.
    const parts = predictV1Path(song());
    expect(parts?.path).toBe("Daft Punk/Discovery (2001)/Disc 1 - 01 - One More Time.opus");
  });

  it("prefixes `Disc N - ` without padding, only when DiscNumber >= 1", () => {
    const two = predictV1Path(song({ discNumber: 2, trackNumber: 3, title: "Chorus" }));
    expect(two?.stem).toBe("Disc 2 - 03 - Chorus");

    const ten = predictV1Path(song({ discNumber: 10, trackNumber: 3, title: "Chorus" }));
    expect(ten?.stem).toBe("Disc 10 - 03 - Chorus");

    const zero = predictV1Path(song({ discNumber: 0, trackNumber: 3, title: "Chorus" }));
    expect(zero?.stem).toBe("03 - Chorus");

    const none = predictV1Path(song({ discNumber: null, trackNumber: 3, title: "Chorus" }));
    expect(none?.stem).toBe("03 - Chorus");
  });

  it("drops the parentheses entirely when there is no year", () => {
    const parts = predictV1Path(song({ year: null }));
    expect(parts?.directory).toBe("Daft Punk/Discovery");
  });

  it("falls back to AlbumArtists[0], then Artist, then Unknown Artist", () => {
    expect(predictV1Path(song({ albumArtists: ["Justice"] }))?.directory).toMatch(/^Justice\//);
    expect(predictV1Path(song({ albumArtists: [], artist: "Air" }))?.directory).toMatch(/^Air\//);
    expect(predictV1Path(song({ albumArtists: [], artist: null }))?.directory).toMatch(
      /^Unknown Artist\//,
    );
  });

  it("uses v1's deterministic Song_<id> fallback for a null title", () => {
    expect(predictV1Path(song({ id: 42, title: null, discNumber: null }))?.stem).toBe(
      "01 - Song_42",
    );
  });

  it("only replaces `/` and the control range on Linux, which is where v1 ran", () => {
    // .NET on Linux: Path.GetInvalidFileNameChars() is { '\\0', '/' }.
    expect(sanitizeV1("AC/DC", "linux")).toBe("AC_DC");
    expect(sanitizeV1("Sigur Rós: Takk...", "linux")).toBe("Sigur Rós: Takk");
    expect(sanitizeV1("Sigur Rós: Takk...", "windows")).toBe("Sigur Rós_ Takk");
  });

  it("collapses consecutive invalid characters into one underscore", () => {
    expect(sanitizeV1("a///b", "linux")).toBe("a_b");
  });

  it("trims underscores, dots and spaces from both ends", () => {
    expect(sanitizeV1("  ..Album.. ", "linux")).toBe("Album");
  });

  it("returns null where v1 would have used a random GUID name", () => {
    expect(sanitizeV1("   ", "linux")).toBeNull();
    expect(sanitizeV1("...", "linux")).toBeNull();
    expect(sanitizeV1(null, "linux")).toBeNull();
  });

  it("normalises a stored path for comparison without changing its meaning", () => {
    expect(normalizeV1Path("Artist\\Album (2001)\\01 - T.opus")).toBe(
      "Artist/Album (2001)/01 - T.opus",
    );
    expect(normalizeV1Path("./Artist//Album/01.opus")).toBe("Artist/Album/01.opus");
    expect(pathKey("Artist/Album/01.opus")).toBe("artist/album/01.opus");
  });
});

/* ------------------------------------------------------------------ */
/* classification                                                      */
/* ------------------------------------------------------------------ */

describe("classification", () => {
  it("is Present-with-file only when there really is a file", () => {
    expect(classify({ song: song(), hasFile: true })).toBe("present_with_file");
    expect(classify({ song: song(), hasFile: false })).toBe("present_missing_file");
  });

  it("maps NeedsManualReview and the three failures to their own classes", () => {
    expect(classify({ song: song({ downloadStatus: "NeedsManualReview" }), hasFile: false })).toBe(
      "needs_manual_review",
    );
    for (const status of ["DownloadFailed", "MetadataFailed", "ProcessingFailed"]) {
      expect(classify({ song: song({ downloadStatus: status }), hasFile: false })).toBe("failed");
    }
  });

  it("treats everything v1 left in flight as never-downloaded", () => {
    for (const status of ["Needed", "ReadyToDownload", "Downloading", "ProcessingMetadata"]) {
      expect(classify({ song: song({ downloadStatus: status }), hasFile: false })).toBe("needed");
    }
  });

  it("believes the file over the status when v1 crashed between the two", () => {
    expect(classify({ song: song({ downloadStatus: "Downloaded" }), hasFile: true })).toBe(
      "present_with_file",
    );
  });

  it("sends everything but a present file to an import, and never to `pending`", () => {
    expect(needsImport("present_with_file")).toBe(false);
    expect(needsImport("present_missing_file")).toBe(true);
    expect(importStatusFor("needed")).toBe("paused");
    expect(importStatusFor("needs_manual_review")).toBe("awaiting_review");
  });
});

/* ------------------------------------------------------------------ */
/* reconciliation                                                      */
/* ------------------------------------------------------------------ */

describe("reconciliation", () => {
  it("matches by FinalFilePath first", () => {
    const result = reconcile(
      [song()],
      [file("Daft Punk/Discovery (2001)/01 - One More Time.opus")],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.matchedBy).toBe("path");
    expect(result.orphans).toHaveLength(0);
  });

  it("matches case-insensitively and through backslashes", () => {
    const moved = song({ finalFilePath: "Daft Punk\\Discovery (2001)\\01 - One More Time.opus" });
    const result = reconcile([moved], [file("daft punk/discovery (2001)/01 - one more time.opus")]);
    expect(result.matches[0]?.matchedBy).toBe("path");
  });

  it("falls back to the recording MBID, which v1 wrote into MUSICBRAINZ_TRACKID", () => {
    const result = reconcile(
      [song()],
      [
        file("Daft Punk/Discovery (2001)/03 - Digital Love [edit].opus", {
          MUSICBRAINZ_TRACKID: "60FA767A-D85D-4991-82BC-4294E0B11AE7",
        }),
      ],
    );
    expect(result.matches[0]?.matchedBy).toBe("recording_mbid");
    expect(result.discrepancies.some((item) => item.kind === "path_moved")).toBe(true);
  });

  it("refuses to guess when two files claim the same recording", () => {
    const tags = { MUSICBRAINZ_TRACKID: "60fa767a-d85d-4991-82bc-4294e0b11ae7" };
    const result = reconcile([song()], [file("a/one.opus", tags), file("b/two.opus", tags)]);
    expect(result.matches).toHaveLength(0);
    expect(result.orphans).toHaveLength(2);
  });

  it("falls back to the YouTube id in v1's `Source: <url>` comment", () => {
    const bare = song({
      finalFilePath: "wrong/place.opus",
      musicBrainzRecordingId: null,
      musicBrainzReleaseId: null,
      title: null,
    });
    const result = reconcile(
      [bare],
      [
        file("Justice/Woman Worldwide (2018)/extras/renamed.opus", {
          DESCRIPTION: "Source: https://www.youtube.com/watch?v=abcdefghijk",
        }),
      ],
    );
    expect(result.matches[0]?.matchedBy).toBe("youtube_id");
  });

  it("reports a Present row whose file is nowhere as missing", () => {
    const result = reconcile([song()], []);
    expect(result.withoutFile).toEqual([1]);
    expect(result.discrepancies[0]?.kind).toBe("missing_file");
  });

  it("gives a file to the first claimant and reports the second", () => {
    const twin = song({ id: 2 });
    const result = reconcile(
      [song(), twin],
      [file("Daft Punk/Discovery (2001)/01 - One More Time.opus")],
    );
    expect(result.matches).toHaveLength(1);
    expect(result.withoutFile).toEqual([2]);
    expect(result.discrepancies.some((item) => item.kind === "duplicate_claim")).toBe(true);
  });

  it("reports every unclaimed file as an orphan", () => {
    const result = reconcile([], [file("Unsorted/x.opus")]);
    expect(result.orphans).toHaveLength(1);
    expect(result.discrepancies[0]?.kind).toBe("orphan_file");
  });

  it("prefers the v2 recording key over v1's misplaced one when both are present", () => {
    expect(recordingMbidOf({ MUSICBRAINZ_TRACKID: "aaa", MUSICBRAINZ_RECORDINGID: "bbb" })).toBe(
      "bbb",
    );
  });

  it("reads a video id out of every URL shape v1 could have stored", () => {
    expect(videoIdFromUrl("https://www.youtube.com/watch?v=abcdefghijk")).toBe("abcdefghijk");
    expect(videoIdFromUrl("https://youtu.be/abcdefghijk")).toBe("abcdefghijk");
    expect(videoIdFromUrl("https://www.youtube.com/embed/abcdefghijk")).toBe("abcdefghijk");
    expect(videoIdFromUrl("not a url")).toBeNull();
    expect(commentVideoId({ COMMENT: "Source: https://youtu.be/abcdefghijk" })).toBe("abcdefghijk");
    expect(sourceVideoId(song({ sourceId: "" }))).toBe("abcdefghijk");
  });
});

/* ------------------------------------------------------------------ */
/* the seed document                                                   */
/* ------------------------------------------------------------------ */

describe("the seed document", () => {
  const force = (overrides: Partial<V1ForceMetadata>): V1ForceMetadata => ({
    id: 1,
    songId: 1,
    field: "Title",
    value: "x",
    isArrayValue: false,
    ...overrides,
  });

  it("carries v1's fields at a low confidence and an unranked source", () => {
    const { patch } = seedDocument(song());
    expect(patch.fields?.["title"]?.value).toBe("One More Time");
    expect(patch.fields?.["title"]?.source).toBe("v1");
    expect(patch.fields?.["title"]?.confidence).toBeLessThan(0.5);
    expect(patch.fields?.["title"]?.locked).toBe(false);
    expect(patch.fields?.["date"]?.value).toBe("2001");
    expect(patch.fields?.["genre"]?.value).toEqual(["Electronic"]);
  });

  it("mirrors TRACKTOTAL into the TOTALTRACKS alias §2.1 asks for", () => {
    const { patch } = seedDocument(song());
    expect(patch.fields?.["totaltracks"]?.value).toBe(14);
    expect(patch.fields?.["totaltracks_alias"]?.value).toBe(14);
  });

  it("locks every field a SongForceMetadata row overrides", () => {
    const result = seedDocument(song(), [
      force({ field: "Title", value: "Genesis (Woman Worldwide edit)" }),
      force({ id: 2, field: "Genres", value: "French House;Electro", isArrayValue: true }),
    ]);
    expect(result.patch.fields?.["title"]?.value).toBe("Genesis (Woman Worldwide edit)");
    expect(result.patch.fields?.["title"]?.locked).toBe(true);
    expect(result.patch.fields?.["genre"]?.value).toEqual(["French House", "Electro"]);
    expect(result.locked).toEqual(expect.arrayContaining(["title", "genre"]));
  });

  it("locks a forced MBID, but only when MusicBrainzForced gates it", () => {
    const gated = seedDocument(
      song({
        musicBrainzForced: true,
        musicBrainzRecordingIdForce: "9d0dcd6b-e3b6-4d5a-9b21-4b6f10a7c3ee",
      }),
    );
    expect(gated.patch.fields?.["musicbrainz_recordingid"]?.value).toBe(
      "9d0dcd6b-e3b6-4d5a-9b21-4b6f10a7c3ee",
    );
    expect(gated.patch.fields?.["musicbrainz_recordingid"]?.locked).toBe(true);

    const ungated = seedDocument(
      song({
        musicBrainzForced: false,
        musicBrainzRecordingIdForce: "9d0dcd6b-e3b6-4d5a-9b21-4b6f10a7c3ee",
      }),
    );
    expect(ungated.patch.fields?.["musicbrainz_recordingid"]?.value).toBe(
      "60fa767a-d85d-4991-82bc-4294e0b11ae7",
    );
    expect(ungated.patch.fields?.["musicbrainz_recordingid"]?.locked).toBe(false);
  });

  it("reports a forced field v2 has no home for instead of dropping it silently", () => {
    const result = seedDocument(song(), [
      force({ field: "CoverArtMimeType", value: "image/jpeg" }),
    ]);
    expect(result.ignoredForces).toEqual(["CoverArtMimeType"]);
  });

  it("lets a real source overwrite a seeded value but never a locked one", () => {
    const seed = seedDocument(song(), [force({ field: "Title", value: "The forced title" })]);
    const fromMusicBrainz = {
      fields: {
        title: {
          value: "One More Time",
          source: "musicbrainz" as const,
          confidence: 1,
          fetchedAt: "2026-01-01T00:00:00.000Z",
          locked: false,
        },
        album: {
          value: "Discovery",
          source: "musicbrainz" as const,
          confidence: 1,
          fetchedAt: "2026-01-01T00:00:00.000Z",
          locked: false,
        },
      },
    };
    const document = merge([seed.patch, fromMusicBrainz], {
      schemaVersion: TAG_SCHEMA_VERSION,
    });
    expect(document.fields["title"]?.value).toBe("The forced title");
    expect(document.fields["album"]?.source).toBe("musicbrainz");
  });

  it("honours the gate when reading the identifiers back", () => {
    const ids = identifiersOf(
      song({
        musicBrainzForced: true,
        musicBrainzReleaseIdForce: "3ac2e0d3-2c0d-4e1a-9f4a-6b1c19a2f7bd",
      }),
    );
    expect(ids.releaseMbid).toBe("3ac2e0d3-2c0d-4e1a-9f4a-6b1c19a2f7bd");
    expect(ids.forced).toContain("MusicBrainzReleaseId");
  });

  it("groups rows into albums the way v1's own path generator did", () => {
    expect(albumKeyOf(song())).toBe(albumKeyOf(song({ id: 2, trackNumber: 5 })));
    expect(albumKeyOf(song())).not.toBe(albumKeyOf(song({ album: "Homework" })));
  });
});

/* ------------------------------------------------------------------ */
/* playlists, and the two small guards                                 */
/* ------------------------------------------------------------------ */

describe("playlist export", () => {
  it("writes EXTM3U with a relative path, and comments out what was never migrated", () => {
    const { body, missing } = renderPlaylist(
      { id: 1, name: "Road trip", description: "The one that always plays" },
      [
        { song: song(), path: "Daft Punk/Discovery (2001)/01 - One More Time.opus" },
        { song: song({ id: 2, title: "Missing", downloadStatus: "Needed" }), path: null },
      ],
      { pathPrefix: "../../library/" },
    );
    expect(body).toContain("#EXTM3U");
    expect(body).toContain("#PLAYLIST:Road trip");
    expect(body).toContain("#EXTINF:321,Daft Punk - One More Time");
    expect(body).toContain("../../library/Daft Punk/Discovery (2001)/01 - One More Time.opus");
    expect(body).toContain("# not migrated (Needed):");
    expect(missing).toBe(1);
  });

  it("makes a playlist name safe for a file name", () => {
    expect(playlistFileName("Focus / deep work", 1)).toBe("Focus - deep work.m3u8");
    expect(playlistFileName("   ", 3)).toBe("playlist-3.m3u8");
  });
});

describe("guards", () => {
  it("never prints a password back", () => {
    expect(redactUrl("postgres://mm:hunter2@db:5432/v1")).not.toContain("hunter2");
    expect(redactUrl("postgres://mm:hunter2@db:5432/v1")).toContain("***");
    expect(redactUrl("not a url")).toBe("(unparseable connection string)");
  });

  it("refuses a v1 library that the toolbox cannot see", () => {
    const paths = { host: "D:/lib", container: "/library", workDir: ".mm-work" };
    expect(libraryPrefixOf(paths, "D:/lib")).toBe("");
    expect(libraryPrefixOf(paths, "D:/lib/v1")).toBe("v1/");
    expect(() => libraryPrefixOf(paths, "D:/elsewhere")).toThrow(/must be the v2 library root/);
  });
});
