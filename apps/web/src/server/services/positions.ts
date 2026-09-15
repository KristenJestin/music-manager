/**
 * `positions` — which slot a track takes inside its album, decided in exactly one place.
 *
 * `library_tracks_album_position_idx` is unique over
 * `(album_id, coalesce(disc_number, 1), track_number)`, so a position is not a cosmetic
 * detail: hand out one that is already held and Postgres *rejects the row*. The track then
 * either vanishes from the run (the migration counts it as a track failure) or takes the whole
 * command down with it (`mm library repair-orphans` did exactly that, on the fourth of nine
 * files, and the remaining five were never attempted).
 *
 * Two things had to be true for that to stop happening, and this module is both of them:
 *
 *  1. **one rule, one query.** The migration and the repair each had their own idea of "the
 *     first free position", one built on `max(track_number)` and one on a `Set` of what was
 *     taken, and two implementations of a uniqueness rule is one implementation too many.
 *     `positionsTaken` reads the bucket the index actually groups by — `coalesce(disc, 1)`,
 *     null and 1 being the *same disc* — and `allocatePosition` is the rule over it.
 *  2. **the allocation belongs next to the insert.** Reading the taken positions, then doing
 *     four more statements' worth of work, then inserting, is a read-then-write with a gap in
 *     the middle; anything that writes a row into that album in the gap wins the race and the
 *     insert is refused. `insertLibraryTrack` closes it the only way a single statement can:
 *     it lets Postgres be the arbiter, and *retries* on the one violation that means "somebody
 *     took it first", a bounded number of times, moving past the end of the album each time.
 *
 * So the allocator is right and a collision still cannot escape. Belt and braces, because the
 * cost of being wrong is a file on disk that no row points at.
 */
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import type { Database } from "#/server/db/client.ts";
import { libraryTracks, type NewLibraryTrack } from "#/server/db/schema/index.ts";

/** The unique index this module exists to never violate. */
export const POSITION_INDEX = "library_tracks_album_position_idx";

/**
 * The disc the index means.
 *
 * `coalesce(disc_number, 1)`: a row with no disc number and a row on disc 1 are the same disc
 * as far as uniqueness is concerned, and treating them as two is how a "single-disc album"
 * ends up exempt from the constraint it is most likely to break.
 */
export function discBucket(discNumber: number | null | undefined): number {
  return discNumber ?? 1;
}

export interface PositionQuery {
  readonly albumId: string;
  readonly discNumber: number | null;
  /** The row the position is being computed for: a row never collides with itself. */
  readonly exceptTrackId?: string | null | undefined;
}

/**
 * Every position `(album, coalesce(disc, 1))` holds **right now**.
 *
 * Read fresh on every call and never cached: rows inserted earlier in the same run are rows,
 * and a count taken before them is a lie the unique index will call out.
 */
export async function positionsTaken(db: Database, query: PositionQuery): Promise<Set<number>> {
  const rows = await db
    .select({ trackNumber: libraryTracks.trackNumber })
    .from(libraryTracks)
    .where(
      and(
        eq(libraryTracks.albumId, query.albumId),
        sql`coalesce(${libraryTracks.discNumber}, 1) = ${discBucket(query.discNumber)}`,
        isNotNull(libraryTracks.trackNumber),
        ...(query.exceptTrackId === null || query.exceptTrackId === undefined
          ? []
          : [ne(libraryTracks.id, query.exceptTrackId)]),
      ),
    );
  const taken = new Set<number>();
  for (const row of rows) if (row.trackNumber !== null) taken.add(row.trackNumber);
  return taken;
}

/**
 * The rule, over a set of taken positions. Pure, so it can be reasoned about on its own.
 *
 * - a **free** candidate is taken as-is, hole or not: an album numbered 1, 2, 4 has a free 3
 *   and a track that says it is track 3 belongs there;
 * - a **taken** one goes *past the end of the album* — one above the highest position the
 *   album currently holds, then upwards until something is genuinely free. Past the end
 *   rather than into the first hole, because a hole is usually a track that has not been
 *   migrated yet and stealing its number only moves the collision;
 * - `after` is what a retry knows that the first attempt did not: the position just refused is
 *   held by somebody, whatever the read said.
 *
 * The loop matters. `max + 1` alone is right only if nothing above the maximum exists, and
 * `count + 1` is never right: an album holding 1, 2, 4, 25, 26 has five tracks and its first
 * free slot past the end is 27, not 6.
 */
