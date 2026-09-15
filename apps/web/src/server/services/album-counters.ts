/**
 * The one rule for `library_albums.track_count` and `library_albums.present_count`.
 *
 * Those two columns are a *fraction*: "how many of this release's tracks do we hold". They
 * were written from five places under four different definitions, and one of them —
 * `migration/v1/execute.ts` — set both to the number of files it had just migrated. An album
 * holding track 4 of a thirteen-track record therefore said `1/1`, rendered green, scored 97%
 * and never appeared under the "incomplete" filter; a whole library reported itself complete
 * because the denominator was copied from the numerator. A truthful-looking `1/1` is worse
 * than no number at all, so the fix is not a better formula in one file: it is one formula, in
 * this file, that every writer of the pair goes through.
 *
 * ## Where the denominator comes from, in order
 *
 *  1. **the release** — the MusicBrainz release payload already in `source_cache`, summed over
 *     its media (`trackTotal`). The only rung that is a fact. A multi-disc release is the sum
 *     of its media and never one medium's `track-count`;
 *  2. **the tags** — `totaltracks` and `totaldiscs` as the album's own documents agree on them,
 *     per disc, which is what a v1 row or an untagged import still carries;
 *  3. **the rows** — what we hold, which is not a total at all. It is recorded as such in
 *     `track_count_source`, so nothing downstream can mistake "we counted our own files" for
 *     "the release has this many tracks".
 *
 * Every rung is read out of the database. Nothing here can reach the network: the migration's
 * re-tag, `mm doc rebuild --offline` and `mm scan` all run through it.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { trackTotal, type MbRelease } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  sourceCache,
} from "#/server/db/schema/index.ts";

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * Where `track_count` came from, strongest first.
 *
 * `rows` is the one that means "unknown": the number is our own file count wearing a total's
 * clothes, and the Console renders it as `n/?` rather than `n/n`.
 */
export const ALBUM_TOTAL_SOURCES = ["release", "tags", "rows"] as const;
export type AlbumTotalSource = (typeof ALBUM_TOTAL_SOURCES)[number];

export function isAlbumTotalSource(value: string): value is AlbumTotalSource {
  return (ALBUM_TOTAL_SOURCES as readonly string[]).includes(value);
}

/** True when `track_count` is a real total, so `n/m` may be printed as a verified fraction. */
export function totalIsKnown(source: string | null | undefined): boolean {
  return source === "release" || source === "tags";
}

export interface AlbumCounters {
  readonly trackCount: number;
  readonly presentCount: number;
  readonly trackCountSource: AlbumTotalSource;
}

/* ------------------------------------------------------------------ */
/* the pure rule                                                       */
/* ------------------------------------------------------------------ */

/** What one track's document says about the shape of the release it belongs to. */
export interface DocumentTotals {
  readonly discNumber: number | null;
  readonly totalTracks: number | null;
  readonly totalDiscs: number | null;
}

export interface CounterInput {
  /** Tracks of this album whose file is really there. */
  readonly present: number;
  /** Rows we hold for the album, present or not. The total is never smaller than this. */
  readonly known?: number;
  /** Rung 1, already summed over the release's media. */
  readonly releaseTotal?: number | null;
  /** Rung 2, already summed over the discs. */
  readonly documentTotal?: number | null;
}

/**
 * The rule itself — pure, so the ladder is testable without a database.
 *
 * `known` is a floor and not a rung: a release that says thirteen while fourteen rows sit on
 * the album is a disagreement, and the honest reading of it is fourteen. Without the floor the
 * pair breaks its own invariant and the Console renders `14/13`.
 */
export function albumCounters(input: CounterInput): AlbumCounters {
  const present = Math.max(0, Math.trunc(input.present));
  const floor = Math.max(present, Math.max(0, Math.trunc(input.known ?? 0)));

  const release = positive(input.releaseTotal);
  if (release !== null) {
    return {
      presentCount: present,
      trackCount: Math.max(release, floor),
      trackCountSource: "release",
    };
  }

  const documents = positive(input.documentTotal);
  if (documents !== null) {
    return {
      presentCount: present,
      trackCount: Math.max(documents, floor),
      trackCountSource: "tags",
    };
  }

  return { presentCount: present, trackCount: floor, trackCountSource: "rows" };
}

/** Rung 1: the release's own tracklist, summed over every medium. `null` when it has none. */
export function totalFromRelease(release: MbRelease | null | undefined): number | null {
  if (release === null || release === undefined) return null;
  return positive(trackTotal(release));
}

/**
 * Rung 2: `totaltracks` × `totaldiscs`, except that a two-disc release whose discs hold
 * thirteen and twelve tracks has twenty-five of them and not twenty-six.
 *
 * So the discs are summed rather than multiplied: each disc contributes what the documents of
 * *that* disc agree on, and a disc no document was seen for contributes what the album as a
 * whole agrees on — which collapses back to `totaltracks × totaldiscs` in the ordinary case
 * where every medium is the same length.
 */
