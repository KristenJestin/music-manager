/**
 * What ⌘K can answer.
 *
 * The Console's front door used to be a text field in the top bar that did exactly one thing:
 * a YouTube URL, Enter, the wizard. Everything else a person has in the clipboard — a
 * MusicBrainz link from the page they were just reading, an album name, an artist — had no
 * door at all. The palette is the door now, and this module is the three answers behind it.
 *
 * They are deliberately three, because they cost three different things:
 *
 *  - **the library** (`searchLibrary`) is local SQL. It runs on a 150 ms debounce as you type,
 *    because it can: no socket, no gate, no budget;
 *  - **an identifier** (`paletteRef`) is one MusicBrainz lookup, on a longer debounce. It is
 *    the only network call the palette makes without being asked, and it is worth it — the
 *    whole point of `mb-resolve.ts` is that looking an id up *before* refusing is what turns
 *    "that id is wrong" into "that is a release, here is what I can do with it";
 *  - **MusicBrainz in words** (`searchMusicBrainz`) is one request per second, installation
 *    wide, shared with the worker. It is never run from a keystroke. The palette offers it as
 *    a row you have to press, and says so on the row.
 *
 * Nothing here talks to MusicBrainz except through `integrations/musicbrainz.ts`, which owns
 * the limiter and the cache. There is no second door onto that source and there must not be.
 */
