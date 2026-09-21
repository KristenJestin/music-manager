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
import { resolveTrackDocument } from "../resolve.ts";
import {
  acoustIdRecordingIds,
  chooseLrclibEntry,
  describeCoverArtOrigin,
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
  shortenSourceUrl,
  type MbRecording,
  type MbRelease,
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

  it("keeps the work id, and leaves WORK to the classical predicate (issue #4)", () => {
    // `Discovery` is a pop album MusicBrainz links a work to. The work's title is the track's
    // own, so writing it repeats every title in a player's header (D4-01, D4-02) — the work's
    // *identity* and its credits are still worth having.
    expect(value("work")).toBeUndefined();
    expect(patch.na?.["work"]?.reason).toContain("not a classical release");
    expect(value("musicbrainz_workid")).toBe("4bb47ffc-9006-32cf-8aa9-e213334550dc");
    expect(value("language")).toBe("eng");
    expect(value("composer")).toContain("Thomas Bangalter");
  });

  it("writes WORK when the release is classical, or when the setting says always", () => {
    const classical = fromMusicBrainzRecording(recording, { fetchedAt: at, classical: true });
    expect(classical.fields?.["work"]?.value).toBe("One More Time");
    const always = fromMusicBrainzRecording(recording, { fetchedAt: at, writeWorkTags: "always" });
    expect(always.fields?.["work"]?.value).toBe("One More Time");
    const never = fromMusicBrainzRecording(recording, {
      fetchedAt: at,
      classical: true,
      writeWorkTags: "never",
    });
    expect(never.na?.["work"]?.reason).toContain("disabled by settings");
  });

  it("treats the disambiguation as an editor note, not a subtitle (D5-02)", () => {
    // The recorded recording has `disambiguation: ""`, so the old code wrote `n/a` with “the
    // recording has no disambiguation” — an editorial decision reading as missing data. Both
    // recordings now answer the same sentence, and neither writes `SUBTITLE`.
    expect(recording.disambiguation).toBe("");
    expect(fromMusicBrainzRecording(recording, { fetchedAt: at }).na?.["subtitle"]?.reason).toBe(
      "MusicBrainz disambiguation is an editor note",
    );

    const commented = fromMusicBrainzRecording(
      { ...recording, disambiguation: "explicit" },
      { fetchedAt: at },
    );
    expect(commented.fields?.["subtitle"]).toBeUndefined();
    expect(commented.na?.["subtitle"]?.reason).toBe("MusicBrainz disambiguation is an editor note");
  });

  it("marks work fields n/a when no work is linked", () => {
    const orphan: MbRecording = { id: "x", title: "Untitled", relations: [] };
    const result = fromMusicBrainzRecording(orphan, { fetchedAt: at });
    expect(result.na?.["work"]?.reason).toContain("no work is linked");
    expect(result.na?.["language"]).toBeDefined();
    expect(result.na?.["movement"]).toBeDefined();
  });

  /**
   * D9-01, at the patch: the five fields a release also states for this very track are written
   * as a fallback, and nothing else is. The values are asserted through merges below; what is
   * asserted here is the one thing a merge cannot tell you afterwards — which side was lowered.
   */
  it("states the tracklist at less than full confidence, and its own facts at full", () => {
    for (const name of ["title", "artist", "artists", "artistsort", "musicbrainz_artistid"]) {
      expect(patch.fields?.[name]?.confidence).toBeLessThan(1);
    }
    // Nothing else can produce these, so nothing can outrank them.
    for (const name of ["musicbrainz_recordingid", "isrc", "genre", "mood"]) {
      expect(patch.fields?.[name]?.confidence).toBe(1);
    }
  });
});

