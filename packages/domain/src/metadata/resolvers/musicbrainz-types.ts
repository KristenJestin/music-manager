/**
 * The subset of the MusicBrainz WS/2 JSON we actually read.
 *
 * These are structural descriptions, not validators: parsing happens at the network boundary
 * in P04 with zod, and the raw cache keeps the full response for ever (§8). Everything here
 * is optional, because MusicBrainz omits what it does not have and the `inc=` list decides
 * the rest.
 */

import {
  creditIsCanonical,
  describeAlias,
  pickAlias,
  type LocalePreference,
  type MbAlias,
} from "../alias.ts";
import { isSpecialPurposeArtist } from "../special-purpose.ts";

export type { LocalePreference, MbAlias };

export interface MbArtist {
  readonly id?: string;
  readonly name?: string;
  readonly "sort-name"?: string;
  readonly disambiguation?: string;
  /** `inc=aliases`: the locale spellings of the name. See `../alias.ts`. */
  readonly aliases?: readonly MbAlias[];
}

export interface MbArtistCreditEntry {
  readonly name?: string;
  readonly joinphrase?: string;
  readonly artist?: MbArtist;
}

export interface MbGenre {
  readonly name?: string;
  readonly count?: number;
}

export interface MbTag {
  readonly name?: string;
  readonly count?: number;
}

export interface MbUrl {
  readonly resource?: string;
}

export interface MbRelation {
  readonly type?: string;
  readonly "type-id"?: string;
  readonly direction?: string;
  readonly "target-type"?: string;
  readonly attributes?: readonly string[];
  readonly artist?: MbArtist;
  readonly work?: MbWork;
  readonly url?: MbUrl;
}

export interface MbWork {
  readonly id?: string;
  readonly title?: string;
  readonly disambiguation?: string;
  readonly language?: string;
  readonly languages?: readonly string[];
  readonly iswcs?: readonly string[];
  readonly relations?: readonly MbRelation[];
}

export interface MbRecording {
  readonly id?: string;
  readonly title?: string;
  readonly disambiguation?: string;
  readonly length?: number;
  readonly video?: boolean;
  readonly isrcs?: readonly string[];
  readonly genres?: readonly MbGenre[];
  readonly tags?: readonly MbTag[];
  readonly relations?: readonly MbRelation[];
  readonly "artist-credit"?: readonly MbArtistCreditEntry[];
  readonly "first-release-date"?: string;
  /**
   * `inc=aliases`, and **unusable for translation**: recording aliases carry no `locale` in
   * MusicBrainz's data, so `pickAlias` never matches one. A track title is translated from a
   * pseudo-release instead (docs/03 §2.1).
   */
  readonly aliases?: readonly MbAlias[];
}

export interface MbTrack {
  readonly id?: string;
  readonly position?: number;
  readonly number?: string;
  readonly title?: string;
  readonly length?: number;
  readonly recording?: MbRecording;
  readonly "artist-credit"?: readonly MbArtistCreditEntry[];
}

export interface MbMedium {
  readonly position?: number;
  readonly format?: string;
  readonly title?: string;
  readonly "track-count"?: number;
  readonly tracks?: readonly MbTrack[];
}

export interface MbLabelInfo {
  /** MusicBrainz sends `null` — not an absent key — for a label entry with no catalogue number. */
  readonly "catalog-number"?: string | null;
  readonly label?: { readonly id?: string; readonly name?: string };
}

export interface MbReleaseGroup {
  readonly id?: string;
  readonly title?: string;
  /** MusicBrainz sends `null` — not an absent key — for a group with no primary type. */
  readonly "primary-type"?: string | null;
  readonly "secondary-types"?: readonly string[];
  readonly "first-release-date"?: string;
  readonly genres?: readonly MbGenre[];
  readonly tags?: readonly MbTag[];
  /** `inc=aliases`: rarer than on artists, and the first place an album title is looked for. */
  readonly aliases?: readonly MbAlias[];
}

/**
 * The `cover-art-archive` block a **release lookup** carries (decision 167).
 *
 * MusicBrainz answers it on every release lookup and on no release *search*, which is the
 * whole economics of the `coverArt` signal: the matcher already spends a lookup per candidate
 * to read its tracklist, so knowing whether that pressing has a front costs nothing extra.
 * A candidate that was never looked up has no block at all, and its signal is `null` —
 * unknown, not absent — exactly as its tracklist fit is.
 */
export interface MbCoverArtArchive {
  /** At least one image of any type. */
  readonly artwork?: boolean;
  /** A front cover specifically — the only one we would embed. */
  readonly front?: boolean;
  readonly back?: boolean;
  readonly count?: number;
  readonly darkened?: boolean;
}

