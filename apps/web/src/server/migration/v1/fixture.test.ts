/**
 * The fixture, checked against the reader that will consume it.
 *
 * `fixtures/v1/dataset.ts` describes a v1 database *and* the files that database claims. The
 * two halves are generated separately — `dump.sql` and the tagged Opus files — so a mistake in
 * one is invisible until the integration run mysteriously reconciles nothing. These tests
 * close that gap in milliseconds instead: they run v1's own path algorithm over every fixture
 * row and assert it produces exactly the `FinalFilePath` the dump will carry.
 *
 * They are also, incidentally, the proof that the fixture covers what the phase asks for: the
 * counts below are the acceptance criteria, written as assertions.
 */
import { describe, expect, it } from "vitest";
import {
  CLEARED_RECORDING,
  FIXTURE_FORCES,
  FIXTURE_ORPHANS,
  FIXTURE_PLAYLISTS,
  FIXTURE_SONGS,
  LAST_OF_US,
  filesToBuild,
} from "../../../../../../fixtures/v1/dataset.ts";
import { v1Tags } from "../../../../../../fixtures/v1/build-library.ts";
import { predictV1Path } from "./paths.ts";
import { commentVideoId, recordingMbidOf } from "./reconcile.ts";
import { isV1ForceField, isV1SongStatus } from "./schema.ts";

describe("the v1 fixture", () => {
  it("has the thirty-six rows and four albums the phase asks for", () => {
    expect(FIXTURE_SONGS).toHaveLength(36);
    const albums = new Set(FIXTURE_SONGS.map((song) => song.album));
    expect([...albums].sort()).toEqual([
      "Birdy",
      "Discovery",
      "The Last of Us",
      "The Last of Us Part II",
      "Woman Worldwide",
    ]);
  });

  /**
   * Album D, and the reason it exists: the album is the v1 release MBID.
   *
   * Five rows name one release and disagree about the album artist and the year, so v1 filed
   * them in two folders; the sixth is on the same v1 playlist, carries that same release on its
   * row, and has a different one forced. A migration keyed on the tags makes three albums out
   * of that; a migration keyed on the release makes two, which is what v1 had decided.
   */
  it("has one release whose rows disagree about the album artist and the year", () => {
    const soundtrack = FIXTURE_SONGS.filter((song) => song.releaseMbid === LAST_OF_US.release);
    expect(soundtrack).toHaveLength(6);

    const agreeing = soundtrack.filter((song) => song.releaseMbidForce === null);
    expect(agreeing).toHaveLength(5);
    expect(new Set(agreeing.map((song) => song.albumArtists[0])).size).toBe(2);
    expect(new Set(agreeing.map((song) => song.year)).size).toBe(2);
    // Two v1 folders, three files against two: the majority is what the consolidation keeps.
    const folders = agreeing.map((song) => (song.realPath ?? "").split("/").slice(0, 2).join("/"));
    expect(new Set(folders).size).toBe(2);
    expect(
      folders.filter((folder) => folder === "Various Artists/The Last of Us (2013)"),
    ).toHaveLength(3);

    const forced = soundtrack.filter((song) => song.releaseMbidForce !== null);
    expect(forced).toHaveLength(1);
    expect(forced[0]?.musicBrainzForced).toBe(true);
    expect(forced[0]?.releaseMbidForce).toBe(LAST_OF_US.forcedRelease);
    // Same v1 playlist as the other five, which is exactly what makes it a test.
    expect(forced[0]?.sourceIdParent).toBe(agreeing[0]?.sourceIdParent);
  });

  it("covers every status the migration has to classify", () => {
    const statuses = FIXTURE_SONGS.map((song) => song.downloadStatus);
    expect(statuses.filter((status) => status === "Needed")).toHaveLength(2);
    expect(statuses.filter((status) => status === "NeedsManualReview")).toHaveLength(1);
    expect(statuses.filter((status) => status === "DownloadFailed")).toHaveLength(1);
    expect(statuses.filter((status) => status === "ProcessingFailed")).toHaveLength(1);
    // One `Present` row whose file is not there — the case § Étapes 4 turns into an import.
    const presentWithoutFile = FIXTURE_SONGS.filter(
      (song) => song.downloadStatus === "Present" && song.realPath == null,
    );
    expect(presentWithoutFile).toHaveLength(1);
    for (const status of statuses) expect(isV1SongStatus(status)).toBe(true);
  });

  it("only forces fields that v1's ForceMetadataType actually has", () => {
    expect(FIXTURE_FORCES.length).toBeGreaterThan(0);
    for (const force of FIXTURE_FORCES) expect(isV1ForceField(force.field)).toBe(true);
  });

  it("stores the path v1's own algorithm would have produced", () => {
    for (const song of FIXTURE_SONGS) {
      if (song.finalFilePath === null) continue;
      const predicted = predictV1Path({
        id: song.id,
        title: song.title,
        artist: song.artist,
        albumArtists: song.albumArtists,
        album: song.album,
        year: song.year,
        trackNumber: song.trackNumber,
        discNumber: song.discNumber,
      });
      expect(predicted?.path, `song ${String(song.id)}`).toBe(song.finalFilePath);
    }
  });

  it("covers all three path shapes v1 can produce", () => {
    const paths = FIXTURE_SONGS.map((song) => song.finalFilePath ?? "");
    // No disc prefix at all (DiscNumber null).
    expect(paths.some((path) => /\/\d\d - /.test(path))).toBe(true);
    // `Disc 1 - ` on a single-disc album, which is v1's `DiscNumber >= 1` condition.
    expect(paths.some((path) => path.includes("/Disc 1 - "))).toBe(true);
    // A genuinely multi-disc album.
    expect(paths.some((path) => path.includes("/Disc 2 - "))).toBe(true);
  });

  it("has exactly two files that only a non-path key can find", () => {
    const moved = FIXTURE_SONGS.filter(
      (song) => song.realPath != null && song.realPath !== song.finalFilePath,
    );
    expect(moved).toHaveLength(2);
    // One is findable by its recording MBID, the other only by its YouTube id.
    expect(moved.filter((song) => song.recordingMbid !== null)).toHaveLength(1);
    expect(moved.filter((song) => song.recordingMbid === null)).toHaveLength(1);
  });

  /*
   * The row the recording ladder's third rung exists for, checked on both halves of the
   * fixture at once: the `Songs` row that `dump.sql` will carry says nothing, and the tag set
   * `build-library.ts` will write says everything. Get one of the two wrong and the
   * integration run passes for the wrong reason.
   */
  it("has one row whose recording MBID is only in its file", () => {
    const cleared = FIXTURE_SONGS.filter((song) => song.recordingMbidInFile !== undefined);
    expect(cleared).toHaveLength(1);

    const song = cleared[0];
    expect(song?.id).toBe(CLEARED_RECORDING.songId);
    expect(song?.realPath).toBe(CLEARED_RECORDING.path);
    expect(song?.recordingMbidInFile).toBe(CLEARED_RECORDING.recording);
    // Nothing on the row: not the column, not the force, not the flag behind it.
    expect(song?.recordingMbid).toBeNull();
    expect(song?.recordingMbidForce).toBeNull();
    // …and the file really carries it, under Picard's name for the recording id.
    const tags = Object.fromEntries(v1Tags(song!).map((tag) => [tag.key, tag.value]));
    expect(tags["MUSICBRAINZ_TRACKID"]).toBe(CLEARED_RECORDING.recording);
    expect(recordingMbidOf(tags)).toBe(CLEARED_RECORDING.recording);
  });

  it("gives both Needed rows a forced MBID, so the import carries a preselection", () => {
    const needed = FIXTURE_SONGS.filter((song) => song.downloadStatus === "Needed");
    expect(needed).toHaveLength(2);
    for (const song of needed) {
      expect(song.musicBrainzForced).toBe(true);
      expect(song.recordingMbidForce).not.toBeNull();
      // No parent playlist, so each becomes its own v2 import.
      expect(song.sourceUrlParent).toBeNull();
    }
  });

  it("builds one file per Present row, plus an orphan nobody claims", () => {
    expect(filesToBuild()).toHaveLength(30);
    expect(FIXTURE_ORPHANS).toHaveLength(1);
  });

  it("has two playlists, one of which mixes migrated and never-downloaded songs", () => {
    expect(FIXTURE_PLAYLISTS).toHaveLength(2);
    const ids = new Set(FIXTURE_SONGS.map((song) => song.id));
    for (const playlist of FIXTURE_PLAYLISTS) {
      for (const songId of playlist.songIds) expect(ids.has(songId)).toBe(true);
    }
    const roadTrip = FIXTURE_PLAYLISTS[0];
    const withFile = (roadTrip?.songIds ?? []).filter(
      (id) => FIXTURE_SONGS.find((song) => song.id === id)?.realPath != null,
    );
    expect(withFile.length).toBeGreaterThan(0);
    expect(withFile.length).toBeLessThan(roadTrip?.songIds.length ?? 0);
  });
});

