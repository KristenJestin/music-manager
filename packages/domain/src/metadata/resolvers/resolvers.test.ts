/**
 * The resolvers, against the recorded responses of `fixtures/`.
 *
 * Every assertion here is a fact about the real MusicBrainz / CAA / LRCLIB / Deezer data, so
 * a re-record that changes an answer fails loudly instead of quietly changing what we write.
 */

import { describe, expect, it } from "vitest";

import {
  acoustId,
  coverArt,
  deezer,
  FETCHED_AT,
  instrumentalLyrics,
  lrclibResults,
  recording,
  release,
  rsgainScan,
  video,
  work,
} from "../../testing/discovery.ts";
import { readFixture } from "../../testing/fixtures.ts";
import {
  acoustIdRecordingIds,
  chooseLrclibEntry,
  fromAcoustId,
  fromApp,
  fromCoverArtArchiveIndex,
  fromDeezerTrack,
  fromLrclib,
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
  fromRsgain,
  fromYouTubeEntry,
  type MbRecording,
} from "./index.ts";

const at = FETCHED_AT;

describe("fromMusicBrainzRelease", () => {
  const patch = fromMusicBrainzRelease(release, { trackPosition: 1, fetchedAt: at });
  const value = (name: string): unknown => patch.fields?.[name]?.value;

  it("reads the album-scope block", () => {
    expect(value("album")).toBe("Discovery");
    expect(value("albumartist")).toBe("Daft Punk");
    expect(value("date")).toBe("2001-02-26");
    expect(value("originaldate")).toBe("2001-02-26");
    expect(value("originalyear")).toBe(2001);
    expect(value("releasetype")).toEqual(["album"]);
    expect(value("releasestatus")).toBe("official");
    expect(value("releasecountry")).toBe("FR");
    expect(value("media")).toBe("CD");
    expect(value("label")).toEqual(["Virgin"]);
    expect(value("catalognumber")).toEqual(["8496062"]);
    expect(value("barcode")).toBe("724384960629");
    expect(value("script")).toBe("Latn");
  });

  it("reads the track's own position and credit", () => {
    expect(value("title")).toBe("One More Time");
    expect(value("tracknumber")).toBe(1);
    expect(value("totaltracks")).toBe(14);
    expect(value("totaltracks_alias")).toBe(14);
    expect(value("discnumber")).toBe(1);
    expect(value("totaldiscs")).toBe(1);
    expect(value("musicbrainz_releasetrackid")).toBe("25fbe7fe-655e-3624-9be1-0452364d0975");
  });

  it("extracts the ASIN from the Amazon url-rel", () => {
    expect(value("asin")).toBe("B000059MEK");
  });

  it("takes the mastering engineer from the release-level relations (§2.3)", () => {
    expect(value("engineer")).toEqual(["Nilesh Patel"]);
  });

  it("marks what the release genuinely does not have as n/a", () => {
    expect(patch.na?.["albumcomment"]?.reason).toContain("no disambiguation");
    expect(patch.na?.["discsubtitle"]?.reason).toContain("no title");
    expect(patch.na?.["compilation"]?.reason).toContain("not a Various Artists");
    expect(patch.na?.["license"]).toBeDefined();
  });

  it("returns nothing track-specific for a position that does not exist", () => {
    const missing = fromMusicBrainzRelease(release, { trackPosition: 99, fetchedAt: at });
    expect(missing.fields?.["title"]).toBeUndefined();
    expect(missing.fields?.["album"]?.value).toBe("Discovery");
  });

  it("survives a release group whose primary type is null", () => {
    // MusicBrainz sends `"primary-type": null` — not an absent key — for the release groups
    // of obscure artists, which used to throw `type.toLowerCase is not a function` and fail
    // the whole `tag` step of a single import.
    const untyped = {
      ...release,
      "release-group": { ...release["release-group"], "primary-type": null },
    };
    const patch = fromMusicBrainzRelease(untyped, { trackPosition: 1, fetchedAt: at });
    expect(patch.fields?.["releasetype"]).toBeUndefined();
    expect(patch.fields?.["album"]?.value).toBe("Discovery");
  });
});