export interface MbRelease {
  readonly id?: string;
  readonly title?: string;
  readonly disambiguation?: string;
  readonly date?: string;
  readonly "cover-art-archive"?: MbCoverArtArchive;
  readonly country?: string;
  readonly status?: string;
  /**
   * The physical packaging — `Jewel Case`, `Digipak`, `Cardboard/Paper Sleeve`, `None` for a
   * digital release.
   *
   * It has always been in the payload a release lookup returns, and `scripts/prune-musicbrainz.ts`
   * has always kept it; it was simply never typed, so the candidate card could not say that two
   * otherwise identical pressings are a jewel case and a digipak. No `inc=` list changes for it.
   */
  readonly packaging?: string | null;
  readonly barcode?: string;
  readonly asin?: string;
  readonly quality?: string;
  readonly "text-representation"?: { readonly language?: string; readonly script?: string };
  readonly "artist-credit"?: readonly MbArtistCreditEntry[];
  readonly "label-info"?: readonly MbLabelInfo[];
  readonly "release-group"?: MbReleaseGroup;
  readonly media?: readonly MbMedium[];
  readonly relations?: readonly MbRelation[];
  readonly genres?: readonly MbGenre[];
  readonly tags?: readonly MbTag[];
  readonly aliases?: readonly MbAlias[];
}

/**
 * Which of the two names MusicBrainz holds for a credited artist goes into the tag.
 *
 * An artist credit has two: `credit.name`, the name **as credited on this release** (the
 * "credited as" field — `Beyoncé` printed as `Sasha Fierce`, `Ye` printed as `Kanye West`),
 * and `credit.artist.name`, the artist's canonical name in the database.
 *
 * - `credited` — `credit.name`, falling back to the canonical one. What the sleeve says, and
 *   what Picard writes by default.
 * - `canonical` — `credit.artist.name`, falling back to the credited one. One spelling per
 *   artist across the whole library, which is what makes an artist page collect everything.
 *   It is also what v1 wrote, so a v1 library re-tagged by v2 keeps its artist names.
 *
 * The join phrases are MusicBrainz's either way: only the names are substituted.
 */
export const ARTIST_NAME_SOURCES = ["credited", "canonical"] as const;
export type ArtistNameSource = (typeof ARTIST_NAME_SOURCES)[number];

function nameOf(entry: MbArtistCreditEntry, source: ArtistNameSource): string {
  const credited = entry.name ?? "";
  const canonical = entry.artist?.name ?? "";
  if (source === "canonical") return canonical === "" ? credited : canonical;
  return credited === "" ? canonical : credited;
}

/**
 * One credit entry's name, translated to the preferred locale when there is an alias for it.
 *
 * **A deliberate “credited as” is never translated in `credited` mode.** The credit carries
 * the name printed on this release next to the artist's canonical one; when an editor has
 * recorded that the two differ, that is a fact about this sleeve, and a library-wide locale
 * preference does not get to overrule it. So the alias is only applied when the printed name
 * *is* the canonical name (NFC-normalised) — see `creditIsCanonical` in `../alias.ts`.
 *
 * **D9-02: that guard protects a printed name, and only that.** In `canonical` mode the name
 * written is the artist's own, not the sleeve's, so the credit has already been set aside and
 * there is nothing left to protect: the alias applies. Without this the two settings combine
 * into “never translate” — the credit is refused a translation *and* the printed name is
 * dropped — which is exactly what happened to *Suzume*'s `RADWIMPS, 陣内一真`, whose
 * album-artist credit is a genuine credited-as (`Kazuma Jinnouchi` for `陣内一真`) and whose
 * artist has `{Kazuma Jinnouchi, en, primary}`.
 *
 * The alias is looked up on `entry.artist`, never on the credit: only the artist entity has
 * an alias list, and it is the entity the locale preference is about.
 */
function translate(
  entry: MbArtistCreditEntry,
  source: ArtistNameSource,
  locale: LocalePreference | undefined,
): { name: string; alias: MbAlias | null } {
  const fallback = nameOf(entry, source);
  const canonical = entry.artist?.name ?? "";
  if (locale === undefined || canonical === "") return { name: fallback, alias: null };
  if (source === "credited" && !creditIsCanonical(entry.name ?? canonical, canonical))
    return { name: fallback, alias: null };

  const alias = pickAlias(entry.artist?.aliases, {
    ...locale,
    kind: "artist",
    credited: fallback,
  });
  const name = alias?.name ?? "";
  return name === "" ? { name: fallback, alias: null } : { name, alias };
}

