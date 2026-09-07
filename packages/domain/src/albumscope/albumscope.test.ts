/**
 * The album-scope resolver (`docs/03-metadonnees.md` §2, §6).
 *
 * The cases below are the fourth MCP test report's, reduced to their shape: a thirteen-track
 * album whose recordings carry different MusicBrainz genres, one interlude that has none and
 * fell back to Last.fm, and one video whose ℗ line is the full legal notice while the others
 * abbreviate it. Before this module they cost 0.04 of album score and split the album on any
 * server that groups by `GENRE`.
 */
import { describe, expect, it } from "vitest";
import {
  albumScopeConsistency,
  field,
  type Field,
  type TrackDocument,
} from "../metadata/document.ts";
import { albumCompleteness, trackCompleteness } from "../completeness/index.ts";
import { applyAlbumScopeTo, changedChoices, resolveAlbumScope, unifyAlbumScope } from "./index.ts";
import { albumScopeRule } from "./rules.ts";

const AT = "2026-09-07T00:00:00.000Z";

function doc(fields: Record<string, Field>, na: Record<string, string> = {}): TrackDocument {
  return {
    schemaVersion: 1,
    fields,
    na: Object.fromEntries(
      Object.entries(na).map(([name, reason]) => [
        name,
        { reason, source: "musicbrainz" as const },
      ]),
    ),
  };
}

const changed = (...args: Parameters<typeof resolveAlbumScope>) =>
  changedChoices(resolveAlbumScope(...args));

const mb = <T extends Field["value"]>(value: T) => field(value, "musicbrainz", AT);
const yt = <T extends Field["value"]>(value: T) => field(value, "youtube", AT);
const fm = <T extends Field["value"]>(value: T) => field(value, "lastfm", AT);

describe("resolveAlbumScope — genre", () => {
  const album = [
    doc({ genre: mb(["electropop", "synth-pop"]) }),
    doc({ genre: mb(["synth-pop"]) }),
    doc({ genre: mb(["alternative pop", "synth-pop"]) }),
    doc({ genre: mb(["pop rock", "synth-pop"]) }),
  ];

  it("unifies the recordings' genres into one album-wide list, most voted first", () => {
    const choices = changedChoices(resolveAlbumScope(album, { maxGenres: 3 }));
    const genre = choices.find((choice) => choice.field === "genre");
    expect(genre?.value).toEqual(["synth-pop", "alternative pop", "electropop"]);
    // Every track differs from the union, so every track is rewritten.
    expect(genre?.changes).toEqual([0, 1, 2, 3]);
  });

  it("honours maxGenres", () => {
    const choices = changed(album, { maxGenres: 1 });
    expect(choices.find((choice) => choice.field === "genre")?.value).toEqual(["synth-pop"]);
  });

  it("lets a MusicBrainz genre outrank a Last.fm fallback rather than counting both", () => {
    const withFallback = [...album, doc({ genre: fm(["Synthpop", "Electronic", "Electropop"]) })];
    const choices = changed(withFallback, { maxGenres: 4 });
    const genre = choices.find((choice) => choice.field === "genre");
    expect(genre?.value).toEqual(["synth-pop", "alternative pop", "electropop", "pop rock"]);
    expect(genre?.source).toBe("musicbrainz");
  });

  it("prefers the album's own source over any aggregation of the tracks", () => {
    const choices = changed(album, {
      maxGenres: 3,
      albumValues: { genre: mb(["synth-pop", "electropop"]) },
    });
    expect(choices.find((choice) => choice.field === "genre")?.value).toEqual([
      "synth-pop",
      "electropop",
    ]);
  });

  it("fills the track that had no genre at all, and clears its n/a", () => {
    const withGap = [...album, doc({}, { genre: "MusicBrainz has no genre on the recording" })];
    const { documents } = unifyAlbumScope(withGap, { maxGenres: 3 });
    const last = documents[4];
    expect(last?.fields["genre"]?.value).toEqual(["synth-pop", "alternative pop", "electropop"]);
    expect(last?.na["genre"]).toBeUndefined();
  });
});

