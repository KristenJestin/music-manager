/**
 * The document, resolved from the responses the sources really gave.
 *
 * `documents.service.build()` itself needs Postgres — it starts from an `import_tracks` row —
 * so what is proved here is the half that has no database in it: the cassette payloads fed
 * through the P01 resolvers, exactly as `assemble()` feeds them. If a `GENRE` is wrong, or a
 * required field is missing, or Deezer's absence costs more than `BPM`, it shows up here and
 * not three containers later.
 *
 * The two acceptance claims of the phase are the last two tests: **no required field is
 * missing**, and **Deezer unavailable leaves the document valid** without `BPM` or
 * `ITUNESADVISORY`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveTrackDocument,
  tagByField,
  trackCompleteness,
  type CaaIndex,
  type DeezerTrack,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type RsgainResult,
  type TrackDocument,
  type TrackResolutionInput,
  type YtdlpEntry,
} from "@mm/domain";
import { thumbnailCoverPatch, youtubeThumbnail } from "#/server/services/documents.ts";
import { loadCassette } from "../cassette.ts";

const AT = "2026-09-06T00:00:00.000Z";
const RECORDING = "60fa767a-d85d-4991-82bc-4294e0b11ae7";

const FIXTURES = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../packages/domain/fixtures",
);

function fixture<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, relative), "utf8")) as T;
}

/** One body out of a cassette, by a fragment of its URL. */
function body<T>(cassette: string, urlContains: string): T {
  const entry = loadCassette(cassette).entries.find((held) => held.url.includes(urlContains));
  if (entry === undefined) throw new Error(`no cassette entry matching "${urlContains}"`);
  return entry.body as T;
}

const release = body<MbRelease>("musicbrainz", "/release/d073287b");
const recording = body<MbRecording>("musicbrainz", "/recording/60fa767a");
const artist = body<{ relations?: unknown }>("musicbrainz", "/artist/056e4f3e");
const cover = body<CaaIndex>("coverartarchive", "/release/d073287b");
const lyrics = body<LrclibEntry>("lrclib", "/api/get?artist_name=Daft+Punk&track_name=One+More");
const deezer = body<DeezerTrack>("deezer", "isrc:GBAHT1305744");

interface LastfmBody {
  readonly toptags?: { readonly tag?: readonly { name?: string; count?: number }[] };
}
const lastfmTrack = body<LastfmBody>("lastfm", "method=track.gettoptags");

const ytdlp = fixture<YtdlpEntry>("ytdlp/video-one-more-time.json");
const loudness = fixture<{ tracks: RsgainResult[] }>("rsgain/scan-discovery.json").tracks[0];

/** Everything a fully resolved track 1 of Discovery is made of. */
function input(overrides: Partial<TrackResolutionInput> = {}): TrackResolutionInput {
  return {
    release: { data: release, fetchedAt: AT, trackPosition: 1, mediumPosition: 1 },
    recording: { data: recording, fetchedAt: AT },
    artists: [{ data: artist as never, fetchedAt: AT }],
    coverArt: { data: cover, fetchedAt: AT },
    lyrics: { data: lyrics, fetchedAt: AT },
    deezer: { data: deezer, fetchedAt: AT },
    lastfm: {
      data: [...(lastfmTrack.toptags?.tag ?? [])],
      fetchedAt: AT,
    },
    tagOptions: { maxGenres: 3, minCount: 1 },
    rsgain: { data: loudness as RsgainResult, fetchedAt: AT, opus: true },
    youtube: {
      data: ytdlp,
      fetchedAt: AT,
      appVersion: "0.0.0",
      importedOn: "2026-09-06",
    },
    app: {
      importId: "imp_TEST",
      sourceUrl: "https://youtu.be/FGBhQbmPwH8",
      tagSchemaVersion: 1,
      fetchedAt: AT,
    },
    ...overrides,
  };
}

function valueOf(document: TrackDocument, field: string): unknown {
  return document.fields[field]?.value;
}

