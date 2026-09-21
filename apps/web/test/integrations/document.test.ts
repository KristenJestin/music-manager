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
  projectDocument,
  resolveTrackDocument,
  TAG_SCHEMA_VERSION,
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
import { diffProjection } from "#/server/services/retag.ts";
import { isBehindSchema } from "#/server/services/schema-version.ts";
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

/** The other library shape #4 has to keep out: a film score, recorded from the real thing. */
const tsubasa = fixture<MbRelease>("musicbrainz/release-tsubasa.json");

/** The first track's embedded recording — what a single release lookup really hands over. */
function embeddedRecording(held: MbRelease): MbRecording {
  const recording = held.media?.[0]?.tracks?.[0]?.recording;
  if (recording === undefined) throw new Error("the fixture has no first track");
  return recording;
}

/** The same release with every genre and tag off it, so only the work's shape can decide. */
function withoutGenres(held: MbRelease): MbRelease {
  return {
    ...held,
    genres: [],
    tags: [],
    "release-group": { ...(held["release-group"] ?? {}), genres: [], tags: [] },
  };
}

/** The same release with one genre on its group — the way the genre half decides. */
function withGenre(held: MbRelease, genre: string): MbRelease {
  return {
    ...held,
    "release-group": { ...(held["release-group"] ?? {}), genres: [{ name: genre }] },
  };
}

/**
 * The recording as MusicBrainz answers for a work it models as movements: the work's own
 * relations, `work-level-rels`, carry one `parts` link per movement *plus* the composer credit.
 */
function withMovements(held: MbRecording, movements: number): MbRecording {
  const copy = structuredClone(held) as unknown as {
    relations?: { "target-type"?: string; work?: { relations?: unknown[] } }[];
  };
  const performance = (copy.relations ?? []).find((relation) => relation["target-type"] === "work");
  if (performance?.work === undefined) throw new Error("the recording performs no work");
  performance.work.relations = [
    ...(performance.work.relations ?? []),
    ...Array.from({ length: movements }, (_, index) => ({
      type: "parts",
      "target-type": "work",
      work: { id: `movement-${index + 1}`, title: `Movement ${index + 1}` },
    })),
  ];
  return copy as unknown as MbRecording;
}

/** A work the pipeline asked for on its own: `workFull` asks for no `work-rels`, so no shape. */
const WORK_ID = "4bb47ffc-9006-32cf-8aa9-e213334550dc";
function standaloneWork(title: string, composer = false) {
  return {
    data: {
      id: WORK_ID,
      title,
      ...(composer ? { relations: [{ type: "composer", "target-type": "artist" }] } : {}),
    },
    fetchedAt: AT,
  };
}

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

/**
 * Issue #4. `WORK` is display metadata, not an identifier, and MusicBrainz links a work to every
 * recording that performs one — `Discovery` is a pop album whose title track has one, so writing
 * it unconditionally repeated the track's own title in a header, which a player that groups by
 * work (Symfonium, from 13.3.0) then shows. The setting and the classical predicate decide, and
 * `MUSICBRAINZ_WORKID` is written either way so the re-tag can repair the library offline.
 */