/**
 * The credit entries that name an artist at all (issue #6).
 *
 * MusicBrainz credits `[unknown]`, `[no artist]`, `[dialogue]`… when it has nobody to name:
 * those are **special-purpose artists**, rows whose name is bracketed so that a human reading
 * the database knows it is not a name (`../special-purpose.ts`). They are dropped here, in the
 * one place every credit field goes through, so `ARTIST`, `ARTISTSORT` and
 * `MUSICBRAINZ_ARTISTID` cannot disagree about who performed the track. **D6-01: by MBID,
 * never by name** — `[adult swim]` is a real artist whose name is bracketed, and a pattern
 * rule would eat it. `Various Artists` is not one of them, on purpose: it is the row that makes
 * a compilation a compilation, and losing it would cost `COMPILATION` itself.
 */
function creditedEntries(
  credit: readonly MbArtistCreditEntry[] | undefined,
): readonly MbArtistCreditEntry[] {
  return (credit ?? []).filter((entry) => !isSpecialPurposeArtist(entry.artist?.id));
}

/**
 * True when a credit names a special-purpose artist **and nobody else** — the case where the
 * credit fields are `n/a` ("MusicBrainz special-purpose artist") rather than missing (D6-02).
 *
 * A credit of `[unknown] & Daft Punk` keeps Daft Punk and is not n/a: somebody was named.
 */
export function creditIsOnlySpecialPurpose(
  credit: readonly MbArtistCreditEntry[] | undefined,
): boolean {
  const entries = credit ?? [];
  return entries.length > 0 && creditedEntries(entries).length === 0;
}

/** `ARTIST` is the credit rebuilt with MusicBrainz's own join phrases (§2.1). */
export function joinArtistCredit(
  credit: readonly MbArtistCreditEntry[] | undefined,
  source: ArtistNameSource = "credited",
  locale?: LocalePreference,
): string | null {
  const entries = creditedEntries(credit);
  if (entries.length === 0) return null;
  const discarded = (credit?.length ?? 0) - entries.length;
  // The join phrases are MusicBrainz's, untouched: translating names must never turn
  // "Daft Punk feat. Romanthony" into "Daft Punk Romanthony". A joinphrase belongs to the
  // entry *before* it, so dropping the entry after a “&” drops the “&” with it — keeping it
  // would leave `Daft Punk & ` as the artist.
  const joined = entries
    .map((entry, index) => {
      const name = translate(entry, source, locale).name;
      const trailing =
        discarded > 0 && index === entries.length - 1 ? "" : (entry.joinphrase ?? "");
      return `${name}${trailing}`;
    })
    .join("");
  return joined === "" ? null : joined;
}

/** `ARTISTS`: one entry per credited artist, in credit order. */
export function artistNames(
  credit: readonly MbArtistCreditEntry[] | undefined,
  source: ArtistNameSource = "credited",
  locale?: LocalePreference,
): string[] {
  return creditedEntries(credit)
    .map((entry) => translate(entry, source, locale).name)
    .filter((name) => name !== "");
}

/**
 * The `via` clause for a translated credit — `alias en (primary)` — or `null`.
 *
 * The first alias actually applied describes the whole credit: a credit whose names come from
 * two locales does not exist, and one where only the second artist was translated is still
 * “this tag was translated”, which is all `via` claims (see `Field.via`).
 */
export function artistAliasVia(
  credit: readonly MbArtistCreditEntry[] | undefined,
  source: ArtistNameSource = "credited",
  locale?: LocalePreference,
): string | null {
  for (const entry of creditedEntries(credit)) {
    const alias = translate(entry, source, locale).alias;
    if (alias !== null) return describeAlias(alias);
  }
  return null;
}

/** `ARTISTSORT`: the artists' sort-names, same order. */
export function artistSortNames(credit: readonly MbArtistCreditEntry[] | undefined): string[] {
  return creditedEntries(credit)
    .map((entry) => entry.artist?.["sort-name"] ?? "")
    .filter((name) => name !== "");
}

/** `MUSICBRAINZ_ARTISTID`: the artists' MBIDs, same order as `ARTISTS`. */
export function artistIds(credit: readonly MbArtistCreditEntry[] | undefined): string[] {
  return creditedEntries(credit)
    .map((entry) => entry.artist?.id ?? "")
    .filter((id) => id !== "");
}

/**
 * The top `limit` genres by vote count, ties broken alphabetically so the result is stable
 * across re-resolutions of the same cached response.
 */
export function topGenres(genres: readonly MbGenre[] | undefined, limit = 3): string[] {
  return [...(genres ?? [])]
    .filter((genre) => genre.name !== undefined && genre.name !== "")
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""))
    .slice(0, limit)
    .map((genre) => genre.name ?? "");
}