describe("fromMusicBrainzRecording", () => {
  const patch = fromMusicBrainzRecording(recording, { fetchedAt: at });
  const value = (name: string): unknown => patch.fields?.[name]?.value;

  it("reads the identifiers and the ISRCs", () => {
    expect(value("musicbrainz_recordingid")).toBe("60fa767a-d85d-4991-82bc-4294e0b11ae7");
    expect(value("isrc")).toEqual(["GBAHT1305744", "GBDUW0000053"]);
  });

  it("ranks genres by vote count and keeps three (§2.4)", () => {
    expect(value("genre")).toEqual(["house", "electronic", "dance"]);
  });

  it("keeps only real moods out of the MusicBrainz tags", () => {
    expect(value("mood")).toEqual(["party"]);
  });

  it("reads the producers and the vocalist from the recording relations", () => {
    expect(value("producer")).toEqual(["Thomas Bangalter", "Guy‐Manuel de Homem‐Christo"]);
    expect(value("performer")).toEqual([
      { name: "Romanthony", role: "vocal", mbid: "c2be8eb6-c2e6-4051-898a-7d111e1e5784" },
    ]);
  });

  it("follows the performance relation into the work", () => {
    expect(value("work")).toBe("One More Time");
    expect(value("musicbrainz_workid")).toBe("4bb47ffc-9006-32cf-8aa9-e213334550dc");
    expect(value("language")).toBe("eng");
    expect(value("composer")).toContain("Thomas Bangalter");
  });

  it("marks work fields n/a when no work is linked", () => {
    const orphan: MbRecording = { id: "x", title: "Untitled", relations: [] };
    const result = fromMusicBrainzRecording(orphan, { fetchedAt: at });
    expect(result.na?.["work"]?.reason).toContain("no work is linked");
    expect(result.na?.["language"]).toBeDefined();
    expect(result.na?.["movement"]).toBeDefined();
  });
});

describe("fromMusicBrainzWork", () => {
  const patch = fromMusicBrainzWork(work, { fetchedAt: at });

  it("reads the writers and the lyrics language", () => {
    expect(patch.fields?.["work"]?.value).toBe("One More Time");
    expect(patch.fields?.["language"]?.value).toBe("eng");
    expect(patch.fields?.["writer"]?.value).toContain("Anthony Wayne Moore");
    expect(patch.fields?.["composersort"]?.value).toContain("Bangalter, Thomas");
  });

  it("marks the classical block n/a", () => {
    expect(patch.na?.["movementnumber"]?.reason).toContain("classical");
  });
});

describe("fromCoverArtArchiveIndex", () => {
  const patch = fromCoverArtArchiveIndex(coverArt, { fetchedAt: at });

  it("takes the 1200 px front and back covers (§3)", () => {
    expect(patch.fields?.["front_cover"]?.value).toEqual([
      {
        kind: "front",
        mimeType: "image/jpeg",
        url: "http://coverartarchive.org/release/d073287b-d1bd-4f11-a933-a4386f8cf701/13479423359-1200.jpg",
      },
    ]);
    expect(patch.fields?.["back_cover"]).toBeDefined();
  });

  it("marks the covers n/a when the archive has none", () => {
    const patch2 = fromCoverArtArchiveIndex({ images: [] }, { fetchedAt: at });
    expect(patch2.na?.["front_cover"]?.reason).toContain("no front cover");
    expect(patch2.na?.["back_cover"]).toBeDefined();
  });
});

