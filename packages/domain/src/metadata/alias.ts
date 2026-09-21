/**
 * Picking a locale alias — “Translate artist names to this locale”, as Picard names it.
 *
 * MusicBrainz stores, next to the canonical name of an artist or a release, a list of
 * **aliases**: other spellings, each optionally carrying a `locale`, a `type` and a `primary`
 * flag. 梶浦由記 has `Yuki Kajiura` filed as an `Artist name` alias with `locale: "en"` and
 * `primary: true`; ダフト・パンク is Daft Punk's `ja` one. The whole feature of this module is
 * to turn “my library is in English” into 梶浦由記 → Yuki Kajiura with nobody typing anything.
 *
 * Three things this module is deliberate about:
 *
 *  - **It is pure and total.** Same alias list, same preference, same answer, always — the
 *    tie-break falls back to MusicBrainz's own ordering rather than to anything derived from a
 *    clock or a hash, because `docs/03-metadonnees.md` §8 rests on a rebuild from the raw cache
 *    producing byte-identical documents.
 *  - **It never invents a transliteration.** If MusicBrainz has no alias in the locale, the
 *    answer is `null` and the caller keeps the original name. We do not romanise by algorithm;
 *    an alias is an editorial fact, a machine transliteration is a guess.
 *  - **`onlyNonLatin` is Picard's behaviour, and it is on by default.** Somebody asking for
 *    English names wants 梶浦由記 spelled out; they do not want `Björk` flattened to `Bjork`
 *    or `Sigur Rós` replaced by whatever an editor filed as the English alias.
 */

/** One entry of MusicBrainz's `aliases` array (`inc=aliases`). */
export interface MbAlias {
  readonly name?: string;
  readonly "sort-name"?: string;
  /** `Artist name`, `Legal name`, `Search hint`, `Release name`… `null` when unset. */
  readonly type?: string | null;
  readonly "type-id"?: string | null;
  /** BCP-47-ish, MusicBrainz style: `en`, `en_GB`, `ja`. `null` when the alias has none. */
  readonly locale?: string | null;
  /** The one alias to use for that locale, when an editor has said which. */
  readonly primary?: boolean | null;
  readonly begin?: string | null;
  readonly end?: string | null;
  /** A name that stopped being used. Never chosen. */
  readonly ended?: boolean | null;
}

/** Which entity the alias list belongs to — it decides the acceptable `type`. */
export type AliasKind = "artist" | "release";

/** The alias `type` that names the entity itself, per kind. Anything else is not a name. */
const NAME_TYPE: Readonly<Record<AliasKind, string>> = {
  /** Not `Legal name`, not `Search hint`: those are facts about the person, not their name. */
  artist: "Artist name",
  release: "Release name",
};

/**
 * The locales the Console offers, `""` first — “off”, and the default.
 *
 * A short list rather than every ISO 639-1 code: these are the locales MusicBrainz editors
 * actually file aliases in, and a picker of a hundred and eighty entries in which a hundred
 * and seventy do nothing is a worse answer than a picker of ten. It is data, so adding one is
 * a line here and nothing else.
 */
export const PREFERRED_LOCALES = [
  "",
  "en",
  "fr",
  "de",
  "es",
  "it",
  "ja",
  "pt",
  "ru",
  "zh",
  "ko",
] as const;

export type PreferredLocale = (typeof PREFERRED_LOCALES)[number];

/** What the user asked for, in one object: the locale, and whether to spare Latin names. */
export interface LocalePreference {
  /** An ISO 639-1 code, or `""` for “off” — the default, and the whole feature disabled. */
  readonly locale: string;
  /** Picard's rule: only translate a name that is not already written in Latin script. */
  readonly onlyNonLatin: boolean;
  /**
   * Translate `ARTIST`, `ARTISTS`, `ALBUMARTIST`, `ALBUMARTISTS`. Defaults to true.
   *
   * Separate from `albums` because the two have different consequences: an artist name is
   * only a tag, while `ALBUM` and `ALBUMARTIST` feed the path template, so translating albums
   * is also a decision about where files will be filed the next time `relocate` runs.
   */
  readonly artists?: boolean;
  /** Translate `ALBUM` (and move the original into `ALBUMSORT`). Defaults to true. */
  readonly albums?: boolean;
}

/** Does this preference translate artist names? Absent means yes. */
export function translatesArtists(locale: LocalePreference | undefined): boolean {
  return locale !== undefined && locale.artists !== false;
}

/** Does this preference translate album titles? Absent means yes. */
export function translatesAlbums(locale: LocalePreference | undefined): boolean {
  return locale !== undefined && locale.albums !== false;
}

/** The preference plus the two things that vary per call site. */
export interface AliasQuery extends LocalePreference {
  readonly kind: AliasKind;
  /**
   * The name that would be written without translation. Only used by `onlyNonLatin`: it is
   * the name we would be replacing, so it is the one whose script decides.
   */
  readonly credited?: string | undefined;
}