export function totalFromDocuments(entries: readonly DocumentTotals[]): number | null {
  if (entries.length === 0) return null;
  const overall = commonest(entries.map((entry) => entry.totalTracks));
  if (overall === null) return null;

  const discs = commonest(entries.map((entry) => entry.totalDiscs)) ?? 1;
  // A `totaldiscs` this large is a misread tag, not a box set; trust the tracks instead.
  if (discs > MAX_DISCS) return null;

  let sum = 0;
  for (let disc = 1; disc <= discs; disc += 1) {
    const here = commonest(
      entries.filter((entry) => (entry.discNumber ?? 1) === disc).map((entry) => entry.totalTracks),
    );
    sum += here ?? overall;
  }
  return positive(sum);
}

const MAX_DISCS = 50;

function positive(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.trunc(value);
}

/**
 * The value most of them agree on, `null` when none of them has one.
 *
 * Ties go to the smallest value, so two runs over one album never answer differently whatever
 * order the rows came back in.
 */
function commonest(values: readonly (number | null)[]): number | null {
  const counts = new Map<number, number>();
  for (const value of values) {
    const held = positive(value);
    if (held === null) continue;
    counts.set(held, (counts.get(held) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* reading the rungs out of the database, offline                      */
/* ------------------------------------------------------------------ */

/** The `source_cache` key `documents.build` stored the release under. */
function releaseCacheKey(mbid: string): string {
  return `release/${mbid}?inc=releaseFull`;
}

/** Release MBID → its track total, for the releases this installation has already fetched. */
export async function cachedReleaseTotals(
  db: Database,
  mbids: readonly string[],
): Promise<Map<string, number>> {
  const wanted = [...new Set(mbids.filter((mbid) => mbid !== ""))];
  const out = new Map<string, number>();
  if (wanted.length === 0) return out;

  const byKey = new Map(wanted.map((mbid) => [releaseCacheKey(mbid), mbid]));
  const rows = await db
    .select({ key: sourceCache.key, payload: sourceCache.payload })
    .from(sourceCache)
    .where(and(eq(sourceCache.source, "musicbrainz"), inArray(sourceCache.key, [...byKey.keys()])));

  for (const row of rows) {
    const mbid = byKey.get(row.key);
    if (mbid === undefined) continue;
    // An "absent" marker parses as a release with no media, which `trackTotal` reads as 0.
    const total = totalFromRelease(row.payload as unknown as MbRelease);
    if (total !== null) out.set(mbid, total);
  }
  return out;
}

/** `totaltracks` / `totaldiscs` off a stored `TrackDocument`, in whatever shape it was saved. */
export function documentTotalsOf(
  document: Record<string, unknown> | null | undefined,
  discNumber: number | null = null,
): DocumentTotals {
  const fields = (document?.["fields"] ?? {}) as Record<string, { value?: unknown } | undefined>;
  return {
    discNumber: discNumber ?? numberOf(fields["discnumber"]?.value),
    totalTracks:
      numberOf(fields["totaltracks"]?.value) ?? numberOf(fields["totaltracks_alias"]?.value),
    totalDiscs:
      numberOf(fields["totaldiscs"]?.value) ?? numberOf(fields["totaldiscs_alias"]?.value),
  };
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return positive(value);
  if (typeof value === "string") {
    // `4/13` is a legal ID3 spelling; the total is on the right of the slash.
    const half = value.includes("/") ? (value.split("/")[1] ?? value) : value;
    const parsed = Number.parseInt(half, 10);
    return Number.isFinite(parsed) ? positive(parsed) : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* the recount                                                         */
/* ------------------------------------------------------------------ */

export interface RecountOptions {
  /**
   * Library-relative paths the caller has just seen on disk.
   *
   * Supplied, `present_count` is a fact about the filesystem — which is what `mm scan` knows
   * and nothing else does. Omitted, it counts the rows that carry no `missing_at`, which is
   * what the last scan established rather than a fresh guess.
   */
  readonly onDisk?: ReadonlySet<string>;
  /** Recount these albums only. Omitted, the whole library. */
  readonly albumIds?: readonly string[];
}

export interface RecountResult {
  readonly albums: number;
  readonly changed: number;
}

/** One album's counters as they should be, next to what the row currently says. */
export interface PlannedCounters extends AlbumCounters {
  readonly albumId: string;
  readonly releaseMbid: string | null;
  readonly wasTrackCount: number;
  readonly wasPresentCount: number;
  readonly wasSource: string;
}

/** True when the row disagrees with the rule and a write is owed. */
export function countersDiffer(planned: PlannedCounters): boolean {
  return (
    planned.trackCount !== planned.wasTrackCount ||
    planned.presentCount !== planned.wasPresentCount ||
    planned.trackCountSource !== planned.wasSource
  );
}

/**
 * What the counters *should* be, for every album in scope — computed, never written.
 *
 * Four queries whatever the size of the library, because `mm scan` calls this over six hundred
 * albums and a per-album round trip would be two thousand of them.
 */
export async function plannedCounters(
  db: Database,
  options: RecountOptions = {},
): Promise<readonly PlannedCounters[]> {
  const scope = options.albumIds;
  if (scope !== undefined && scope.length === 0) return [];

  const albums = await db
    .select({
      id: libraryAlbums.id,
      releaseMbid: libraryAlbums.releaseMbid,
      trackCount: libraryAlbums.trackCount,
      presentCount: libraryAlbums.presentCount,
      trackCountSource: libraryAlbums.trackCountSource,
    })
    .from(libraryAlbums)
    .where(scope === undefined ? undefined : inArray(libraryAlbums.id, [...scope]));
  if (albums.length === 0) return [];

  const tracks = await db
    .select({
      id: libraryTracks.id,
      albumId: libraryTracks.albumId,
      path: libraryTracks.path,
      discNumber: libraryTracks.discNumber,
      missingAt: libraryTracks.missingAt,
    })
    .from(libraryTracks)
    .where(
      inArray(
        libraryTracks.albumId,
        albums.map((album) => album.id),
      ),
    );

  const documents =
    tracks.length === 0
      ? []
      : await db
          .select({
            libraryTrackId: metadataDocuments.libraryTrackId,
            document: metadataDocuments.document,
          })
          .from(metadataDocuments)
          .where(
            and(
              isNotNull(metadataDocuments.libraryTrackId),
              inArray(
                metadataDocuments.libraryTrackId,
                tracks.map((track) => track.id),
              ),
            ),
          );
  const documentByTrack = new Map(
    documents.flatMap((row) =>
      row.libraryTrackId === null ? [] : [[row.libraryTrackId, row.document] as const],
    ),
  );

  const releaseTotals = await cachedReleaseTotals(
    db,
    albums.flatMap((album) => (album.releaseMbid === null ? [] : [album.releaseMbid])),
  );

  const held = new Map<string, { present: number; known: number; totals: DocumentTotals[] }>();
  for (const album of albums) held.set(album.id, { present: 0, known: 0, totals: [] });
  for (const track of tracks) {
    if (track.albumId === null) continue;
    const bucket = held.get(track.albumId);
    if (bucket === undefined) continue;
    bucket.known += 1;
    const onDisk =
      options.onDisk === undefined ? track.missingAt === null : options.onDisk.has(track.path);
    if (onDisk) bucket.present += 1;
    const document = documentByTrack.get(track.id);
    if (document !== undefined) bucket.totals.push(documentTotalsOf(document, track.discNumber));
  }

  return albums.map((album) => {
    const bucket = held.get(album.id) ?? { present: 0, known: 0, totals: [] };
    const counters = albumCounters({
      present: bucket.present,
      known: bucket.known,
      releaseTotal:
        album.releaseMbid === null ? null : (releaseTotals.get(album.releaseMbid) ?? null),
      documentTotal: totalFromDocuments(bucket.totals),
    });
    return {
      albumId: album.id,
      releaseMbid: album.releaseMbid,
      ...counters,
      wasTrackCount: album.trackCount,
      wasPresentCount: album.presentCount,
      wasSource: album.trackCountSource,
    };
  });
}

/**
 * Recompute and store the pair for every album in scope.
 *
 * Offline, and safe to run twice: a row whose three values already agree is not written, so a
 * second run reports zero changes. That is what makes it usable as a backfill — `mm scan` runs
 * it on every walk and says how many albums it corrected.
 */
export async function recountAlbums(
  db: Database = defaultDb(),
  options: RecountOptions = {},
): Promise<RecountResult> {
  const planned = await plannedCounters(db, options);
  const owed = planned.filter(countersDiffer);
  const now = new Date();

  for (const album of owed) {
    await db
      .update(libraryAlbums)
      .set({
        trackCount: album.trackCount,
        presentCount: album.presentCount,
        trackCountSource: album.trackCountSource,
        updatedAt: now,
      })
      .where(eq(libraryAlbums.id, album.albumId));
  }

  return { albums: planned.length, changed: owed.length };
}

/** The same rule for one album — what every writer of the pair calls once it has written rows. */
export async function recountAlbum(
  albumId: string,
  db: Database = defaultDb(),
  options: Omit<RecountOptions, "albumIds"> = {},
): Promise<AlbumCounters> {
  const counters = await countersFor(albumId, db, options);
  await recountAlbums(db, { ...options, albumIds: [albumId] });
  return counters;
}

/**
 * The counters one album *would* get, without writing them.
 *
 * `migration/v1`'s `upsertAlbum` needs this shape: it writes the album row in one statement
 * with half a dozen other columns, and a second UPDATE for the pair would be a second rule.
 */
export async function countersFor(
  albumId: string,
  db: Database = defaultDb(),
  options: Omit<RecountOptions, "albumIds"> = {},
): Promise<AlbumCounters> {
  const [planned] = await plannedCounters(db, { ...options, albumIds: [albumId] });
  if (planned === undefined) return { trackCount: 0, presentCount: 0, trackCountSource: "rows" };
  return {
    trackCount: planned.trackCount,
    presentCount: planned.presentCount,
    trackCountSource: planned.trackCountSource,
  };
}