describe("LRCLIB", () => {
  it("picks the result closest to the track's duration, preferring synced lyrics", () => {
    const chosen = chooseLrclibEntry(lrclibResults, { durationSeconds: 320 });
    expect(chosen?.duration).toBe(320);
    expect(chosen?.syncedLyrics).toBeTruthy();
  });

  it("returns nothing when no result is within the tolerance", () => {
    expect(chooseLrclibEntry(lrclibResults, { durationSeconds: 30 })).toBeNull();
  });

  it("writes the synchronised LRC to LYRICS", () => {
    const patch = fromLrclib(chooseLrclibEntry(lrclibResults, { durationSeconds: 320 }), {
      fetchedAt: at,
    });
    const lyrics = patch.fields?.["lyrics"]?.value as { synced: string | null };
    expect(lyrics.synced).toMatch(/^\[\d\d:\d\d\.\d\d\]/);
  });

  it("marks an instrumental track n/a rather than missing (§6)", () => {
    const patch = fromLrclib(instrumentalLyrics, { fetchedAt: at });
    expect(patch.fields?.["lyrics"]).toBeUndefined();
    expect(patch.na?.["lyrics"]?.reason).toBe("LRCLIB marks this track instrumental");
  });

  it("leaves LYRICS missing, not n/a, when LRCLIB simply has nothing yet", () => {
    const patch = fromLrclib(null, { fetchedAt: at });
    expect(patch.fields?.["lyrics"]).toBeUndefined();
    expect(patch.na?.["lyrics"]).toBeUndefined();
  });
});

describe("fromDeezerTrack", () => {
  const patch = fromDeezerTrack(deezer, { fetchedAt: at });

  it("rounds the BPM to the integer TBPM expects", () => {
    expect(deezer.bpm).toBe(122.7);
    expect(patch.fields?.["bpm"]?.value).toBe(123);
  });

  it("maps the explicit flag to 1 explicit / 2 clean (§2.6)", () => {
    expect(patch.fields?.["explicit"]?.value).toBe(2);
    expect(
      fromDeezerTrack({ explicit_content_lyrics: 1 }, { fetchedAt: at }).fields?.["explicit"]
        ?.value,
    ).toBe(1);
    expect(
      fromDeezerTrack({ explicit_lyrics: true }, { fetchedAt: at }).fields?.["explicit"]?.value,
    ).toBe(1);
  });

  it("produces nothing at all from an error response", () => {
    const empty = fromDeezerTrack({ error: { message: "no data" } }, { fetchedAt: at });
    expect(empty.fields).toEqual({});
  });
});

describe("fromAcoustId", () => {
  it("takes the highest-scoring result", () => {
    const patch = fromAcoustId(acoustId, { fetchedAt: at });
    expect(patch.fields?.["acoustid"]?.value).toBe("9ff43b6a-4f16-427c-93c2-92307ca505e0");
    expect(patch.fields?.["acoustid"]?.confidence).toBeCloseTo(0.981168);
  });

  it("lists the recordings it proposes, for the mismatch check", () => {
    expect(acoustIdRecordingIds(acoustId)).toContain("60fa767a-d85d-4991-82bc-4294e0b11ae7");
  });

  it("leaves the fingerprint n/a unless the option is on (§2.5)", () => {
    expect(fromAcoustId(acoustId, { fetchedAt: at }).na?.["acoustid_fingerprint"]).toBeDefined();
    const withPrint = fromAcoustId(acoustId, { fetchedAt: at, fingerprint: "AQADtE..." });
    expect(withPrint.fields?.["acoustid_fingerprint"]?.value).toBe("AQADtE...");
  });

  it("refuses a result below the threshold", () => {
    const weak = fromAcoustId({ results: [{ id: "x", score: 0.2 }] }, { fetchedAt: at });
    expect(weak.na?.["acoustid"]).toBeDefined();
  });
});

describe("fromRsgain", () => {
  const track = rsgainScan.tracks[0];

  it("passes rsgain's own formatting straight through", () => {
    const patch = fromRsgain(track ?? {}, { fetchedAt: at, opus: true });
    expect(patch.fields?.["replaygain_track_gain"]?.value).toBe("-8.47 dB");
    expect(patch.fields?.["replaygain_track_peak"]?.value).toBe("1.083092");
    expect(patch.fields?.["replaygain_reference_loudness"]?.value).toBe("-18.00 LUFS");
  });

  it("writes R128 for Opus and marks it n/a otherwise (§2.6)", () => {
    expect(
      fromRsgain(track ?? {}, { fetchedAt: at, opus: true }).fields?.["r128_track_gain"]?.value,
    ).toBe(-3448);
    const mp3 = fromRsgain(track ?? {}, { fetchedAt: at, opus: false });
    expect(mp3.fields?.["r128_track_gain"]).toBeUndefined();
    expect(mp3.na?.["r128_track_gain"]?.reason).toContain("only in Opus");
  });
});