import { and, asc, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { lucene, MB_ENTITY_NOUN, type MbEntityName, type MbRelease } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { artistsCache, libraryAlbums, libraryTracks } from "#/server/db/schema/index.ts";
import { search as mbSearch } from "#/server/integrations/musicbrainz.ts";
import { serverEnv } from "#/server/env.ts";
import {
  albumSearchCondition,
  likeLiteral,
  trackSearchCondition,
} from "#/server/services/library-filter.sql.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import { directLookups, identifyMbRef } from "#/server/services/mb-resolve.ts";

/* ------------------------------------------------------------------ */
/* the library, locally                                                */
/* ------------------------------------------------------------------ */

/** One row of the palette's "In your library" group, with the page it leads to. */
export interface LibraryHit {
  readonly kind: "album" | "artist" | "track";
  /** The `$id` of its route — for an artist, the MBID when there is one and the name when not. */
  readonly id: string;
  readonly title: string;
  /** The second line: the artist, the album, the counts. `null` when there is nothing to add. */
  readonly subtitle: string | null;
}

export interface LibraryHits {
  /** Echoed back so a "nothing found" can name what was actually searched for. */
  readonly query: string;
  readonly albums: readonly LibraryHit[];
  readonly artists: readonly LibraryHit[];
  readonly tracks: readonly LibraryHit[];
}

/** How many of each kind the palette shows. Three lists of five is already a full screen. */
const PER_KIND = 5;

/**
 * Albums, artists and tracks whose text matches, in three small queries.
 *
 * **Not** `albumGrid`, `artistList` and `trackList`, and the reason is what the palette is for.
 * Those three answer a *page*: `albumGrid` scores every album in the library through
 * `scoreLibrary` so the cards can carry a quality badge, `trackList` counts five chips over the
 * whole track table and reads the documents of the page it returns. All of that is right for
 * `/library` and all of it is paid on every keystroke here.
 *
 * What is reused is the part that actually encodes a decision: `albumSearchCondition` and
 * `trackSearchCondition`, the same `where` the library pages search with — so a word that finds
 * an album in the palette finds it on the page too, including by MBID, which is what makes a
 * pasted release id turn up its own album for free.
 */
export async function searchLibrary(
  query: string,
  options: { readonly db?: Database; readonly limit?: number } = {},
): Promise<LibraryHits> {
  const db = options.db ?? defaultDb();
  const limit = options.limit ?? PER_KIND;
  const needle = query.trim();
  if (needle === "") return { query: needle, albums: [], artists: [], tracks: [] };

  const albumWhere = albumSearchCondition(needle);
  const trackWhere = trackSearchCondition(needle);

  const [albums, artists, tracks] = await Promise.all([
    db
      .select({
        id: libraryAlbums.id,
        title: libraryAlbums.title,
        artist: libraryAlbums.albumArtist,
        year: libraryAlbums.year,
        present: libraryAlbums.presentCount,
        total: libraryAlbums.trackCount,
      })
      .from(libraryAlbums)
      .where(albumWhere)
      .orderBy(asc(libraryAlbums.title))
      .limit(limit),
    /*
     * The artists of the library are `library_albums.album_artist` grouped, exactly as
     * `artistList` has it — the folders are named after that string, so a palette that
     * offered anything else would be offering a page that does not exist. The MBID comes
     * along because `/library/artists/$id` prefers it: it is the half of the pair that
     * survives the artist being renamed.
     */
    db
      .select({
        name: libraryAlbums.albumArtist,
        albums: sql<number>`count(distinct ${libraryAlbums.id})::int`,
        /*
         * A correlated scalar subquery, not a join, for the reason `artistList` gives: the
         * cache is keyed by MBID and matched by name, so two rows can spell the same artist
         * and a join would double the group. `order by` makes the choice deterministic.
         */
        mbid: sql<string | null>`(select ${artistsCache.artistMbid} from ${artistsCache}
          where lower(${artistsCache.name}) = lower(${libraryAlbums.albumArtist})
          order by ${artistsCache.artistMbid} limit 1)`,
      })
      .from(libraryAlbums)
      .where(ilike(libraryAlbums.albumArtist, `%${likeLiteral(needle)}%`))
      .groupBy(libraryAlbums.albumArtist)
      .orderBy(asc(libraryAlbums.albumArtist))
      .limit(limit),
    db
      .select({
        id: libraryTracks.id,
        title: libraryTracks.title,
        artist: libraryTracks.artist,
        album: libraryAlbums.title,
      })
      .from(libraryTracks)
      .leftJoin(libraryAlbums, eq(libraryAlbums.id, libraryTracks.albumId))
      .where(trackWhere)
      .orderBy(asc(libraryTracks.title))
      .limit(limit),
  ]);

  return {
    query: needle,
    albums: albums.map((row) => ({
      kind: "album" as const,
      id: row.id,
      title: row.title,
      subtitle: [row.artist, row.year === null ? null : String(row.year), `${String(row.present)}/${String(row.total)} tracks`]
        .filter((part): part is string => part !== null)
        .join(" · "),
    })),
    artists: artists.map((row) => ({
      kind: "artist" as const,
      id: row.mbid ?? row.name,
      title: row.name,
      subtitle: `${String(row.albums)} album${row.albums === 1 ? "" : "s"}`,
    })),
    tracks: tracks.map((row) => ({
      kind: "track" as const,
      id: row.id,
      title: row.title,
      subtitle: [row.artist, row.album].filter((part): part is string => part !== null).join(" · "),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* an identifier                                                       */
/* ------------------------------------------------------------------ */

/** What the palette will do with an identified reference. */
export type PaletteRefAction =
  | "pin-release"
  | "pin-group"
  | "match-recording"
  | "browse-artist"
  | "none";

export interface PaletteRef {
  readonly mbid: string;
  /** What MusicBrainz says it is. `null` when none of the five lookups knows the id. */
  readonly entity: MbEntityName | null;
  /** The entity as a noun, for a sentence: "That is a **release group**." */
  readonly noun: string | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly year: number | null;
  readonly trackCount: number | null;
  readonly disambiguation: string | null;
  readonly action: PaletteRefAction;
  /** What the row says it will do. Always an action, never a noun. */
  readonly actionLabel: string;
  /** One sentence under the row: why this is what happens. */
  readonly explanation: string;
  /**
   * The release to pin, when it is already known.
   *
   * `null` for a release group: finding which of its editions to pin is a second gated
   * request, and it is made when the row is pressed rather than while somebody is typing.
   */
  readonly targetMbid: string | null;
  /** What to search the library with — a recording's title, an artist's name. */
  readonly searchText: string | null;
}

/** The year of a `YYYY-MM-DD`, `YYYY-MM` or `YYYY` date. */
function yearOfDate(date: string | null | undefined): number | null {
  if (date === null || date === undefined || date === "") return null;
  const year = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

function credited(doc: { readonly "artist-credit"?: unknown }): string | null {
  const credits = doc["artist-credit"];
  if (!Array.isArray(credits)) return null;
  const name = credits
    .map((entry: { name?: string; artist?: { name?: string }; joinphrase?: string }) =>
      `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`,
    )
    .join("")
    .trim();
  return name === "" ? null : name;
}

/**
 * What did they paste, and what can ⌘K do with it?
 *
 * `null` means the string holds no MusicBrainz reference at all — the palette's signal that
 * this is free text and belongs in a search. Everything else comes back named, *including* the
 * entities this application cannot use: saying "that is a work, paste the recording instead"
 * is the whole reason the lookup happens before the refusal.
 *
 * `identifyMbRef` does the identifying; the affordances below are the palette's own. They are
 * not the wizard's, and that is the point of the split: the wizard asks "what does this id mean
 * for the import I am already looking at", and ⌘K asks "what should this id start".
 */
export async function paletteRef(
  input: string,
  options: { readonly db?: Database; readonly signal?: AbortSignal } = {},
): Promise<PaletteRef | null> {
  const db = options.db ?? defaultDb();
  const lookups = directLookups(db, options.signal, serverEnv().MM_FIXTURES);
  const identified = await identifyMbRef(input, { lookups });
  if (identified === null) return null;

  const { ref, found } = identified;
  if (found === null) {
    return {
      mbid: ref.mbid,
      entity: null,
      noun: null,
      title: null,
      artist: null,
      year: null,
      trackCount: null,
      disambiguation: null,
      action: "none",
      actionLabel: "Nothing to do with this id",
      explanation:
        ref.claimed === null
          ? "MusicBrainz does not know this id as a recording, a release, a release group, an artist or a work."
          : `MusicBrainz does not know a ${MB_ENTITY_NOUN[ref.claimed]} with this id.`,
      targetMbid: null,
      searchText: null,
    };
  }

  const base = {
    mbid: ref.mbid,
    entity: found.entity,
    noun: MB_ENTITY_NOUN[found.entity],
    year: null as number | null,
    trackCount: null as number | null,
    targetMbid: null as string | null,
    searchText: null as string | null,
  };

  if (found.entity === "release") {
    const tracks = countTracks(found.doc);
    return {
      ...base,
      title: found.doc.title ?? "unknown release",
      artist: credited(found.doc),
      year: yearOfDate(found.doc.date),
      trackCount: tracks,
      disambiguation: emptyToNull(found.doc.disambiguation),
      action: "pin-release",
      actionLabel: "Start an import pinned to this release",
      explanation: `A release with ${String(tracks)} track(s). The import you start will be matched against this tracklist and no other.`,
      targetMbid: ref.mbid,
      searchText: found.doc.title ?? null,
    };
  }

  if (found.entity === "release-group") {
    const extra = found.doc as { disambiguation?: string; "artist-credit"?: unknown };
    return {
      ...base,
      title: found.doc.title ?? "unknown release group",
      artist: credited(extra),
      year: yearOfDate(found.doc["first-release-date"]),
      trackCount: null,
      disambiguation: emptyToNull(extra.disambiguation),
      action: "pin-group",
      actionLabel: "Start an import pinned to this record",
      explanation:
        "A release group — one record, several editions. Its official edition is looked up when you press this, and the import is pinned to that.",
      targetMbid: null,
      searchText: found.doc.title ?? null,
    };
  }

  if (found.entity === "recording") {
    const seconds = found.doc.length === undefined ? null : Math.round(found.doc.length / 1000);
    return {
      ...base,
      title: found.doc.title ?? "unknown recording",
      artist: credited(found.doc),
      year: null,
      trackCount: null,
      disambiguation: emptyToNull(found.doc.disambiguation),
      action: "match-recording",
      actionLabel: "Show the tracks that match it",
      explanation: `A recording${seconds === null ? "" : ` of ${String(seconds)} s`}. Your library is searched for it — by id first, then by title.`,
      targetMbid: ref.mbid,
      searchText: found.doc.title ?? null,
    };
  }

  if (found.entity === "artist") {
    return {
      ...base,
      title: found.doc.name ?? "unknown artist",
      artist: null,
      disambiguation: emptyToNull(found.doc.disambiguation),
      action: "browse-artist",
      actionLabel: "Show their albums in your library",
      explanation: "An artist. Your library's artists are searched for that name.",
      searchText: found.doc.name ?? null,
    };
  }

  return {
    ...base,
    title: found.doc.title ?? "unknown work",
    artist: null,
    disambiguation: emptyToNull(found.doc.disambiguation),
    action: "none",
    actionLabel: "Nothing to do with a work",
    explanation:
      "That is a work — a composition, not a recording of one. Paste the recording, the release or the release group instead.",
  };
}

function emptyToNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}

function countTracks(release: MbRelease): number {
  return (release.media ?? []).reduce((total, medium) => total + (medium.tracks?.length ?? 0), 0);
}

/**
 * Which edition of a release group an import should be pinned to.
 *
 * `releaseGroupFull` does not carry the group's releases — widening that preset would drag
 * every edition of every record through the cache that `tag` shares — so the editions come
 * from the release search the matcher already uses for the same question,
 * `rgid:<id> AND status:Official`. Same query string, therefore the same cache entry.
 *
 * Behind a press, never a keystroke: it is a second request through the one-per-second gate.
 */
export async function pinnableReleaseOfGroup(
  groupMbid: string,
  options: { readonly db?: Database; readonly signal?: AbortSignal } = {},
): Promise<{ readonly releaseMbid: string; readonly title: string | null } | null> {
  const db = options.db ?? defaultDb();
  const ctx = await sourceContextFor(db, options.signal, serverEnv().MM_FIXTURES);
  const query = lucene.releaseQuery({ album: "", releaseGroupId: groupMbid });
  const found = await mbSearch(ctx, "release", query, { limit: 10 });
  const release = (found.data?.releases ?? []).find(
    (candidate) => typeof candidate.id === "string" && candidate.id !== "",
  );
  if (release?.id === undefined) return null;
  return { releaseMbid: release.id, title: release.title ?? null };
}

/* ------------------------------------------------------------------ */
/* MusicBrainz, in words, when asked                                   */
/* ------------------------------------------------------------------ */

export interface MbHit {
  readonly kind: "release-group" | "recording";
  readonly mbid: string;
  readonly title: string;
  readonly artist: string | null;
  readonly year: number | null;
  /** The disambiguation and the primary type, folded into one line. */
  readonly detail: string | null;
}

export interface MbHits {
  /** What was asked, in words, so an empty answer can read it back. */
  readonly query: string;
  /** The Lucene queries as they left, for the same reason. */
  readonly queries: readonly string[];
  readonly releaseGroups: readonly MbHit[];
  readonly recordings: readonly MbHit[];
}

/** How many of each MusicBrainz kind the palette shows. */
const MB_SHOWN = 6;

/**
 * Two searches — release groups, then recordings — and nothing else.
 *
 * Two requests, two seconds at the gate's pace, which is exactly why this is behind a row you
 * press. It is the *search*, not the matcher: nothing here is scored against an import,
 * because there is no import yet. What a hit leads to is a new import pinned to it, and the
 * scoring happens there, in the wizard, through the pipeline's own ranking.
 *
 * `splitSearchTerms` is not applied. The wizard splits `Artist - Title` because it is
 * searching *for a known album* and an artist folded into the title finds nothing; here the
 * person typed the string with no field in mind, so it goes into the title clause whole and
 * MusicBrainz's own relevance sorts it out. The queries travel back so an empty answer can
 * show what was asked.
 */
export async function searchMusicBrainz(
  query: string,
  options: { readonly db?: Database; readonly signal?: AbortSignal } = {},
): Promise<MbHits> {
  const db = options.db ?? defaultDb();
  const needle = query.trim();
  if (needle === "") return { query: needle, queries: [], releaseGroups: [], recordings: [] };

  const ctx = await sourceContextFor(db, options.signal, serverEnv().MM_FIXTURES);
  const groupQuery = lucene.releaseGroupQuery(needle, null);
  const recordingQuery = lucene.recordingQuery({ title: needle });

  const groups = await mbSearch(ctx, "release-group", groupQuery, { limit: MB_SHOWN });
  const recordings = await mbSearch(ctx, "recording", recordingQuery, { limit: MB_SHOWN });

  return {
    query: needle,
    queries: [groupQuery, recordingQuery],
    releaseGroups: (groups.data?.["release-groups"] ?? [])
      .filter((group) => typeof group.id === "string" && group.id !== "")
      .slice(0, MB_SHOWN)
      .map((group) => ({
        kind: "release-group" as const,
        mbid: group.id ?? "",
        title: group.title ?? "untitled",
        artist: credited(group as { "artist-credit"?: unknown }),
        year: yearOfDate(group["first-release-date"]),
        detail: detailOf(
          (group as { "primary-type"?: string })["primary-type"],
          (group as { disambiguation?: string }).disambiguation,
        ),
      })),
    recordings: (recordings.data?.recordings ?? [])
      .filter((recording) => typeof recording.id === "string" && recording.id !== "")
      .slice(0, MB_SHOWN)
      .map((recording) => ({
        kind: "recording" as const,
        mbid: recording.id ?? "",
        title: recording.title ?? "untitled",
        artist: credited(recording),
        year: null,
        detail: detailOf(
          recording.length === undefined
            ? undefined
            : `${String(Math.round(recording.length / 1000))} s`,
          recording.disambiguation,
        ),
      })),
  };
}

function detailOf(...parts: readonly (string | undefined)[]): string | null {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return kept.length === 0 ? null : kept.join(" · ");
}

/* ------------------------------------------------------------------ */
/* where a recording leads                                             */
/* ------------------------------------------------------------------ */

export interface RecordingTracks {
  /** The library tracks carrying that exact recording id. */
  readonly exact: readonly LibraryHit[];
  /** Tracks whose title matches, when the id itself is nowhere in the library. */
  readonly byTitle: readonly LibraryHit[];
}

/**
 * The tracks that match a recording: by id first, by title second.
 *
 * By id is the answer when the library has been tagged — `library_tracks.recording_mbid` is
 * written by `place` and is the same id MusicBrainz was asked about. By title is the answer
 * for everything imported before it was, which in a real library is most of it, and saying
 * which of the two produced a row is what stops the second looking like the first.
 */
export async function tracksMatchingRecording(
  recordingMbid: string,
  title: string | null,
  options: { readonly db?: Database; readonly limit?: number } = {},
): Promise<RecordingTracks> {
  const db = options.db ?? defaultDb();
  const limit = options.limit ?? PER_KIND;

  const rows = await db
    .select({
      id: libraryTracks.id,
      title: libraryTracks.title,
      artist: libraryTracks.artist,
      album: libraryAlbums.title,
      exact: sql<boolean>`${libraryTracks.recordingMbid} = ${recordingMbid}`,
    })
    .from(libraryTracks)
    .leftJoin(libraryAlbums, eq(libraryAlbums.id, libraryTracks.albumId))
    .where(
      or(
        eq(libraryTracks.recordingMbid, recordingMbid),
        title === null || title === ""
          ? and(isNotNull(libraryTracks.recordingMbid), sql`false`)
          : ilike(libraryTracks.title, `%${likeLiteral(title)}%`),
      ),
    )
    .orderBy(desc(sql`${libraryTracks.recordingMbid} = ${recordingMbid}`), asc(libraryTracks.title))
    .limit(limit * 2);

  const hit = (row: (typeof rows)[number]): LibraryHit => ({
    kind: "track",
    id: row.id,
    title: row.title,
    subtitle: [row.artist, row.album].filter((part): part is string => part !== null).join(" · "),
  });

  return {
    exact: rows.filter((row) => row.exact).slice(0, limit).map(hit),
    byTitle: rows.filter((row) => !row.exact).slice(0, limit).map(hit),
  };
}