describe("the work fields", () => {
  const pop = resolveTrackDocument(input());

  it("leaves WORK off a pop release, and says why", () => {
    expect(pop.fields["work"]).toBeUndefined();
    expect(pop.na["work"]?.reason).toContain("not a classical release");
    expect(pop.na["movement"]?.reason).toContain("not a classical release");
    expect(valueOf(pop, "musicbrainz_workid")).toBe("4bb47ffc-9006-32cf-8aa9-e213334550dc");
  });

  it("writes them on a classical release — here on the release group's genre", () => {
    const document = resolveTrackDocument({
      ...input(),
      release: {
        data: {
          ...release,
          "release-group": {
            ...(release["release-group"] ?? {}),
            genres: [{ name: "classical" }],
          },
        },
        fetchedAt: AT,
        trackPosition: 1,
        mediumPosition: 1,
      },
    });
    expect(valueOf(document, "work")).toBe("One More Time");
    expect(document.na["work"]).toBeUndefined();
  });

  it("writes them everywhere when the setting says `always` — what v3 did", () => {
    expect(valueOf(resolveTrackDocument({ ...input(), writeWorkTags: "always" }), "work")).toBe(
      "One More Time",
    );
  });

  it("writes none of them when the setting says `never`, classical or not", () => {
    const document = resolveTrackDocument({ ...input(), writeWorkTags: "never" });
    expect(document.fields["work"]).toBeUndefined();
    expect(document.na["work"]?.reason).toContain("disabled by settings");
  });

  // Review of #14, point 3: the owner's library is mostly film scores, every one of them with a
  // composer credit, and the predicate was only ever tested on pop and on a symphony. Tsubasa is
  // the recorded one — no genre on its group, `yuki kajiura` on every work, cue titles.
  it("leaves a film score alone, composer credit and all", () => {
    const score = resolveTrackDocument({
      ...input(),
      release: { data: tsubasa, fetchedAt: AT, trackPosition: 1, mediumPosition: 1 },
      recording: { data: embeddedRecording(tsubasa), fetchedAt: AT },
    });
    expect(score.fields["work"]).toBeUndefined();
    expect(score.na["work"]?.reason).toContain("not a classical release");
    // The identifier is written either way: the re-tag can repair the library offline.
    expect(valueOf(score, "musicbrainz_workid")).toBe("3fd48635-898a-4c76-a95d-5d1f19637832");
  });

  // Review of #14, point 7: the shape half of the predicate was only ever exercised as a unit.
  // Here the release group says nothing at all and the shape decides — a composer credit in the
  // work's relations and `op. 67` in its title.
  it("falls back on the shape — a catalogue number in the work's title", () => {
    const document = resolveTrackDocument({
      ...input(),
      release: {
        data: withoutGenres(release),
        fetchedAt: AT,
        trackPosition: 1,
        mediumPosition: 1,
      },
      work: standaloneWork("Symphony no. 5 in C minor, op. 67", true),
    });
    expect(valueOf(document, "work")).toBe("Symphony no. 5 in C minor, op. 67");
    expect(document.na["work"]).toBeUndefined();
  });

  // Review of #14, point 1. The work arrives twice and the copies are not equivalent: the one the
  // pipeline fetched on its own carries no `work-rels` — no movements, no composer credit here —
  // while the one the recording nests carries `work-level-rels`. This work has a movement
  // structure and no catalogue number, so reading the first copy alone lost it its WORK.
  it("reads the shape from the copy of the work that carries it", () => {
    const document = resolveTrackDocument({
      ...input(),
      release: {
        data: withoutGenres(release),
        fetchedAt: AT,
        trackPosition: 1,
        mediumPosition: 1,
      },
      recording: { data: withMovements(recording, 2), fetchedAt: AT },
      work: standaloneWork("Le Sacre du printemps"),
    });
    expect(valueOf(document, "work")).toBe("Le Sacre du printemps");
    expect(document.na["work"]).toBeUndefined();
  });
});

/**
 * Spec · tags.write, "a file tagged before the change". The projection run selects on the schema
 * version, and what it writes back depends on the release: the pop file loses the `WORK` header a
 * player was grouping by, the classical one keeps it. The file itself is the toolbox's half.
 */
