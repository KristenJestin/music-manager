/**
 * `discography.service` — palier 1 of `docs/05-recommandations.md`: what is missing.
 *
 * "Tu as trois albums de Daft Punk sur six." This is the tier with **no external dependency**
 * beyond MusicBrainz, which is why it is the one that always works: it needs no ListenBrainz
 * account, no Last.fm key and no collaborative filtering — just the artists you actually play
 * (`signals.service`) and the release-groups MusicBrainz credits them with.
 *
 * The comparison is by **release-group MBID**, and that is the whole reason this is feasible:
 * `docs/05` opens by saying the library is entirely identified by MBID, so "do I own this?" is
 * a set membership test rather than a string match. Titles are used only as a *secondary*
 * check, for albums imported before an MBID was known — and when a title matches but the MBID
 * does not, the album is treated as owned, because proposing something you already have is a
 * worse failure than missing one.
 *
 * Everything MusicBrainz answers goes through `browseReleaseGroupsByArtist`, which is P04's
 * cached, rate-limited client: a second sync on the same day costs no requests at all.
 */
import { normalizeTitle, type MbReleaseGroup } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { libraryAlbums } from "#/server/db/schema/index.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import { browseReleaseGroupsByArtist } from "#/server/integrations/musicbrainz.ts";
import type { ArtistSignal } from "#/server/services/signals.ts";
import type { Settings } from "#/server/services/settings.ts";

/** One release-group the library does not have. */
export interface MissingReleaseGroup {
  readonly rgMbid: string;
  readonly title: string;
  readonly year: number | null;
  readonly primaryType: string;
  readonly secondaryTypes: readonly string[];
  readonly firstReleaseDate: string | null;
}

/** One artist's shelf, and the holes in it. */
export interface DiscographyGap {
  readonly artist: string;
  readonly artistMbid: string;
  readonly plays: number;
  /** Release-groups of the accepted types that the library has. */
  readonly have: number;
  /** Release-groups of the accepted types MusicBrainz knows about. */
  readonly total: number;
  readonly missing: readonly MissingReleaseGroup[];
}

/** Which types count, and which secondary types are excluded. Straight from the settings. */
export interface GapFilters {
  readonly includeTypes: readonly string[];
  readonly excludeLive: boolean;
  readonly excludeCompilations: boolean;
}

export function filtersOf(settings: Settings): GapFilters {
  return {
    includeTypes: settings.discoverIncludeTypes,
    excludeLive: settings.discoverExcludeLive,
    excludeCompilations: settings.discoverExcludeCompilations,
  };
}

/** A release-group is a candidate when its primary type is wanted and no secondary type is barred. */
export function accepts(group: MbReleaseGroup, filters: GapFilters): boolean {
  const primary = group["primary-type"] ?? "";
  if (!filters.includeTypes.includes(primary)) return false;
  const secondary = (group["secondary-types"] ?? []).map((type) => type.toLowerCase());
  if (filters.excludeLive && secondary.includes("live")) return false;
  if (filters.excludeCompilations && secondary.includes("compilation")) return false;
  return true;
}

/**
 * Titles are compared folded, not raw — with **the matcher's own normaliser**.
 *
 * `Audio, Video, Disco.` and `Audio Video Disco` are the same record, and an apostrophe that
 * differs by codepoint is not a reason to propose an album twice. Reusing `normalizeTitle`
 * rather than writing a second folder matters: if Discover folded titles differently from the
 * matcher, the page could claim you are missing a record the wizard would refuse to import as
 * a duplicate.
 */
export function foldTitle(title: string): string {
  return normalizeTitle(title);
}

function yearOf(group: MbReleaseGroup): number | null {
  const date = group["first-release-date"] ?? "";
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) && year > 0 ? year : null;
}

export interface OwnedShelf {
  /** Release-group MBIDs of this artist already in `library_albums`. */
  readonly rgMbids: ReadonlySet<string>;
  /** Folded titles of this artist's albums, for rows that predate a known MBID. */
  readonly titles: ReadonlySet<string>;
}

/**
 * The gap computation, as a pure function.
 *
 * Split out from the fetching so it can be proven exhaustively — the filters, the two
 * ownership tests, the dismissal memory and the `have`/`total` arithmetic — without a network
 * or a database anywhere near it (`discography.test.ts`).
 */
