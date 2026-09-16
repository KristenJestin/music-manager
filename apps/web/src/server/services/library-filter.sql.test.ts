/**
 * The tree → SQL compiler, rendered rather than executed.
 *
 * `PgDialect.sqlToQuery` is what Drizzle itself calls on the way to the driver, so what is
 * asserted here is the literal text and the literal parameter list that Postgres would
 * receive. That is the only level at which "the operand is a parameter, not a piece of the
 * query" is a fact rather than an intention — and it needs no database, so it runs in the fast
 * gate beside everything else.
 *
 * The integration test next door proves the other half: that this `where` gives a count and a
 * page that agree.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { MMError } from "@mm/contracts";
import { describe, expect, it } from "vitest";
import {
  ALBUM_FILTER_FIELDS,
  ARTIST_FILTER_FIELDS,
  EMPTY_FILTER,
  FILTER_OPERATOR_ARITY,
  TRACK_FILTER_FIELDS,
  decodeFilter,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
} from "#/lib/filters/index.ts";
import {
  albumFilterBindings,
  bindingCoverage,
  compileFilter,
  trackFilterBindings,
  type FilterBindings,
} from "./library-filter.sql.ts";

const dialect = new PgDialect();

function render(tree: FilterGroup, bindings: FilterBindings): { sql: string; params: unknown[] } {
  const where = compileFilter(tree, bindings);
  if (where === undefined) return { sql: "", params: [] };
  const query = dialect.sqlToQuery(where);
  return { sql: query.sql, params: [...query.params] };
}

function condition(field: string, op: FilterOperator, ...values: string[]): FilterCondition {
  return { kind: "condition", field, op, values };
}

function group(join: "and" | "or", ...children: FilterNode[]): FilterGroup {
  return { kind: "group", join, children };
}

const albums = albumFilterBindings({ currentSchema: 4 });
const tracks = trackFilterBindings({ currentSchema: 4 });

describe("compiling a filter tree to SQL", () => {
  it("compiles the empty tree to no clause at all", () => {
    // `undefined`, not `true`: Drizzle's `.where(undefined)` emits nothing, so an unfiltered
    // page runs the query it ran before this feature existed.
    expect(compileFilter(EMPTY_FILTER, albums)).toBeUndefined();
    expect(compileFilter(group("and"), albums)).toBeUndefined();
    expect(compileFilter(group("and", group("or")), albums)).toBeUndefined();
  });

  it("puts every operand in the parameter list and never in the query text", () => {
    const { sql, params } = render(
      group(
        "and",
        condition("title", "contains", "Discovery"),
        condition("year", "between", "1995", "2005"),
      ),
      albums,
    );

    expect(sql).toContain('"library_albums"."title" ilike');
    expect(sql).toContain("and");
    expect(sql).not.toContain("Discovery");
    expect(params).toEqual(["%Discovery%", 1995, 2005]);
  });

  it("escapes LIKE's own syntax so a literal % is not a wildcard", () => {
    const { params } = render(group("and", condition("title", "contains", "100% Pure")), albums);
    expect(params).toEqual(["%100\\% Pure%"]);
  });

  it("nests and/or exactly as the tree says", () => {
    const { sql } = render(
      group(
        "and",
        condition("tagged", "is", "true"),
        group("or", condition("hasCover", "is", "false"), condition("schema", "eq", "behind")),
      ),
      albums,
    );

    // One `and` at the top, one `or` inside it: the shape of the tree, not a flattening of it.
    expect(sql).toMatch(/\(.* and \(.* or .*\)\)/s);
    expect(sql).toContain('not (("library_albums"."cover_path" is not null))');
  });

  it("turns is:false into the negation of the same expression", () => {
    const yes = render(group("and", condition("missingFile", "is", "true")), tracks);
    const no = render(group("and", condition("missingFile", "is", "false")), tracks);
    expect(no.sql).toBe(`not (${yes.sql})`);
  });

  it("reads a whole day for a date's upper bound", () => {
    const { sql, params } = render(group("and", condition("added", "lte", "2026-03-03")), albums);
    expect(sql).toContain("interval '1 day'");
    expect(params).toEqual(["2026-03-03"]);
  });

  it("compiles the three completion states, unknown among them", () => {
    const { sql } = render(group("and", condition("completion", "eq", "unknown")), albums);
    // "Unknown total" is not "complete": an album whose denominator is our own row count has
    // no total, and a filter that swept it into "complete" would restore the 1/1 lie.
    expect(sql).toContain("track_count_source");
    expect(sql).toContain("not (");
  });
});

describe("the whitelist is the only way in", () => {
  it("refuses a field name that is not declared, however it is spelled", () => {
    const attack = condition('title") or 1=1 --', "contains", "x");
    expect(() => compileFilter(group("and", attack), albums)).toThrow(MMError);
    try {
      compileFilter(group("and", attack), albums);
    } catch (error) {
      expect((error as MMError).code).toBe("INVALID_INPUT");
      expect((error as MMError).message).toContain("is not a filterable field");
    }
  });

  it("never gets that far, because the URL schema refuses it first", () => {
    const decoded = decodeFilter('title" or 1=1 --:contains:x', ALBUM_FILTER_FIELDS);
    expect(decoded.tree.children).toHaveLength(0);
    expect(decoded.error).toContain("is not a field this page can filter on");
  });

  it("refuses a real field under an operator it does not declare", () => {
    // `hasCover` is a boolean; `contains` would be a string comparison against a predicate.
    expect(() =>
      compileFilter(group("and", condition("hasCover", "contains", "x")), albums),
    ).toThrow(MMError);
  });

  it("refuses an enum value outside the field's list", () => {
    expect(() =>
      compileFilter(group("and", condition("verification", "eq", "whatever")), albums),
    ).toThrow(MMError);
  });

  it("refuses a field of another page's set", () => {
    // `hasLyrics` is a track field. The album page must not answer for it.
    expect(() => compileFilter(group("and", condition("hasLyrics", "is", "true")), albums)).toThrow(
      MMError,
    );
  });
});

describe("every declared field is bound, and every declared operator compiles", () => {
  const sample: Readonly<Record<string, readonly string[]>> = {
    text: ["daft"],
    number: ["10"],
    date: ["2026-01-01"],
    boolean: ["true"],
  };

  for (const { page, fields, bindings } of bindingCoverage()) {
    it(`${page}: no field is left without SQL`, () => {
      for (const field of fields) {
        expect(bindings[field.name], `${page}.${field.name} has no binding`).toBeDefined();
        for (const op of field.operators) {
          const [min] = FILTER_OPERATOR_ARITY[op];
          const one =
            field.type === "enum"
              ? (field.options?.[0]?.value ?? "")
              : (sample[field.type]?.[0] ?? "x");
          const two = field.type === "date" ? "2026-12-31" : "20";
          const values = min === 0 ? [] : min === 2 ? [one, two] : [one];
          expect(
            () => compileFilter(group("and", condition(field.name, op, ...values)), bindings),
            `${page}.${field.name} cannot compile "${op}"`,
          ).not.toThrow();
        }
      }
    });
  }

  it("declares the same field names to the browser and to the database", () => {
    const names = (set: typeof ALBUM_FILTER_FIELDS): string[] =>
      set.map((field) => field.name).sort();
    const [albumPage, trackPage, artistPage] = bindingCoverage();
    expect(names(albumPage?.fields ?? [])).toEqual(names(ALBUM_FILTER_FIELDS));
    expect(names(trackPage?.fields ?? [])).toEqual(names(TRACK_FILTER_FIELDS));
    expect(names(artistPage?.fields ?? [])).toEqual(names(ARTIST_FILTER_FIELDS));
  });
});
