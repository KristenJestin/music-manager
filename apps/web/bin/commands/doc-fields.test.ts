/**
 * `mm doc fields` — the manual that was missing.
 *
 * `mm doc set` refuses an album-scope field on a track and a per-track field on an album, and
 * the refusal named no way to find out which was which beforehand: `ALBUM`, `DATE` and
 * `TOTALDISCS` belong to the album, `DISCNUMBER` to the track, and the only way to learn it
 * was to be told off. This asserts the answer the command gives, and that it is the *same*
 * answer the two `override*Fields` services enforce — the point of quoting
 * `ALBUM_SCOPE_FIELDS` rather than writing a second list.
 */
import { describe, expect, it } from "vitest";
import { ALBUM_SCOPE_FIELDS, TAGS } from "@mm/domain";
import { fieldRows, renderFieldTable, rowsForScope } from "./doc-fields.ts";

/** The row for one field, or a failure naming it — never a silent `undefined`. */
function row(field: string) {
  const found = fieldRows().find((entry) => entry.field === field);
  if (found === undefined) throw new Error(`no row for ${field}`);
  return found;
}

describe("mm doc fields", () => {
  it("puts ALBUM, DATE and TOTALDISCS at album level, and DISCNUMBER at track level", () => {
    // The four fields the defect names, each one asserted by name: this is the sentence the
    // command exists to print, and a regression that flipped a scope would be invisible in a
    // count.
    expect(row("album").scope).toBe("album");
    expect(row("date").scope).toBe("album");
    expect(row("totaldiscs").scope).toBe("album");
    expect(row("discnumber").scope).toBe("track");
  });

  it("says album for every field the tag map marks `albumScope`, and track for every other", () => {
    // The whole table, against the source of truth itself rather than against a fixture: the
    // command cannot disagree with `services/overrides.ts`, which reads the same constant.
    for (const tag of TAGS) {
      expect(row(tag.field).scope, tag.field).toBe(
        ALBUM_SCOPE_FIELDS.includes(tag.field) ? "album" : "track",
      );
    }
  });

  it("invents no field: every row is a row of the tag map", () => {
    const rows = fieldRows();
    expect(rows).toHaveLength(TAGS.length);
    expect(new Set(rows.map((entry) => entry.field)).size).toBe(TAGS.length);
    for (const entry of rows) {
      const tag = TAGS.find((candidate) => candidate.field === entry.field);
      expect(tag, entry.field).toBeDefined();
      // `vorbis` and `level` are quoted from the table, not guessed.
      expect(entry.vorbis).toBe(tag?.vorbis);
      expect(entry.level).toBe(tag?.level);
      expect(entry.group).toBe(tag?.group);
    }
  });

  it("names the three fields that are constant per disc, not across the release", () => {
    // `albumScope` is true for them, so `scope` says "album" — and saying only that would be a
    // guess dressed as a fact, because forcing one TRACKTOTAL across a two-disc release
    // corrupts the second disc.
    const perDisc = fieldRows().filter((entry) => entry.grouping === "medium");
    expect(perDisc.map((entry) => entry.field).sort()).toEqual([
      "media",
      "totaltracks",
      "totaltracks_alias",
    ]);
    expect(perDisc.every((entry) => entry.scope === "album")).toBe(true);
    expect(perDisc.every((entry) => entry.rule !== "")).toBe(true);
  });

  it("gives a rule for every album-scope field and none for a per-track one", () => {
    for (const entry of fieldRows()) {
      if (entry.scope === "album") {
        expect(entry.rule, entry.field).not.toBe("");
        expect(entry.grouping, entry.field).not.toBeNull();
      } else {
        expect(entry.rule, entry.field).toBe("");
        expect(entry.grouping, entry.field).toBeNull();
      }
    }
  });

  it("prints both levels in the terminal form, and the counts agree with the rows", () => {
    const text = renderFieldTable(fieldRows());
    expect(text).toContain("album");
    expect(text).toContain("track");
    // Every row reaches the page: nothing is dropped between the table and the text.
    for (const entry of fieldRows()) {
      expect(text).toContain(entry.field);
      expect(text).toContain(entry.vorbis);
    }
    const albumRows = fieldRows().filter((entry) => entry.scope === "album").length;
    expect(text).toContain(`${String(albumRows)} album-scope`);
  });

  it("narrows to one level without losing or inventing a row", () => {
    const albums = rowsForScope("album");
    const tracks = rowsForScope("track");
    expect(albums.length + tracks.length).toBe(TAGS.length);
    expect(albums.every((entry) => entry.scope === "album")).toBe(true);
    expect(tracks.every((entry) => entry.scope === "track")).toBe(true);
    expect(rowsForScope(null)).toHaveLength(TAGS.length);
    // The two the defect is about are on opposite sides of the split.
    expect(albums.map((entry) => entry.field)).toContain("album");
    expect(tracks.map((entry) => entry.field)).toContain("discnumber");
  });
});