export function computeGaps(
  groups: readonly MbReleaseGroup[],
  owned: OwnedShelf,
  filters: GapFilters,
  dismissed: ReadonlySet<string> = new Set(),
): { have: number; total: number; missing: MissingReleaseGroup[] } {
  const candidates = groups.filter((group) => group.id !== undefined && accepts(group, filters));
  // MusicBrainz can list the same release-group twice across pages; the id is the identity.
  const unique = new Map<string, MbReleaseGroup>();
  for (const group of candidates) unique.set(group.id as string, group);

  const missing: MissingReleaseGroup[] = [];
  let have = 0;
  for (const group of unique.values()) {
    const id = group.id as string;
    const title = group.title ?? "";
    const isOwned = owned.rgMbids.has(id) || owned.titles.has(foldTitle(title));
    if (isOwned) {
      have += 1;
      continue;
    }
    // Dismissed items still count towards `total`: hiding a proposal must not rewrite the
    // arithmetic of the shelf, or "you have 2 of 6" would silently become "2 of 5".
    if (dismissed.has(`release-group:${id}`)) continue;
    missing.push({
      rgMbid: id,
      title,
      year: yearOf(group),
      primaryType: group["primary-type"] ?? "Other",
      secondaryTypes: [...(group["secondary-types"] ?? [])],
      firstReleaseDate: group["first-release-date"] ?? null,
    });
  }

  missing.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));
  return { have, total: unique.size, missing };
}

const EMPTY_SHELF: OwnedShelf = { rgMbids: new Set(), titles: new Set() };

/**
 * What the library holds, per artist, in one query.
 *
 * One query for the whole library rather than one per artist: eight artists is eight round
 * trips for a table that fits in memory, and the map is read again by the recommender.
 */
export async function shelves(db: Database): Promise<ReadonlyMap<string, OwnedShelf>> {
  const owned = await db
    .select({
      rg: libraryAlbums.releaseGroupMbid,
      title: libraryAlbums.title,
      artist: libraryAlbums.albumArtist,
    })
    .from(libraryAlbums);

  const map = new Map<string, { rgMbids: Set<string>; titles: Set<string> }>();
  for (const row of owned) {
    const key = row.artist.toLowerCase();
    const entry = map.get(key) ?? { rgMbids: new Set<string>(), titles: new Set<string>() };
    if (row.rg !== null && row.rg !== "") entry.rgMbids.add(row.rg);
    entry.titles.add(foldTitle(row.title));
    map.set(key, entry);
  }
  return map;
}

export interface GapsOptions {
  readonly ctx: SourceContext;
  readonly artists: readonly ArtistSignal[];
  readonly settings: Settings;
  readonly db?: Database;
  readonly dismissed?: ReadonlySet<string>;
  /** How many artists to ask MusicBrainz about. Defaults to `discoverTopArtists`. */
  readonly limit?: number;
}

/**
 * For the most-played artists, the release-groups the library is missing.
 *
 * An artist with no MBID is skipped rather than searched for by name: MusicBrainz name search
 * is ambiguous exactly where it matters (two bands, one name), and a discography attributed to
 * the wrong artist would be a page full of confident nonsense.
 */
export async function discographyGaps(options: GapsOptions): Promise<readonly DiscographyGap[]> {
  const db = options.db ?? defaultDb();
  const filters = filtersOf(options.settings);
  const dismissed = options.dismissed ?? new Set<string>();
  const limit = options.limit ?? options.settings.discoverTopArtists;
  const shelf = await shelves(db);

  const out: DiscographyGap[] = [];
  for (const artist of options.artists.slice(0, limit)) {
    if (artist.mbid === null) continue;
    /*
     * One artist's failure is not the block's failure.
     *
     * Offline (`MM_FIXTURES=1`, `mm doc rebuild --offline`) an artist nobody has ever browsed
     * is a cache miss, which `cached` reports as an error — correctly, since the alternative
     * is a silent request. Here it simply means "no data for this one": the seven artists that
     * *are* cached still produce their gaps, which is the difference between a partial page
     * and no page.
     */
    let groups: readonly MbReleaseGroup[] = [];
    try {
      const answer = await browseReleaseGroupsByArtist(options.ctx, artist.mbid, { limit: 100 });
      groups = answer.data?.["release-groups"] ?? [];
    } catch {
      continue;
    }
    if (groups.length === 0) continue;

    const owned = shelf.get(artist.name.toLowerCase()) ?? EMPTY_SHELF;
    const gap = computeGaps(groups, owned, filters, dismissed);
    if (gap.missing.length === 0) continue;
    out.push({
      artist: artist.name,
      artistMbid: artist.mbid,
      plays: artist.plays,
      have: gap.have,
      total: gap.total,
      missing: gap.missing,
    });
  }

  // The fullest shelves first: an artist you play a lot and own half of is the best suggestion
  // this page can make, and it is also the one you are most likely to act on.
  out.sort((a, b) => b.plays - a.plays || b.missing.length - a.missing.length);
  return out;
}

/** The sentence shown under a gap. Plain English, no jargon, no score. */
export function gapReason(gap: DiscographyGap, windowDays: number): string {
  const window = windowDays === 30 ? "this month" : `in the last ${String(windowDays)} days`;
  return `you have ${String(gap.have)} of ${String(gap.total)} — played ${String(gap.plays)}× ${window}`;
}