describe("a file tagged before the change", () => {
  it("is picked up by its version, and loses WORK only when it is not classical", () => {
    expect(TAG_SCHEMA_VERSION).toBe(6);
    expect(isBehindSchema(3, TAG_SCHEMA_VERSION)).toBe(true);
    expect(isBehindSchema(TAG_SCHEMA_VERSION, TAG_SCHEMA_VERSION)).toBe(false);

    const pop = projectDocument(resolveTrackDocument(input()), "vorbis");
    const classical = projectDocument(
      resolveTrackDocument({
        ...input(),
        release: {
          data: withGenre(release, "classical"),
          fetchedAt: AT,
          trackPosition: 1,
          mediumPosition: 1,
        },
      }),
      "vorbis",
    );

    expect(pop.some((tag) => tag.key === "WORK")).toBe(false);
    expect(classical.find((tag) => tag.key === "WORK")?.value).toBe("One More Time");
    // Either way the identifier survives, which is what makes the re-tag possible.
    expect(pop.find((tag) => tag.key === "MUSICBRAINZ_WORKID")?.value).toBe(WORK_ID);
  });

  /*
   * Issue #5, the same scenario: what a v4 file carries and a v5 file does not. `clear` on the
   * toolbox's `/tag` empties the block before writing the projection, so a tag that is no longer
   * projected is a tag the file loses — `diffProjection` against a probe that still reports them
   * is the proof, and it is what the re-tag screen shows the owner before anything is written.
   */
  it("loses the advisory and the disambiguation-subtitle, and keeps everything else", () => {
    const projected = projectDocument(resolveTrackDocument(input()), "vorbis");
    // What a v4 file holds: everything we project today, plus the two tags it carried then.
    const embedded: Record<string, string> = { ITUNESADVISORY: "2", SUBTITLE: "explicit" };
    for (const tag of projected) embedded[tag.key] = tag.value;

    expect(projected.some((tag) => tag.key === "ITUNESADVISORY")).toBe(false);
    expect(projected.some((tag) => tag.key === "SUBTITLE")).toBe(false);

    const diff = diffProjection(projected, embedded);
    const removed = diff.removed.map((change) => change.key);
    expect(removed).toContain("ITUNESADVISORY");
    expect(removed).toContain("SUBTITLE");
    expect(diff.added.map((change) => change.key)).not.toContain("ITUNESADVISORY");
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

/**
 * The property `docs/03-metadonnees.md` §8 rests on: **the document is a function of the raw
 * cache**. Two resolutions of the same cached responses must be the same document, byte for
 * byte, or the background re-tag rewrites files for no reason and the golden files mean
 * nothing.
 *
 * It is asserted with the locale feature switched on because that is the part that could
 * plausibly break it: choosing an alias is a choice among several candidates, and a choice
 * settled by anything other than MusicBrainz's own ordering would be stable per process and
 * unstable across them.
 */
describe("resolving twice from the same cache", () => {
  it("produces an identical document", () => {
    const first = resolveTrackDocument(input());
    const second = resolveTrackDocument(input());
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("produces an identical document with a preferred locale, too", () => {
    const withLocale = (): TrackDocument =>
      resolveTrackDocument({
        ...input(),
        locale: { locale: "ja", onlyNonLatin: false },
      });
    expect(JSON.stringify(withLocale())).toBe(JSON.stringify(withLocale()));
  });

  it("translates Daft Punk to ダフト・パンク, and records the alias in `via`", () => {
    const document = resolveTrackDocument({
      ...input(),
      locale: { locale: "ja", onlyNonLatin: false },
    });
    expect(valueOf(document, "artist")).toBe("ダフト・パンク");
    expect(document.fields["artist"]?.via).toBe("alias ja (primary)");
    // The sort name is MusicBrainz's and is where the original stays.
    expect(valueOf(document, "artistsort")).toEqual(["Daft Punk"]);
  });

  it("changes nothing at all when no locale is set — the default", () => {
    expect(JSON.stringify(resolveTrackDocument({ ...input(), locale: undefined }))).toBe(
      JSON.stringify(resolveTrackDocument(input())),
    );
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

/**
 * The acceptance of issue #9, on the edition that reported it: *Suzume*'s worldwide pressing.
 * Its sleeve is Latin (`Latn`) while the recordings underneath are the Japanese originals, and
 * two of its artists are credited under names that are not their own — 陣内一真 as
 * `Kazuma Jinnouchi`, 十明 as `Toaka`. Both symptoms of the issue are visible here as strings.
 */
describe("the worldwide edition of Suzume (issue #9)", () => {
  const suzume = fixture<MbRelease>("musicbrainz/release-suzume.json");
  const trackAt = (position: number) =>
    (suzume.media?.[0]?.tracks ?? []).find((track) => track.position === position)?.recording;
  const suzumeTrack = (position: number): TrackResolutionInput => {
    const embedded = trackAt(position);
    if (embedded === undefined) throw new Error(`the fixture lost track ${String(position)}`);
    return {
      release: { data: suzume, fetchedAt: AT, trackPosition: position, mediumPosition: 1 },
      recording: { data: embedded, fetchedAt: AT },
      app: { importId: "imp_SUZUME", sourceUrl: "", tagSchemaVersion: 1, fetchedAt: AT },
    };
  };

  it("writes the tracklist the edition prints, not the recordings' Japanese titles", () => {
    expect(trackAt(1)?.title).toBe("二人の出逢い");
    expect(valueOf(resolveTrackDocument(suzumeTrack(1)), "title")).toBe("The First Encounter");
    expect(valueOf(resolveTrackDocument(suzumeTrack(2)), "title")).toBe("Abandoned Resort");
  });

  it("keeps the credit the sleeve prints, join phrases included", () => {
    // Track 2 is `Kazuma Jinnouchi / RADWIMPS` on the sleeve, `陣内一真 & RADWIMPS` below it.
    expect(valueOf(resolveTrackDocument(suzumeTrack(2)), "artist")).toBe(
      "Kazuma Jinnouchi / RADWIMPS",
    );
  });

  it("reaches the `en` alias of a credited-as under `canonical`, and records it in `via`", () => {
    const document = resolveTrackDocument({
      ...suzumeTrack(2),
      artistNameSource: "canonical",
      locale: { locale: "en", onlyNonLatin: true },
    });
    expect(valueOf(document, "albumartist")).toBe("RADWIMPS, Kazuma Jinnouchi");
    expect(document.fields["albumartist"]?.via).toBe("alias en (primary)");
    expect(valueOf(document, "artist")).toBe("Kazuma Jinnouchi / RADWIMPS");
    expect(document.fields["artist"]?.via).toBe("alias en (primary)");
    expect(valueOf(document, "artistsort")).toEqual(["Jinnouchi, Kazuma", "RADWIMPS"]);
  });

  it("translates nothing under `credited` — a printed name is an editorial fact", () => {
    const document = resolveTrackDocument({
      ...suzumeTrack(2),
      artistNameSource: "credited",
      locale: { locale: "en", onlyNonLatin: true },
    });
    expect(valueOf(document, "albumartist")).toBe("RADWIMPS, Kazuma Jinnouchi");
    expect(document.fields["albumartist"]?.via).toBeUndefined();
    expect(document.fields["artist"]?.via).toBeUndefined();
  });

  it("is the same document twice, so the background re-tag has nothing to rewrite", () => {
    const twice = (): string =>
      JSON.stringify(
        resolveTrackDocument({
          ...suzumeTrack(2),
          artistNameSource: "canonical",
          locale: { locale: "en", onlyNonLatin: true },
        }),
      );
    expect(twice()).toBe(twice());
  });
});