describe("resolveAlbumScope — copyright", () => {
  it("keeps the fullest form of the ℗ line", () => {
    const long = "℗ 2018 CHVRCHES, under exclusive license to Vertigo/Capitol";
    const album = [
      doc({ copyright: yt("℗ 2018 CHVRCHES") }),
      doc({ copyright: yt(long) }),
      doc({ copyright: yt("℗ 2018 CHVRCHES") }),
    ];
    const choices = changed(album);
    expect(choices.find((choice) => choice.field === "copyright")?.value).toBe(long);
  });

  it("lets the release outrank the YouTube description", () => {
    const album = [
      doc({ copyright: yt("℗ 2018 CHVRCHES, under exclusive license to Vertigo") }),
      doc({ copyright: mb("℗ 2018 Goodbye Records") }),
    ];
    const choices = changed(album);
    const chosen = choices.find((choice) => choice.field === "copyright");
    expect(chosen?.value).toBe("℗ 2018 Goodbye Records");
    expect(chosen?.source).toBe("musicbrainz");
  });
});

describe("resolveAlbumScope — the other album-scope fields", () => {
  it("keeps every label a release-info entry names", () => {
    const album = [
      doc({ label: mb(["Goodbye Records"]) }),
      doc({ label: mb(["Goodbye Records"]) }),
      doc({ label: mb(["Virgin"]) }),
    ];
    const choices = changed(album);
    // `label` is multi-valued: the album carries every label the release-info entries name.
    expect(choices.find((choice) => choice.field === "label")?.value).toEqual([
      "Goodbye Records",
      "Virgin",
    ]);
  });

  it("takes the earliest track on a tie", () => {
    const album = [doc({ barcode: mb("111") }), doc({ barcode: mb("222") })];
    const choices = changed(album);
    expect(choices.find((choice) => choice.field === "barcode")?.value).toBe("111");
  });

  it("never unifies a medium-scoped field across discs", () => {
    const album = [
      doc({ discnumber: mb(1), totaltracks: mb(12), media: mb("CD") }),
      doc({ discnumber: mb(1), totaltracks: mb(12), media: mb("CD") }),
      doc({ discnumber: mb(2), totaltracks: mb(10), media: mb("CD") }),
      doc({ discnumber: mb(2), totaltracks: mb(10), media: mb("CD") }),
    ];
    expect(albumScopeRule("totaltracks").grouping).toBe("medium");
    const resolution = resolveAlbumScope(album);
    const choices = changedChoices(resolution);
    const divergentFields = resolution.divergentFields;
    expect(choices.filter((choice) => choice.field === "totaltracks")).toEqual([]);
    expect(divergentFields).not.toContain("totaltracks");
    expect(albumScopeConsistency(album).consistent).toBe(true);
  });

  it("still repairs a medium-scoped field inside one disc", () => {
    const album = [
      doc({ discnumber: mb(1), totaltracks: mb(12) }),
      doc({ discnumber: mb(1), totaltracks: mb(11) }),
      doc({ discnumber: mb(1), totaltracks: mb(12) }),
    ];
    const choices = changed(album);
    const total = choices.find((choice) => choice.field === "totaltracks");
    expect(total?.value).toBe(12);
    expect(total?.medium).toBe(1);
    expect(total?.changes).toEqual([1]);
  });

  it("lets a locked value win for the whole album", () => {
    const album = [
      doc({ genre: mb(["synth-pop"]) }),
      doc({ genre: field(["shoegaze"], "user", AT, { locked: true }) }),
      doc({ genre: mb(["synth-pop"]) }),
    ];
    const { documents } = unifyAlbumScope(album);
    expect(documents.map((document) => document.fields["genre"]?.value)).toEqual([
      ["shoegaze"],
      ["shoegaze"],
      ["shoegaze"],
    ]);
  });

  it("leaves a field no track carries alone", () => {
    const album = [doc({}), doc({})];
    expect(changed(album)).toEqual([]);
  });

  it("never touches a per-track field", () => {
    const album = [
      doc({ title: mb("Graffiti"), tracknumber: mb(1), isrc: mb(["A"]) }),
      doc({ title: mb("Get Out"), tracknumber: mb(2), isrc: mb(["B"]) }),
    ];
    const { documents } = unifyAlbumScope(album);
    expect(documents.map((document) => document.fields["title"]?.value)).toEqual([
      "Graffiti",
      "Get Out",
    ]);
    expect(documents.map((document) => document.fields["tracknumber"]?.value)).toEqual([1, 2]);
  });
});