describe("the tags the fixture writes", () => {
  it("puts the recording id into MUSICBRAINZ_TRACKID, as v1 did", () => {
    const song = FIXTURE_SONGS.find((entry) => entry.recordingMbid !== null);
    expect(song).toBeDefined();
    const tags = Object.fromEntries(v1Tags(song!).map((tag) => [tag.key, tag.value]));
    expect(tags["MUSICBRAINZ_TRACKID"]).toBe(song?.recordingMbid);
    expect(tags["MUSICBRAINZ_RECORDINGID"]).toBeUndefined();
    expect(recordingMbidOf(tags)).toBe(song?.recordingMbid);
  });

  it("writes the source URL as v1's `Source: <url>` comment, and nothing else", () => {
    const song = FIXTURE_SONGS[0];
    expect(song).toBeDefined();
    const tags = Object.fromEntries(v1Tags(song!).map((tag) => [tag.key, tag.value]));
    expect(tags["DESCRIPTION"]).toBe(`Source: ${song?.sourceUrl}`);
    expect(commentVideoId(tags)).toBe(song?.sourceId);
  });

  it("writes no v2-only tag, or the migration would be reading its own output", () => {
    for (const song of FIXTURE_SONGS) {
      const keys = v1Tags(song).map((tag) => tag.key);
      for (const forbidden of [
        "MUSICMANAGER_TAGSCHEMA",
        "MUSICMANAGER_IMPORTID",
        "MUSICMANAGER_SOURCEURL",
        "ARTISTS",
        "ALBUMARTISTS",
        "MUSICBRAINZ_RECORDINGID",
        "MUSICBRAINZ_RELEASETRACKID",
        "REPLAYGAIN_TRACK_GAIN",
        "R128_TRACK_GAIN",
        "TOTALTRACKS",
        "TOTALDISCS",
      ]) {
        expect(keys, `${forbidden} on song ${String(song.id)}`).not.toContain(forbidden);
      }
    }
  });

  it("emits one tag per value for the `;`-joined columns", () => {
    const justice = FIXTURE_SONGS.find((song) => song.album === "Woman Worldwide");
    expect(justice).toBeDefined();
    const tags = v1Tags(justice!);
    expect(tags.filter((tag) => tag.key === "GENRE")).toHaveLength(3);
    expect(tags.filter((tag) => tag.key === "ARTIST")).toHaveLength(2);
  });
});
