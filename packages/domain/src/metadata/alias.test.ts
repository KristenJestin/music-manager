/**
 * `pickAlias` and `isLatinScript` — the two decisions the locale feature rests on.
 *
 * Table-driven, because every row is a rule somebody will want to change later and the table
 * is the only place the rules are all visible at once.
 */
import { describe, expect, it } from "vitest";
import {
  creditIsCanonical,
  describeAlias,
  isLatinScript,
  pickAlias,
  type AliasQuery,
  type MbAlias,
} from "./alias.ts";

/** A MusicBrainz alias, spelled the short way. */
function alias(name: string, extra: Partial<MbAlias> = {}): MbAlias {
  return { name, type: "Artist name", locale: "en", primary: true, ...extra };
}

const EN: AliasQuery = { locale: "en", onlyNonLatin: false, kind: "artist" };

describe("isLatinScript", () => {
  const rows: readonly [string, boolean][] = [
    ["Yuki Kajiura", true],
    ["Björk", true],
    ["Sigur Rós", true],
    // NFD: the diaeresis is a combining mark, Script=Inherited, and must not read as foreign.
    // Built with `normalize`, because Prettier unescapes a `̈` written by hand and the
    // decomposed form then becomes invisible in the source.
    ["Björk".normalize("NFD"), true],
    ["!!!", true],
    ["21", true],
    ["梶浦由記", false],
    ["ダフト・パンク", false],
    ["Кино", false],
    ["엑소", false],
    // A mixed name is not Latin: one foreign letter is enough to want the translation.
    ["Kajiura 由記", false],
    ["", true],
  ];
  for (const [value, latin] of rows) {
    it(`${JSON.stringify(value)} → ${String(latin)}`, () => {
      expect(isLatinScript(value)).toBe(latin);
    });
  }
});

describe("pickAlias", () => {
  const rows: readonly {
    readonly what: string;
    readonly aliases: readonly MbAlias[];
    readonly query: AliasQuery;
    readonly expected: string | null;
  }[] = [
    {
      what: "an empty locale translates nothing at all",
      aliases: [alias("Yuki Kajiura")],
      query: { ...EN, locale: "" },
      expected: null,
    },
    {
      what: "the primary alias of the exact locale",
      aliases: [alias("Kajiura Yuki", { primary: false }), alias("Yuki Kajiura")],
      query: EN,
      expected: "Yuki Kajiura",
    },
    {
      what: "no primary: MusicBrainz's own order decides, so the answer is deterministic",
      aliases: [alias("First", { primary: false }), alias("Second", { primary: false })],
      query: EN,
      expected: "First",
    },
    {
      what: "an exact locale beats a primary language-only one",
      aliases: [alias("British", { locale: "en_GB" }), alias("Plain", { primary: false })],
      query: EN,
      expected: "Plain",
    },
    {
      what: "`en` covers `en_GB` when there is no plain `en`",
      aliases: [alias("British", { locale: "en_GB", primary: false })],
      query: EN,
      expected: "British",
    },
    {
      what: "another language is not a candidate",
      aliases: [alias("ダフト・パンク", { locale: "ja" })],
      query: EN,
      expected: null,
    },
    {
      what: "an alias with no locale is never chosen",
      aliases: [alias("Whatever", { locale: null })],
      query: EN,
      expected: null,
    },
    {
      what: "an ended alias is a name that stopped being used",
      aliases: [alias("Old Name", { ended: true }), alias("New Name", { primary: false })],
      query: EN,
      expected: "New Name",
    },
    {
      what: "`Legal name` is a fact about the person, not the name to write",
      aliases: [alias("Yuki Kajiura", { type: "Legal name" })],
      query: EN,
      expected: null,
    },
    {
      what: "`Search hint` is not a name either",
      aliases: [alias("kajiura", { type: "Search hint" })],
      query: EN,
      expected: null,
    },
    {
      what: "an untyped alias is accepted only when it is primary for the locale",
      aliases: [alias("Untyped Primary", { type: null })],
      query: EN,
      expected: "Untyped Primary",
    },
    {
      what: "an untyped, non-primary alias is an unclassified string, not a translation",
      aliases: [alias("Untyped", { type: null, primary: false })],
      query: EN,
      expected: null,
    },
    {
      what: "`Release name` is the name type on the release side",
      aliases: [alias("Fiction", { type: "Release name" })],
      query: { locale: "en", onlyNonLatin: false, kind: "release" },
      expected: "Fiction",
    },
    {
      what: "`Artist name` is not a release name",
      aliases: [alias("Fiction", { type: "Artist name" })],
      query: { locale: "en", onlyNonLatin: false, kind: "release" },
      expected: null,
    },
    {
      what: "onlyNonLatin spares a name already written in Latin script (Picard's rule)",
      aliases: [alias("Bjork")],
      query: { ...EN, onlyNonLatin: true, credited: "Björk" },
      expected: null,
    },
    {
      what: "onlyNonLatin still translates a non-Latin name",
      aliases: [alias("Yuki Kajiura")],
      query: { ...EN, onlyNonLatin: true, credited: "梶浦由記" },
      expected: "Yuki Kajiura",
    },
    {
      what: "onlyNonLatin with no credited name to judge translates anyway",
      aliases: [alias("Yuki Kajiura")],
      query: { ...EN, onlyNonLatin: true },
      expected: "Yuki Kajiura",
    },
    {
      what: "an absent alias list is not an error",
      aliases: [],
      query: EN,
      expected: null,
    },
    {
      what: "an alias with no name is skipped",
      aliases: [alias(""), alias("Real", { primary: false })],
      query: EN,
      expected: "Real",
    },
  ];

  for (const row of rows) {
    it(row.what, () => {
      expect(pickAlias(row.aliases, row.query)?.name ?? null).toBe(row.expected);
    });
  }

  it("accepts an undefined alias list", () => {
    expect(pickAlias(undefined, EN)).toBeNull();
  });

  it("is stable: the same list and query always give the same alias", () => {
    const aliases = [
      alias("A", { primary: false }),
      alias("B", { primary: false }),
      alias("C", { primary: false }),
    ];
    const first = pickAlias(aliases, EN);
    expect(pickAlias([...aliases], EN)).toEqual(first);
  });
});

describe("describeAlias", () => {
  it("names the locale and whether it was the primary one", () => {
    expect(describeAlias(alias("Yuki Kajiura"))).toBe("alias en (primary)");
    expect(describeAlias(alias("Kajiura Yuki", { primary: false }))).toBe("alias en");
    expect(describeAlias(alias("X", { locale: null, primary: false }))).toBe("alias ?");
  });
});

describe("creditIsCanonical", () => {
  it("is true for the same name, whatever its normalisation", () => {
    expect(creditIsCanonical("Björk".normalize("NFC"), "Björk".normalize("NFD"))).toBe(true);
    expect(creditIsCanonical("梶浦由記", "梶浦由記")).toBe(true);
  });

  it("is false for a deliberate “credited as”, which must never be translated", () => {
    expect(creditIsCanonical("Kanye West", "Ye")).toBe(false);
  });
});