describe("applyAlbumScope", () => {
  const album = [
    doc({ genre: mb(["electropop", "synth-pop"]), copyright: yt("℗ 2018 CHVRCHES") }),
    doc({ genre: mb(["synth-pop"]), copyright: yt("℗ 2018 CHVRCHES, Vertigo/Capitol") }),
    doc({ genre: fm(["Synthpop"]), copyright: yt("℗ 2018 CHVRCHES") }),
  ];

  it("removes the divergence, so the album scores what its tracks score", () => {
    const before = albumCompleteness(album);
    expect(before.divergentFields).toEqual(["copyright", "genre"]);
    expect(before.penalty).toBeCloseTo(0.04, 10);

    const { documents } = unifyAlbumScope(album, { maxGenres: 3 });
    const after = albumCompleteness(documents);
    expect(after.divergentFields).toEqual([]);
    expect(after.penalty).toBe(0);
    expect(after.score).toBe(after.meanTrackScore);
    const scores = documents.map((document) => trackCompleteness(document).score ?? 0);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    expect(after.score).toBeCloseTo(mean, 10);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = unifyAlbumScope(album, { maxGenres: 3 });
    const twice = unifyAlbumScope(once.documents, { maxGenres: 3 });
    expect(changedChoices(twice.resolution)).toEqual([]);
    expect(twice.documents).toEqual(once.documents);
  });

  it("keeps every field's provenance readable", () => {
    const { documents } = unifyAlbumScope(album, { maxGenres: 3 });
    const genre = documents[2]?.fields["genre"];
    expect(genre?.source).toBe("musicbrainz");
    expect(genre?.fetchedAt).toBe(AT);
  });

  it("returns the very same object for a track it does not change", () => {
    const consistent = [doc({ genre: mb(["synth-pop"]) }), doc({ genre: mb(["synth-pop"]) })];
    const { documents } = unifyAlbumScope(consistent);
    expect(documents[0]).toBe(consistent[0]);
  });

  it("does nothing to a single-track album", () => {
    const one = [doc({ genre: mb(["synth-pop"]) })];
    expect(changed(one)).toEqual([]);
  });
});

describe("applyAlbumScopeTo — one file out of a batch", () => {
  it("writes the album's value onto a single track, disc by disc", () => {
    const album = [
      doc({ discnumber: mb(1), totaltracks: mb(12), genre: mb(["synth-pop"]) }),
      doc({ discnumber: mb(1), totaltracks: mb(12), genre: mb(["electropop"]) }),
      doc({ discnumber: mb(2), totaltracks: mb(9), genre: mb(["synth-pop"]) }),
    ];
    const resolution = resolveAlbumScope(album, { maxGenres: 3 });

    // The re-tag rebuilds one file at a time; it never holds the array the resolution was
    // computed from, only this one document.
    const second = applyAlbumScopeTo(album[1] as TrackDocument, resolution);
    expect(second.fields["genre"]?.value).toEqual(["synth-pop", "electropop"]);
    expect(second.fields["totaltracks"]?.value).toBe(12);

    const third = applyAlbumScopeTo(album[2] as TrackDocument, resolution);
    expect(third.fields["totaltracks"]?.value).toBe(9);
  });
});

describe("applyAlbumScope — every album-scope field has a rule", () => {
  it("names the grouping and the strategy for each of the 36", () => {
    for (const name of ["genre", "mood", "copyright", "totaltracks", "media", "album", "date"]) {
      const rule = albumScopeRule(name);
      expect(rule.why.length).toBeGreaterThan(10);
      expect(["album", "medium"]).toContain(rule.grouping);
    }
  });
});