describe("fromMusicBrainzWork", () => {
  const patch = fromMusicBrainzWork(work, { fetchedAt: at, classical: true });

  it("reads the writers and the lyrics language", () => {
    expect(patch.fields?.["work"]?.value).toBe("One More Time");
    expect(patch.fields?.["language"]?.value).toBe("eng");
    expect(patch.fields?.["writer"]?.value).toContain("Anthony Wayne Moore");
    expect(patch.fields?.["composersort"]?.value).toContain("Bangalter, Thomas");
  });

  it("marks the classical block n/a", () => {
    expect(patch.na?.["movementnumber"]?.reason).toContain("classical");
  });

  it("leaves WORK n/a when the release was not called classical", () => {
    const pop = fromMusicBrainzWork(work, { fetchedAt: at });
    expect(pop.fields?.["work"]).toBeUndefined();
    expect(pop.na?.["work"]?.reason).toContain("not a classical release");
    expect(pop.fields?.["musicbrainz_workid"]?.value).toBe("4bb47ffc-9006-32cf-8aa9-e213334550dc");
    // The credits stay: a pop songwriter is still the work's writer (§2.3).
    expect(pop.fields?.["writer"]?.value).toContain("Anthony Wayne Moore");
  });
});

describe("fromCoverArtArchiveIndex", () => {
  const patch = fromCoverArtArchiveIndex(coverArt, {
    fetchedAt: at,
    origin: { rung: "release", mbid: "d073287b-d1bd-4f11-a933-a4386f8cf701" },
  });

  it("takes the 1200 px front and back covers (§3)", () => {
    expect(patch.fields?.["front_cover"]?.value).toEqual([
      {
        kind: "front",
        mimeType: "image/jpeg",
        url: "http://coverartarchive.org/release/d073287b-d1bd-4f11-a933-a4386f8cf701/13479423359-1200.jpg",
        provenance: "Cover Art Archive · this release (d073287b-d1bd-4f11-a933-a4386f8cf701)",
      },
    ]);
    expect(patch.fields?.["back_cover"]).toBeDefined();
  });

  it("marks the covers n/a when the archive has none", () => {
    const patch2 = fromCoverArtArchiveIndex({ images: [] }, { fetchedAt: at });
    expect(patch2.na?.["front_cover"]?.reason).toContain("no front cover");
    expect(patch2.na?.["back_cover"]).toBeDefined();
  });

  it("names the rung of §4's ladder it came from (decision 168)", () => {
    /*
     * The archive answers the same shape for a release, its group and a sibling pressing, so
     * `source: coverartarchive` cannot tell you which question was asked. The picture says it
     * itself, and that is what the album page and `get_album` print.
     */
    expect(describeCoverArtOrigin({ rung: "release" })).toBe("Cover Art Archive · this release");
    expect(describeCoverArtOrigin({ rung: "release-group", mbid: "rg" })).toBe(
      "Cover Art Archive · release group (rg)",
    );
    expect(describeCoverArtOrigin({ rung: "sibling-release", mbid: "sib" })).toBe(
      "Cover Art Archive · another release of the group (sib)",
    );
    expect(describeCoverArtOrigin(undefined)).toBe("Cover Art Archive");
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
  const patch = fromDeezerTrack(deezer, { fetchedAt: at, writeExplicit: true });

  it("rounds the BPM to the integer TBPM expects", () => {
    expect(deezer.bpm).toBe(122.7);
    expect(patch.fields?.["bpm"]?.value).toBe(123);
  });

  it("maps the explicit flag to 1 explicit / 2 clean when the setting asks for it (§2.6)", () => {
    const on = { fetchedAt: at, writeExplicit: true } as const;
    expect(patch.fields?.["explicit"]?.value).toBe(2);
    expect(fromDeezerTrack({ explicit_content_lyrics: 1 }, on).fields?.["explicit"]?.value).toBe(1);
    expect(fromDeezerTrack({ explicit_lyrics: true }, on).fields?.["explicit"]?.value).toBe(1);
  });

  /*
   * Issue #5, `## Spec · metadata.resolve`, “the explicit tag is opt-in”: the two halves of it,
   * at the patch. Whether the *file* ends up without the tag is asserted through the projection
   * in `../explicit.test.ts`; what the resolver owns is the field the rest of the document reads.
   */
  it("default installation: `explicit` is n/a (“disabled by settings”), not missing", () => {
    const off = fromDeezerTrack({ explicit_lyrics: true }, { fetchedAt: at });
    expect(off.fields?.["explicit"]).toBeUndefined();
    expect(off.na?.["explicit"]?.reason).toBe("disabled by settings");
  });

  it("opted in: the recorded Deezer answer is written as it always was", () => {
    expect(patch.fields?.["explicit"]?.value).toBe(2);
    expect(patch.na?.["explicit"]).toBeUndefined();
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

  /*
   * Backlog 40. An import without MusicBrainz took YouTube's own `artist` tag — one string,
   * a credit line — and left `ARTISTS` and `ALBUMARTISTS` empty, although the tag map calls
   * both *required*. Every consumer that groups by artist read the list, and saw nobody.
   */
  it("writes the artist list behind the credit line, and keeps the credit line verbatim", () => {
    const patch = fromYouTubeEntry(
      { ...video, artist: "Abstract & Mltm" },
      { fetchedAt: at, appVersion: "2.0.0", importedOn: "2026-09-05", ytdlpVersion: "yt-dlp" },
    );
    const value = (name: string): unknown => patch.fields?.[name]?.value;
    expect(value("artist"), "the credit line as the source wrote it").toBe("Abstract & Mltm");
    expect(value("albumartist")).toBe("Abstract & Mltm");
    expect(value("artists"), "and the two names it credits").toEqual(["Abstract", "Mltm"]);
    expect(value("albumartists")).toEqual(["Abstract", "Mltm"]);
  });

  it("names one artist when the credit names one", () => {
    const patch = fromYouTubeEntry(
      { ...video, artist: "Maticulous feat. Jp" },
      { fetchedAt: at, appVersion: "2.0.0", importedOn: "2026-09-05", ytdlpVersion: "yt-dlp" },
    );
    expect(patch.fields?.["artists"]?.value).toEqual(["Maticulous", "Jp"]);
    const single = fromYouTubeEntry(
      { ...video, artist: "Max" },
      { fetchedAt: at, appVersion: "2.0.0", importedOn: "2026-09-05", ytdlpVersion: "yt-dlp" },
    );
    expect(single.fields?.["artists"]?.value, "a name is not a separator").toEqual(["Max"]);
  });

  it("invents no artist when the source names none", () => {
    const bare = fromYouTubeEntry(
      { id: "abc", title: "Untitled", ext: "webm" },
      { fetchedAt: at, appVersion: "2.0.0", importedOn: "2026-09-05", ytdlpVersion: "yt-dlp" },
    );
    expect(bare.fields?.["artists"]?.value ?? []).toEqual([]);
    expect(bare.fields?.["artist"]?.value ?? null).toBeNull();
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

  /**
   * An adopted file is a file that never came from YouTube, and §2.6's job is to say where
   * audio came from. `COMMENT` is the field a person reads, so `COMMENT` is what changes.
   */
  describe("when the file was adopted from disk", () => {
    const adoptedPatch = fromYouTubeEntry(video, {
      fetchedAt: at,
      appVersion: "2.0.0",
      importedOn: "2026-09-05",
      ytdlpVersion: "yt-dlp 2026.08.31",
      adopted: { originalName: "03 Digital Love.flac", adoptedOn: "2026-09-17" },
    });
    const adopted = (name: string): unknown => adoptedPatch.fields?.[name]?.value;

    it("says so, and names both the file and the video it is not from", () => {
      expect(adopted("comment")).toBe(
        'Adopted local file "03 Digital Love.flac" on 2026-09-17 · not downloaded from ' +
          "youtu.be/FGBhQbmPwH8 · imported 2026-09-05 by Music Manager 2.0.0",
      );
      // The prefix `Source:` is what `migration/v1/reconcile.ts` and `services/repair.ts`
      // read a video id out of, and an adopted file must not answer to it.
      expect(String(adopted("comment")).startsWith("Source:")).toBe(false);
    });

    it("keeps the source URL, which is the track's identity and not a claim about the bytes", () => {
      expect(adopted("musicmanager_sourceurl")).toBe("https://www.youtube.com/watch?v=FGBhQbmPwH8");
    });

    it("writes the file's own name, and refuses to invent an encoder", () => {
      expect(adopted("originalfilename")).toBe("03 Digital Love.flac");
      expect(adopted("encodedby")).toBeUndefined();
      expect(adoptedPatch.na?.["encodedby"]?.reason).toContain("adopted from disk");
      expect(adoptedPatch.na?.["encodersettings"]?.reason).toContain("adopted from disk");
    });

    it("still reads the description for the musical metadata", () => {
      expect(adopted("copyright")).toContain("℗ 2001 Daft Life Ltd.");
    });
  });

  /**
   * The audio was downloaded, just not from the video this track *is*.
   *
   * The distinction the sentence has to carry is the whole point: "adopted from disk" and
   * "fetched from another upload" are two different answers to "where did this file come
   * from", and the second one has an address a person can go and check. Saying *Adopted local
   * file* for it would be as false as saying *Source: youtu.be/…* was for the first.
   */
  describe("when the audio came from a replacement address", () => {
    const replacedPatch = fromYouTubeEntry(video, {
      fetchedAt: at,
      appVersion: "2.0.0",
      importedOn: "2026-09-05",
      ytdlpVersion: "yt-dlp 2026.08.31",
      adopted: {
        originalName: "kJQP7kiw5Fk.opus",
        adoptedOn: "2026-09-17",
        downloadedFrom: "https://www.youtube.com/watch?v=kJQP7kiw5Fk",
      },
    });
    const replaced = (name: string): unknown => replacedPatch.fields?.[name]?.value;

    it("names the address the bytes came from, then the one that would not give them up", () => {
      expect(replaced("comment")).toBe(
        "Downloaded from youtu.be/kJQP7kiw5Fk · original source youtu.be/FGBhQbmPwH8 " +
          "unavailable · imported 2026-09-05 by Music Manager 2.0.0",
      );
      // Same trap as the adopted case: `Source:` is the prefix the v1 reconciliation and
      // `services/repair.ts` read a video id out of, and this file's bytes are not from it.
      expect(String(replaced("comment")).startsWith("Source:")).toBe(false);
      // And it must not claim to be an adopted *file*, which is the other sentence entirely.
      expect(String(replaced("comment"))).not.toContain("Adopted local file");
    });

    it("keeps the original video as the track's identity, exactly as an adopted file does", () => {
      // This is the field the scan, the re-tag and the v1 reconciliation match on. A
      // replacement address is where the audio came from; it is never what the track is.
      expect(replaced("musicmanager_sourceurl")).toBe(
        "https://www.youtube.com/watch?v=FGBhQbmPwH8",
      );
    });

    it("credits yt-dlp, which really did encode this one, but invents no format", () => {
      // The contrast with the adopted-from-disk case above: there, nothing of ours encoded
      // the file and `encodedby` is n/a. Here yt-dlp fetched it, so its version is a fact.
      expect(replaced("encodedby")).toBe("yt-dlp 2026.08.31");
      // The *format* is not a fact: `entry` describes the video that could not be downloaded,
      // so its `acodec`/`abr` describe a file that was never produced.
      expect(replaced("encodersettings")).toBeUndefined();
      expect(replacedPatch.na?.["encodersettings"]?.reason).toContain("replacement address");
    });
  });
});

describe("shortenSourceUrl", () => {
  it("shortens every shape of YouTube address to the id a COMMENT can carry", () => {
    expect(shortenSourceUrl("https://www.youtube.com/watch?v=kJQP7kiw5Fk")).toBe(
      "youtu.be/kJQP7kiw5Fk",
    );
    expect(shortenSourceUrl("https://youtu.be/kJQP7kiw5Fk")).toBe("youtu.be/kJQP7kiw5Fk");
    expect(shortenSourceUrl("https://www.youtube.com/watch?list=OLAK5uy_&v=kJQP7kiw5Fk")).toBe(
      "youtu.be/kJQP7kiw5Fk",
    );
    expect(shortenSourceUrl("https://www.youtube.com/shorts/kJQP7kiw5Fk")).toBe(
      "youtu.be/kJQP7kiw5Fk",
    );
  });

  it("leaves anything that is not a YouTube address alone rather than inventing an id", () => {
    // A `fixture://` URL and a self-hosted mirror are both legitimate replacement addresses,
    // and printing `youtu.be/<something>` for either would name a video that does not exist —
    // the exact defect the `fromYouTube` guard above exists to prevent on the other side.
    expect(shortenSourceUrl("fixture://skinny-love")).toBe("fixture://skinny-love");
    expect(shortenSourceUrl("https://media.example.test/song.opus")).toBe(
      "https://media.example.test/song.opus",
    );
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
    // A cover: the work is Bon Iver's, whose writer the separate work lookup brings. The work
    // *title* stays out — this release was not called classical (issue #4).
    expect(patch.fields?.["work"]).toBeUndefined();
    expect(patch.na?.["work"]?.reason).toContain("not a classical release");
  });

  it("offers the releases the recording could borrow one from", () => {
    const releases = readFixture<{ releases?: { title?: string }[] }>(
      "musicbrainz/releases-of-skinny-love.json",
    );
    expect((releases.releases ?? []).length).toBeGreaterThan(1);
  });
});

/*
 * `credit.name` vs `credit.artist.name` — the two names MusicBrainz holds per credit.
 *
 * v1 wrote `credit.artist.name` and only that. v2 preferred the credited-as name, which is
 * why a v1 library re-tagged by v2 came out with different artist names on the handful of
 * tracks where the two differ — and why `artistNameSource` exists.
 *
 * Discovery is credited plainly, so the fixture is used twice: as it stands, to prove the two
 * modes agree when there is nothing to disagree about, and with one track's credit rewritten
 * the way MusicBrainz records a "credited as" — which is the case the setting is for.
 */
describe("artistNameSource", () => {
  const credited = { ...release, media: creditedAs(release) } as MbRelease;

  it("changes nothing when the credit is the artist's own name", () => {
    const asCredited = fromMusicBrainzRelease(release, {
      trackPosition: 1,
      fetchedAt: at,
      artistNameSource: "credited",
    });
    const canonical = fromMusicBrainzRelease(release, {
      trackPosition: 1,
      fetchedAt: at,
      artistNameSource: "canonical",
    });
    expect(asCredited.fields?.["artist"]?.value).toBe("Daft Punk");
    expect(canonical.fields?.["artist"]?.value).toBe("Daft Punk");
    expect(canonical.fields?.["artists"]?.value).toEqual(["Daft Punk"]);
  });

  it("writes the credited-as name by default", () => {
    const patch = fromMusicBrainzRelease(credited, { trackPosition: 1, fetchedAt: at });
    expect(patch.fields?.["artist"]?.value).toBe("Thomas Bangalter & Romanthony");
    expect(patch.fields?.["artists"]?.value).toEqual(["Thomas Bangalter", "Romanthony"]);
  });

  it("writes the artist's canonical name in `canonical` mode, join phrases intact", () => {
    const patch = fromMusicBrainzRelease(credited, {
      trackPosition: 1,
      fetchedAt: at,
      artistNameSource: "canonical",
    });
    expect(patch.fields?.["artist"]?.value).toBe("Daft Punk & Anthony Moore");
    expect(patch.fields?.["artists"]?.value).toEqual(["Daft Punk", "Anthony Moore"]);
    // Sort names and MBIDs are artist-level facts: the setting does not touch them.
    expect(patch.fields?.["artistsort"]?.value).toEqual(["Daft Punk", "Moore, Anthony"]);
  });

  it("applies to the recording resolver too", () => {
    const withCredit = {
      ...recording,
      "artist-credit": creditPair(),
    } as unknown as MbRecording;
    expect(fromMusicBrainzRecording(withCredit, { fetchedAt: at }).fields?.["artist"]?.value).toBe(
      "Thomas Bangalter & Romanthony",
    );
    expect(
      fromMusicBrainzRecording(withCredit, { fetchedAt: at, artistNameSource: "canonical" })
        .fields?.["artist"]?.value,
    ).toBe("Daft Punk & Anthony Moore");
  });
});

/**
 * D9-01 — *Suzume*'s worldwide edition prints a Latin tracklist over Japanese recordings, and
 * re-credits two of its artists on the sleeve: `Kazuma Jinnouchi` for 陣内一真, `Toaka` for 十明.
 * Both disagreements are visible as strings, so which patch won is asserted rather than argued.
 *
 * Resolved through `resolveTrackDocument`, not by hand-merging two patches: a fixture proves
 * nothing about the fix if the fix lives somewhere the pipeline does not go.
 */
describe("the release's tracklist over the recording's (D9-01)", () => {
  /** Worldwide edition, `Official`, `Latn`, 29 tracks. */
  const suzume = readFixture<MbRelease>("musicbrainz/release-suzume.json");
  const trackAt = (position: number) =>
    (suzume.media?.[0]?.tracks ?? []).find((track) => track.position === position);
  const recordingAt = (position: number): MbRecording => {
    const embedded = trackAt(position)?.recording;
    if (embedded === undefined) {
      throw new Error(`the Suzume fixture lost the recording of track ${String(position)}`);
    }
    return embedded;
  };
  const resolve = (position: number, withRelease = true) =>
    resolveTrackDocument({
      ...(withRelease ? { release: { data: suzume, fetchedAt: at, trackPosition: position } } : {}),
      recording: { data: recordingAt(position), fetchedAt: at },
      app: { importId: "imp_D9", sourceUrl: "", tagSchemaVersion: 1, fetchedAt: at },
    });
  const field = (document: ReturnType<typeof resolve>, name: string) =>
    document.fields[name]?.value;

  it("is the fixture's whole point: the two sources disagree, track by track", () => {
    expect(trackAt(1)?.title).toBe("The First Encounter");
    expect(recordingAt(1).title).toBe("二人の出逢い");
    // Track 2 is credited to 陣内一真 and RADWIMPS on the sleeve, and to the same two artists
    // under other names on the recording — a real “credited as”, not a transcription.
    expect(trackAt(2)?.["artist-credit"]?.[0]?.name).toBe("Kazuma Jinnouchi");
    expect(recordingAt(2)["artist-credit"]?.[0]?.name).toBe("陣内一真");
  });

  it("writes the title the edition prints, not the recording's", () => {
    expect(field(resolve(1), "title")).toBe("The First Encounter");
    // Track 2 as well: the two titles share no word, so this cannot pass by accident.
    expect(field(resolve(2), "title")).toBe("Abandoned Resort");
  });

  it("writes the credit printed on the sleeve, join phrases and all", () => {
    expect(field(resolve(2), "artist")).toBe("Kazuma Jinnouchi / RADWIMPS");
    expect(field(resolve(2), "artists")).toEqual(["Kazuma Jinnouchi", "RADWIMPS"]);
    // Track 25 is the same two artists the other way round, with the other join phrase.
    expect(field(resolve(25), "artist")).toBe("RADWIMPS / Kazuma Jinnouchi");
  });

  it("still keeps what only the recording knows", () => {
    const document = resolve(1);
    expect(field(document, "musicbrainz_recordingid")).toBe(recordingAt(1).id);
    expect(document.fields["musicbrainz_recordingid"]?.confidence).toBe(1);
  });

  it("leaves a standalone recording its own title and credit", () => {
    // No release: nothing holds the tracklist against it, so the fallback is all there is.
    const alone = resolve(2, false);
    expect(field(alone, "title")).toBe("廃墟の温泉街");
    expect(field(alone, "artist")).toBe("陣内一真 & RADWIMPS");
  });
});

/** A two-artist credit where both entries are credited under a different name. */
function creditPair() {
  return [
    {
      name: "Thomas Bangalter",
      joinphrase: " & ",
      artist: {
        id: "056e4f3e-d505-4dad-8ec1-d04f521cbb56",
        name: "Daft Punk",
        "sort-name": "Daft Punk",
      },
    },
    {
      name: "Romanthony",
      joinphrase: "",
      artist: {
        id: "0f0b9a0b-1f2d-4a5e-8f1b-9a1b2c3d4e5f",
        name: "Anthony Moore",
        "sort-name": "Moore, Anthony",
      },
    },
  ];
}

/** Discovery's first medium, with track 1 re-credited the way a "credited as" looks. */
function creditedAs(source: MbRelease) {
  const media = source.media ?? [];
  const first = media[0];
  if (first === undefined) throw new Error("the Discovery fixture lost its medium");
  return [
    {
      ...first,
      tracks: (first.tracks ?? []).map((track) =>
        track.position === 1 ? { ...track, "artist-credit": creditPair() } : track,
      ),
    },
    ...media.slice(1),
  ];
}
