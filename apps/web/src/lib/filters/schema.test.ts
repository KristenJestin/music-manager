/**
 * The URL encoding, both ways, and the wall in front of it.
 *
 * Two properties carry the feature: a filter written into a link comes back *identical* when
 * the link is opened, and anything else comes back as **no filter plus a sentence** rather
 * than as a stack trace or, worse, as a partly-applied filter under a URL that claims
 * otherwise.
 */
import { describe, expect, it } from "vitest";
import { ALBUM_FILTER_FIELDS, TRACK_FILTER_FIELDS } from "./fields.ts";
import { decodeFilter, encodeFilter, FILTER_LIMITS } from "./schema.ts";
import { EMPTY_FILTER, type FilterGroup } from "./types.ts";

const roundTrip = (raw: string): FilterGroup => {
  const decoded = decodeFilter(raw, ALBUM_FILTER_FIELDS);
  expect(decoded.error, `"${raw}" was refused: ${decoded.error ?? ""}`).toBeNull();
  return decoded.tree;
};

describe("reading a filter out of a URL", () => {
  it("reads one condition", () => {
    expect(roundTrip("title:contains:daft punk")).toEqual({
      kind: "group",
      join: "and",
      children: [{ kind: "condition", field: "title", op: "contains", values: ["daft punk"] }],
    });
  });

  it('joins with ";" for and and "," for or', () => {
    expect(roundTrip("year:gte:2000;hasCover:is:true").join).toBe("and");
    expect(roundTrip("year:gte:2000,hasCover:is:true").join).toBe("or");
  });

  it("reads a nested or group inside an and", () => {
    const tree = roundTrip("tagged:is:true;(hasCover:is:false,schema:eq:behind)");
    expect(tree.join).toBe("and");
    expect(tree.children).toHaveLength(2);
    expect(tree.children[1]).toMatchObject({ kind: "group", join: "or" });
  });

  it("reads a range and a list", () => {
    expect(roundTrip("year:between:1990|2000").children[0]).toMatchObject({
      op: "between",
      values: ["1990", "2000"],
    });
    expect(roundTrip("format:in:opus|flac").children[0]).toMatchObject({
      op: "in",
      values: ["opus", "flac"],
    });
  });

  it("reads an operator that takes no operand", () => {
    expect(roundTrip("year:isEmpty").children[0]).toMatchObject({ op: "isEmpty", values: [] });
  });

  it("survives a title with the grammar's own punctuation in it", () => {
    const tree = roundTrip("title:eq:Duran Duran\\: the b-sides \\(1983\\)");
    expect(tree.children[0]).toMatchObject({ values: ["Duran Duran: the b-sides (1983)"] });
  });

  it("is empty when there is no filter", () => {
    expect(decodeFilter("", ALBUM_FILTER_FIELDS)).toEqual({ tree: EMPTY_FILTER, error: null });
    expect(decodeFilter(undefined, ALBUM_FILTER_FIELDS).error).toBeNull();
  });
});

describe("writing a filter into a URL", () => {
  const cases = [
    "title:contains:daft punk",
    "year:between:1990|2000",
    "title:contains:daft;year:gte:2000;hasCover:is:true",
    "title:contains:daft,year:gte:2000",
    "tagged:is:true;(hasCover:is:false,schema:eq:behind)",
    "format:in:opus|flac;completion:eq:incomplete",
    "title:eq:Duran Duran\\: the b-sides \\(1983\\)",
    "year:isEmpty",
  ];

  for (const raw of cases) {
    it(`round-trips ${raw}`, () => {
      expect(encodeFilter(roundTrip(raw))).toBe(raw);
      // And once more, so a link produced from a decoded link is the same link.
      expect(encodeFilter(roundTrip(encodeFilter(roundTrip(raw))))).toBe(raw);
    });
  }

  it("writes the empty tree as the empty string", () => {
    expect(encodeFilter(EMPTY_FILTER)).toBe("");
  });
});

describe("a filter that does not parse is no filter, with a notice", () => {
  const refused = (raw: string, fields = ALBUM_FILTER_FIELDS): string => {
    const decoded = decodeFilter(raw, fields);
    expect(decoded.tree.children, `"${raw}" was accepted`).toHaveLength(0);
    expect(decoded.error).not.toBeNull();
    return decoded.error ?? "";
  };

  it("refuses a field the page does not declare", () => {
    expect(refused("cover_path:contains:x")).toContain("is not a field this page can filter on");
    // A track field on the album page is exactly as unknown as an invented one.
    expect(refused("hasLyrics:is:true")).toContain("is not a field this page can filter on");
  });

  it("refuses a field that would be a column name", () => {
    expect(refused('title" or 1=1 --:contains:x')).toContain("is not a field");
    expect(refused("library_albums.title:contains:x")).toContain("is not a field");
  });

  it("refuses an operator the field does not allow", () => {
    expect(refused("hasCover:contains:x")).toContain("does not support");
    expect(refused("title:between:a|b")).toContain("does not support");
  });

  it("refuses an operand of the wrong type", () => {
    expect(refused("year:eq:nineteen")).toContain("is not a number");
    expect(refused("hasCover:is:maybe")).toContain("true or false");
    expect(refused("added:gte:yesterday")).toContain("YYYY-MM-DD");
    expect(refused("verification:eq:probably")).toContain("is not one of");
  });

  it("refuses a number outside the field's bounds", () => {
    expect(refused("score:gte:400")).toContain("cannot be above");
  });

  it("refuses a range that runs backwards", () => {
    expect(refused("year:between:2000|1990")).toContain("starts above where it ends");
  });

  it("refuses the wrong number of operands", () => {
    expect(refused("year:between:2000")).toContain("value(s)");
    expect(refused("year:isEmpty:2000")).toContain("value(s)");
  });

  it("refuses a level that mixes and with or", () => {
    expect(refused("year:gte:2000;hasCover:is:true,tagged:is:false")).toContain("parentheses");
  });

  it("refuses unbalanced parentheses and stray separators", () => {
    expect(refused("(year:gte:2000")).toContain("never closed");
    expect(refused("year:gte:2000)")).toContain('")" with no "("');
    expect(refused("year:gte:2000;;hasCover:is:true")).toContain("empty condition");
    expect(refused("year")).toContain("field:operator");
  });

  it("refuses a tree bigger than the limits", () => {
    const many = Array.from({ length: FILTER_LIMITS.conditions + 1 }, () => "year:gte:2000").join(
      ";",
    );
    expect(refused(many)).toContain("conditions at most");
  });

  it("refuses the album page's fields on the tracks page", () => {
    expect(refused("completion:eq:incomplete", TRACK_FILTER_FIELDS)).toContain("is not a field");
  });
});
