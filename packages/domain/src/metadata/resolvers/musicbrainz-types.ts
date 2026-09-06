/**
 * The subset of the MusicBrainz WS/2 JSON we actually read.
 *
 * These are structural descriptions, not validators: parsing happens at the network boundary
 * in P04 with zod, and the raw cache keeps the full response for ever (§8). Everything here
 * is optional, because MusicBrainz omits what it does not have and the `inc=` list decides
 * the rest.
 */

export interface MbArtist {
  readonly id?: string;
  readonly name?: string;
  readonly "sort-name"?: string;
  readonly disambiguation?: string;
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
  readonly "catalog-number"?: string;
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
}

export interface MbRelease {
  readonly id?: string;
  readonly title?: string;
  readonly disambiguation?: string;
  readonly date?: string;
  readonly country?: string;
  readonly status?: string;
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
}

/** `ARTIST` is the credit rebuilt with MusicBrainz's own join phrases (§2.1). */
export function joinArtistCredit(
  credit: readonly MbArtistCreditEntry[] | undefined,
): string | null {
  if (credit === undefined || credit.length === 0) return null;
  const joined = credit
    .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
    .join("");
  return joined === "" ? null : joined;
}

/** `ARTISTS`: one entry per credited artist, as credited, in credit order. */
export function artistNames(credit: readonly MbArtistCreditEntry[] | undefined): string[] {
  return (credit ?? [])
    .map((entry) => entry.name ?? entry.artist?.name ?? "")
    .filter((name) => name !== "");
}

/** `ARTISTSORT`: the artists' sort-names, same order. */
export function artistSortNames(credit: readonly MbArtistCreditEntry[] | undefined): string[] {
  return (credit ?? [])
    .map((entry) => entry.artist?.["sort-name"] ?? "")
    .filter((name) => name !== "");
}

/** `MUSICBRAINZ_ARTISTID`: the artists' MBIDs, same order as `ARTISTS`. */
export function artistIds(credit: readonly MbArtistCreditEntry[] | undefined): string[] {
  return (credit ?? []).map((entry) => entry.artist?.id ?? "").filter((id) => id !== "");
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