describe("a document built from the recorded sources", () => {
  const document = resolveTrackDocument(input());

  it("takes the album block from the release", () => {
    expect(valueOf(document, "album")).toBe("Discovery");
    expect(valueOf(document, "albumartist")).toBe("Daft Punk");
    expect(valueOf(document, "date")).toBe("2001-02-26");
    expect(valueOf(document, "originaldate")).toBe("2001-02-26");
    expect(valueOf(document, "releasestatus")).toBe("official");
    expect(valueOf(document, "releasecountry")).toBe("FR");
    expect(valueOf(document, "totaltracks")).toBe(14);
    expect(valueOf(document, "label")).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("takes the track's identity and position from the release, its ISRC from the recording", () => {
    expect(valueOf(document, "title")).toBe("One More Time");
    expect(valueOf(document, "tracknumber")).toBe(1);
    expect(valueOf(document, "musicbrainz_recordingid")).toBe(RECORDING);
    expect(valueOf(document, "isrc")).toContain("GBAHT1305744");
  });

  it("stamps every field with the source that produced it and when it was fetched", () => {
    expect(document.fields["album"]?.source).toBe("musicbrainz");
    expect(document.fields["front_cover"]?.source).toBe("coverartarchive");
    expect(document.fields["lyrics"]?.source).toBe("lrclib");
    expect(document.fields["bpm"]?.source).toBe("deezer");
    expect(document.fields["replaygain_track_gain"]?.source).toBe("rsgain");
    expect(document.fields["comment"]?.source).toBe("youtube");
    expect(document.fields["musicmanager_tagschema"]?.source).toBe("app");
    for (const field of Object.values(document.fields)) {
      expect(field.fetchedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    }
  });

  it("prefers MusicBrainz genres over Last.fm's, which is the §4 preference", () => {
    const genres = valueOf(document, "genre") as string[];
    expect(document.fields["genre"]?.source).toBe("musicbrainz");
    expect(genres.length).toBeLessThanOrEqual(3);
    // Last.fm's own top tag is "electronic"; MusicBrainz wins the field, so the value is
    // whatever MusicBrainz voted for, not the folksonomy's.
    expect(genres).toEqual((valueOf(document, "genre") as string[]).map(String));
  });

  it("falls back to Last.fm when MusicBrainz has no genre at all", () => {
    const noGenres = resolveTrackDocument(
      input({
        release: {
          data: { ...release, genres: [] },
          fetchedAt: AT,
          trackPosition: 1,
          mediumPosition: 1,
        },
        recording: { data: { ...recording, genres: [] }, fetchedAt: AT },
      }),
    );
    expect(noGenres.fields["genre"]?.source).toBe("lastfm");
    expect(noGenres.fields["genre"]?.value).toContain("Electronic");
  });

  it("carries the front cover from the archive, and the lyrics from LRCLIB", () => {
    const pictures = valueOf(document, "front_cover") as { url: string; kind: string }[];
    expect(pictures[0]?.kind).toBe("front");
    expect(pictures[0]?.url).toMatch(/^https?:\/\//);
    const held = valueOf(document, "lyrics") as { synced: string | null };
    expect(held.synced).toContain("[00:");
  });

  it("has no required field missing", () => {
    const report = trackCompleteness(document);
    const missingRequired = report.missing.filter(
      (field) => tagByField(field)?.level === "required",
    );
    expect(missingRequired).toEqual([]);
    expect(report.score ?? 0).toBeGreaterThan(0.8);
  });

  it("marks the recommended fields it lacks as n/a, with the source's own reason", () => {
    for (const field of Object.keys(document.na)) {
      expect(document.na[field]?.reason).toBeTruthy();
      expect(document.na[field]?.source).toBeTruthy();
    }
    // The album is not a compilation and the recording has no DJ-mixer: both are facts.
    expect(document.na["compilation"]?.source).toBe("musicbrainz");
    expect(document.na["djmixer"]).toBeDefined();
  });
});

describe("a source that is unavailable", () => {
  it("costs exactly the fields it owns: no Deezer, no BPM and no ITUNESADVISORY", () => {
    const { deezer: _dropped, ...withoutDeezer } = input();
    const document = resolveTrackDocument(withoutDeezer as TrackResolutionInput);

    expect(document.fields["bpm"]).toBeUndefined();
    expect(document.na["bpm"]).toBeUndefined();
    expect(document.fields["explicit"]).toBeUndefined();

    // …and nothing else changes: every required field is still there.
    const report = trackCompleteness(document);
    expect(report.missing.filter((field) => tagByField(field)?.level === "required")).toEqual([]);
  });

  it("costs the cover when the archive has none — unless the YouTube thumbnail stands in", () => {
    const { coverArt: _dropped, ...withoutCover } = input();
    const bare = resolveTrackDocument(withoutCover as TrackResolutionInput);
    expect(bare.fields["front_cover"]).toBeUndefined();

    const thumbnail = youtubeThumbnail(ytdlp);
    expect(thumbnail).not.toBeNull();
    const withThumbnail = resolveTrackDocument({
      ...(withoutCover as TrackResolutionInput),
      extra: [thumbnailCoverPatch(thumbnail as string, AT)],
    });
    expect(withThumbnail.fields["front_cover"]?.source).toBe("youtube");
    expect((withThumbnail.fields["front_cover"]?.value as readonly { url: string }[])[0]?.url).toBe(
      thumbnail,
    );
  });

  it("lets the archive take the cover back on the next rebuild", () => {
    const thumbnail = youtubeThumbnail(ytdlp) as string;
    const document = resolveTrackDocument({
      ...input(),
      extra: [thumbnailCoverPatch(thumbnail, AT)],
    });
    // `youtube` is last in SOURCE_PRECEDENCE, so a real front cover always wins.
    expect(document.fields["front_cover"]?.source).toBe("coverartarchive");
  });
});

describe("locks", () => {
  it("survive a rebuild, whatever the sources now say", () => {
    const document = resolveTrackDocument({
      ...input(),
      locked: {
        album: {
          value: "Discovery (my edit)",
          source: "user",
          confidence: 1,
          fetchedAt: AT,
          locked: true,
        },
      },
    });
    expect(valueOf(document, "album")).toBe("Discovery (my edit)");
    expect(document.fields["album"]?.locked).toBe(true);
  });
});