export function allocatePosition(
  taken: ReadonlySet<number>,
  candidate: number | null,
  after = 0,
): number {
  if (candidate !== null && candidate > after && !taken.has(candidate)) return candidate;

  let highest = Math.max(after, candidate ?? 0);
  for (const position of taken) if (position > highest) highest = position;

  let next = highest + 1;
  while (taken.has(next)) next += 1;
  return next;
}

export interface PositionRequest extends PositionQuery {
  /** What the track says its position is — from the release, or from its own tags. */
  readonly candidate: number | null;
  /**
   * Positions this run has already promised but not yet written.
   *
   * A real run makes the database the record of what it handed out, so this is empty. A **dry
   * run** writes nothing, and without it every file of an album is offered the same number —
   * a preview that is not the plan.
   */
  readonly reserved?: ReadonlySet<number> | undefined;
  /** Strictly greater than this. What a retry knows. */
  readonly after?: number | undefined;
}

/** `positionsTaken` + `allocatePosition`, which is what both callers actually want. */
export async function freeAlbumPosition(db: Database, request: PositionRequest): Promise<number> {
  const taken = await positionsTaken(db, request);
  if (request.reserved !== undefined) for (const position of request.reserved) taken.add(position);
  return allocatePosition(taken, request.candidate, request.after ?? 0);
}

/** True when Postgres refused a row for the position index, and not for anything else. */
export function isPositionCollision(error: unknown): boolean {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const detail = cause as { code?: unknown; constraint_name?: unknown };
  return detail.code === "23505" && detail.constraint_name === POSITION_INDEX;
}

export interface InsertOptions {
  /** How many times a collision is worth trying again. Zero means "try once". */
  readonly attempts?: number;
  readonly say?: ((message: string) => Promise<void> | void) | undefined;
}

/**
 * Insert one `library_tracks` row, and never let a position collision escape.
 *
 * The allocator is right, and this is here because a correct allocator still races: the read
 * that decided the position and the write that takes it are two statements, and another
 * writer fits between them. On a violation of the position index — and **only** that one; a
 * duplicate path or a duplicate recording is a different problem and must still be reported —
 * the row moves past the end of the album and tries again, up to `attempts` times.
 *
 * When the retries run out, the failure is an `MMError` with code `POSITION_TAKEN` so the
 * caller can journal it against *that track* and carry on with the rest. The one thing that
 * must never happen is the whole run dying on one row.
 */
export async function insertLibraryTrack(
  db: Database,
  values: NewLibraryTrack,
  options: InsertOptions = {},
): Promise<{ readonly trackNumber: number | null; readonly attempts: number }> {
  const attempts = options.attempts ?? 5;
  let row = values;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await db.insert(libraryTracks).values(row);
      return { trackNumber: row.trackNumber ?? null, attempts: attempt + 1 };
    } catch (error) {
      const position = row.trackNumber;
      const albumId = row.albumId;
      // No album or no position means the partial index does not apply, so a rejection here is
      // somebody else's rule and belongs to the caller unchanged.
      if (
        albumId === null ||
        albumId === undefined ||
        position === null ||
        position === undefined ||
        !isPositionCollision(error)
      ) {
        throw error;
      }
      if (attempt >= attempts) {
        throw new MMError(
          "POSITION_TAKEN",
          `position ${String(position)} on disc ${String(discBucket(row.discNumber))} of album ` +
            `${albumId} is taken, and ${String(attempts + 1)} attempts found no free one.`,
          {
            hint: "Another writer is inserting into the same album at the same time.",
            action: "Run it again once the other run has finished.",
            details: { albumId, disc: discBucket(row.discNumber), wanted: position },
            cause: error,
          },
        );
      }

      const next = await freeAlbumPosition(db, {
        albumId,
        discNumber: row.discNumber ?? null,
        candidate: null,
        after: position,
      });
      await options.say?.(
        `position ${String(position)} was taken between the read and the write; ` +
          `retrying at ${String(next)}`,
      );
      row = { ...row, trackNumber: next };
    }
  }
}