/** True when `value` carries no letter outside the Latin script. */
export function isLatinScript(value: string): boolean {
  for (const character of value) {
    // Digits, spaces, punctuation and symbols say nothing about a script: `21` and `!!!` are
    // neither Latin nor Japanese, and a name is not non-Latin because it contains a hyphen.
    if (!LETTER.test(character)) continue;
    if (!LATIN_LETTER.test(character)) return false;
  }
  return true;
}

/**
 * `\p{M}` (combining marks) counts as a letter here because it is what an accent decomposes
 * to: NFD `Björk` is `Bjo` + U+0308 + `rk`, and U+0308 is `Script=Inherited`, so it must be
 * accepted rather than treated as a foreign script.
 */
const LETTER = /[\p{L}\p{M}]/u;
const LATIN_LETTER = /[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

/**
 * The alias to use for `query`, or `null` to keep the original name.
 *
 * The rules, in order:
 *
 *  1. **off** — an empty locale translates nothing;
 *  2. **`onlyNonLatin`** — a credited name already written in Latin script is left alone;
 *  3. **usable aliases only** — never an `ended` one, never one with no name, and the `type`
 *     must be the entity's own name type (`Artist name`, `Release name`). An alias with **no
 *     type** is accepted only when it is `primary` for the locale: an untyped primary alias is
 *     an editor saying “this is the name in this locale”, whereas an untyped non-primary one
 *     is an unclassified string that is as likely to be a misspelling as a translation;
 *  4. **locale** — an exact match (`en` = `en`) beats a language-only one (`en` covers
 *     `en_GB`); an alias with no locale, or another language, is not a candidate at all;
 *  5. **`primary` first**, then **MusicBrainz's own order** — which makes the answer
 *     deterministic without inventing a preference nobody expressed.
 */
export function pickAlias(
  aliases: readonly MbAlias[] | undefined,
  query: AliasQuery,
): MbAlias | null {
  const wanted = query.locale.trim().toLowerCase();
  if (wanted === "") return null;
  if (query.onlyNonLatin && query.credited !== undefined && isLatinScript(query.credited)) {
    return null;
  }

  let best: MbAlias | null = null;
  // Strictly lower wins, so an equally ranked later alias never displaces an earlier one:
  // MusicBrainz's own order is the last tie-break, and it costs no extra state to honour it.
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const alias of aliases ?? []) {
    const name = alias.name ?? "";
    if (name === "" || alias.ended === true) continue;

    const match = localeMatch(alias.locale, wanted);
    if (match === null) continue;

    const primary = alias.primary === true;
    const type = alias.type ?? null;
    if (type !== NAME_TYPE[query.kind] && !(type === null && primary)) continue;

    // exact locale (0 or 2) outranks primary (0 or 1), which outranks MusicBrainz's order.
    const rank = match * 2 + (primary ? 0 : 1);
    if (rank < bestRank) {
      best = alias;
      bestRank = rank;
    }
  }

  return best;
}

/** 0 for an exact locale, 1 for a language-only match, `null` for no match at all. */
function localeMatch(locale: string | null | undefined, wanted: string): 0 | 1 | null {
  if (locale == null || locale === "") return null;
  const value = locale.toLowerCase();
  if (value === wanted) return 0;
  const language = value.split(/[_-]/, 1)[0] ?? "";
  return language === wanted ? 1 : null;
}

/**
 * The one-clause description that goes into a field's `via` — `alias en (primary)`.
 *
 * Descriptive only, exactly like `EmbeddedPicture.provenance` (decision 168): nothing is ever
 * derived from it, it is what the track page and `mm doc show` print when asked why the tag
 * does not say what MusicBrainz's canonical name says.
 */
export function describeAlias(alias: MbAlias): string {
  const locale = alias.locale ?? "?";
  return alias.primary === true ? `alias ${locale} (primary)` : `alias ${locale}`;
}

/**
 * True when the credited name is the artist's own name, NFC-normalised.
 *
 * **This is the guard that keeps a “credited as” intact — in `credited` mode.** An artist
 * credit carries two names: the canonical one and the one printed on this particular release.
 * When an editor has gone to the trouble of recording that 米津玄師 is credited as
 * `Kenshi Yonezu` *on this sleeve*, that is an editorial decision about this release, and a
 * locale preference is a blanket statement about the library — the specific fact wins. So a
 * credit whose printed name differs from the canonical one is never translated, whatever the
 * locale says.
 *
 * It is asked only when the printed name is what would be written (`artistNameSource:
 * "credited"`, D9-02). In `canonical` mode the artist's own name is written instead, so the
 * sleeve's spelling is already set aside and protecting it would only mean refusing the alias
 * — the two rules would then combine into “never translate”.
 *
 * NFC because MusicBrainz is not consistent about composed forms, and two spellings that
 * differ only by normalisation are the same name to every human being.
 */
export function creditIsCanonical(credited: string, canonical: string): boolean {
  return credited.normalize("NFC") === canonical.normalize("NFC");
}