describe("fromYouTubeEntry", () => {
  const patch = fromYouTubeEntry(video, {
    fetchedAt: at,
    appVersion: "2.0.0",
    importedOn: "2026-09-05",
    ytdlpVersion: "yt-dlp 2026.08.31",
  });
  const value = (name: string): unknown => patch.fields?.[name]?.value;

  it("stamps the provenance §2.6 asks for", () => {
    expect(value("comment")).toBe(
      "Source: youtu.be/FGBhQbmPwH8 · imported 2026-09-05 by Music Manager 2.0.0",
    );
    expect(value("musicmanager_sourceurl")).toBe("https://www.youtube.com/watch?v=FGBhQbmPwH8");
    expect(value("originalfilename")).toBe("FGBhQbmPwH8.webm");
    expect(value("encodedby")).toBe("yt-dlp 2026.08.31");
    expect(value("encodersettings")).toBe("yt-dlp format 251, opus, 141 kbps, 48000 Hz");
  });

  it("reads the description as a fallback source of musical metadata", () => {
    expect(value("copyright")).toContain("℗ 2001 Daft Life Ltd.");
    expect(value("label")).toEqual(["Daft Life Ltd./ADA France"]);
    expect(value("producer")).toEqual(["Thomas Bangalter", "Guy-Manuel de Homem-Christo"]);
  });

  it("gives those fallbacks a lower confidence than a MusicBrainz relation", () => {
    expect(patch.fields?.["producer"]?.confidence).toBeLessThan(1);
    expect(patch.fields?.["comment"]?.confidence).toBe(1);
  });

  it("still stamps provenance when the description is not auto-generated", () => {
    const plain = fromYouTubeEntry(
      { id: "abc", ext: "webm", description: "just a video" },
      { fetchedAt: at, appVersion: "2.0.0", importedOn: "2026-09-05" },
    );
    expect(plain.fields?.["comment"]).toBeDefined();
    expect(plain.fields?.["copyright"]).toBeUndefined();
  });
});

describe("fromApp", () => {
  const patch = fromApp({
    importId: "imp_1",
    sourceUrl: "https://youtu.be/x",
    tagSchemaVersion: 1,
    fetchedAt: at,
  });

  it("writes the traceability namespace (§2.6)", () => {
    expect(patch.fields?.["musicmanager_tagschema"]?.value).toBe(1);
    expect(patch.fields?.["musicmanager_importid"]?.value).toBe("imp_1");
    expect(patch.fields?.["musicmanager_sourceurl"]?.value).toBe("https://youtu.be/x");
  });

  it("marks the local analysis fields n/a", () => {
    expect(patch.na?.["key"]?.reason).toContain("off by default");
  });
});

describe("the Skinny Love fixtures", () => {
  it("resolves a recording that has no album of its own", () => {
    const skinny = readFixture<MbRecording>("musicbrainz/recording-skinny-love.json");
    const patch = fromMusicBrainzRecording(skinny, { fetchedAt: at });
    expect(patch.fields?.["title"]?.value).toBe("Skinny Love");
    expect(patch.fields?.["artist"]?.value).toBe("Birdy");
    expect(patch.fields?.["musicbrainz_recordingid"]?.value).toBe(
      "5463ed3a-5fc1-49b6-8260-3b5bb36ee047",
    );
    // A cover: the work's writer is Bon Iver's Justin Vernon, not the performer.
    expect(patch.fields?.["work"]?.value).toBe("Skinny Love");
  });

  it("offers the releases the recording could borrow one from", () => {
    const releases = readFixture<{ releases?: { title?: string }[] }>(
      "musicbrainz/releases-of-skinny-love.json",
    );
    expect((releases.releases ?? []).length).toBeGreaterThan(1);
  });
});
