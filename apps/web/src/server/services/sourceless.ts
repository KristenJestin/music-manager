/**
 * Tracks of the confirmed release that **no video covers**, given a row of their own.
 *
 * ## The defect this exists for
 *
 * YouTube publishes nineteen titles; the MusicBrainz release the owner confirmed has twenty.
 * The twentieth is a real track of the record, and until now it was unreachable by every door
 * in the application at once. `import_tracks` is born from a video (`steps/resolve.ts` inserts
 * one row per `ExtractEntry`), so there was no id to hang anything on — on the owner's
 * installation not one of 11 049 rows had an empty `video_id` — and `adoptTrackFile` answered
 * `ADOPT_NOT_READY`, *"this video is not bound to a track"* (`services/adopt.ts`,
 * `refuseAdoption`). Having the file made no difference. The album simply stayed incomplete,
 * for ever, with nothing anybody could press.
 *
 * So the gap is given an identity. A `sourceless` row carries the track's position, title,
 * artist and expected duration from the release, has `video_id` and `url` **null**, and exists
 * for exactly one purpose: to be a `trackId` that `adoptTrackFile` will accept.
 *
 * ## Why this is its own module and its own exported function
 *
 * Because two callers need it and only one of them is the confirmation.
 *
 *  1. **`steps/confirm.ts`**, at the moment the release is committed — which is the earliest
 *     instant the tracklist is a decision rather than a proposal, and therefore the earliest
 *     instant a gap in it is a fact.
 *  2. **the library side**, completing an album that is already on disk. That feature resolves
 *     a library track to an import track, materialising one here when there is none, and then
 *     delegates to `adoptTrackFile`. It must not reimplement either half.
 *
 * A block buried inside `confirmStep` would have served the first and been unreachable to the
 * second. This is the contact point between the two, so it takes plain data — no `StepContext`,
 * no job machine — and can be called from anywhere with a `Database`.
 *
 * ## Why a sourceless row cannot break an import
 *
 * Three properties, each enforced somewhere else and each worth naming here because this is
 * the module that creates the rows relying on them:
 *
 *  - **it is never downloaded.** `steps/download.ts` skips it before every other branch. Its
 *    `url` is null, and a null url reaching the toolbox would fail the track, then the step,
 *    then the album — turning a nineteen-of-twenty album from *incomplete* into *broken*.
 *  - **it never fails an import.** `settleImport` fails on `state === "failed"`, and this is
 *    not that.
 *  - **it never keeps an import open.** `isTrackTerminal` counts it with `skipped` and
 *    `failed`, so `nextTrackStep` is null and `aggregateStatus` leaves it out of the
 *    denominator; the three pipelined step rows can reach `done` over the tracks that do have
 *    files. An album with a gap therefore *finishes*, and says nineteen of twenty, instead of
 *    sitting at `running` for ever waiting for a track that is waiting for a person.
 *
 * The gap stays visible: the row is on the import page, greyed, offering the same "Adopt" it
 * offers a failed download, and `get_import` returns it with the same id so an agent can adopt
 * onto it with no screen.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { importTracks, type ImportTrack } from "#/server/db/schema/index.ts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { newId } from "#/server/ids.ts";

/**
 * One track of the release that has no video, as the caller knows it.
 *
 * Field for field the `UncoveredCell` that `steps/match.ts` already computes and writes into
 * the `uncovered_tracks` Inbox payload — restated here rather than imported so that this
 * module stays free of the matcher, which imports half the job machine.
 */
export interface SourcelessCell {
  /** Position **within its medium**, one-based. */
  readonly position: number;
  /** Which disc. One-based, and 1 for a single-disc record. */
  readonly mediumPosition: number;
  readonly title: string | null;
  readonly recordingMbid: string | null;
  /** The MusicBrainz *track* id, when the caller has it. */
  readonly trackMbid?: string | null;
  /** What the release says this track lasts, so the row can show a duration. */
  readonly lengthSeconds: number | null;
}

export interface MaterialiseOptions {
  readonly importId: string;
  readonly cells: readonly SourcelessCell[];
  /** Credited in the row's `note`, so the journal says who asked. */
  readonly by?: string;
  readonly db?: Database;
}

export interface MaterialiseResult {
  /** The rows created by this call. Empty when every cell already had one. */
  readonly created: readonly ImportTrack[];
  /** Cells that already had a row — a video's, or a sourceless one from an earlier call. */
  readonly existing: number;
}

/** `(medium, track)` as one comparable string. Never the flat position — see below. */
function key(mediumPosition: number, trackPosition: number): string {
  return `${String(mediumPosition)}:${String(trackPosition)}`;
}

/**
 * Create the missing `import_tracks` rows for `cells`, and return them.
 *
 * **Idempotent**, and that is not decoration: `confirm` can run twice — a retry, a resume, an
 * Inbox answer that re-queues the job — and a second run must not double the tracklist. A cell
 * is skipped when *any* row of the import already sits at its `(mediumPosition,
 * trackPosition)`, whether that row is a video's or a sourceless one this function made
 * earlier. The second case is the re-run; the first is the one that matters more, because a
 * video mapped to that position means the track is covered and there is no gap to fill.
 *
 * **The key is `(mediumPosition, trackPosition)` and never `trackPosition` alone.** That is
 * the defect `uncoveredTracks` already carries a paragraph about: a two-disc record has two
 * track 1s, and a flat comparison reported six perfectly good tracks of *Crèvecœur* as
 * missing. Creating rows off a flat key would be the same bug with worse consequences — it
 * would manufacture six phantom tracks rather than merely mention them.
 */
export async function materialiseSourcelessTracks(
  options: MaterialiseOptions,
): Promise<MaterialiseResult> {
  const db = options.db ?? defaultDb();
  if (options.cells.length === 0) return { created: [], existing: 0 };

  const rows = await db
    .select()
    .from(importTracks)
    .where(eq(importTracks.importId, options.importId));

  const taken = new Set(
    rows
      .filter((row) => row.trackPosition !== null)
      .map((row) => key(row.mediumPosition ?? 1, row.trackPosition ?? 0)),
  );

  /*
   * A position in the *listing*, after everything that is really in it.
   *
   * `import_tracks.position` is "where yt-dlp numbered this in the source", it is `notNull`,
   * and it is unique per import. A sourceless row is in no listing, so any value is a
   * fiction — but it has to be a *distinct* fiction, or the unique index rejects the second
   * one. Continuing past the highest existing position keeps every real entry's number intact
   * (`applySupplied` joins a supplied mapping on it) and keeps these rows sorting last in any
   * listing-ordered view, which is where they belong.
   */
  let next = rows.reduce((highest, row) => Math.max(highest, row.position), 0) + 1;

  const created: ImportTrack[] = [];
  let existing = 0;

  for (const cell of options.cells) {
    if (taken.has(key(cell.mediumPosition, cell.position))) {
      existing += 1;
      continue;
    }
    taken.add(key(cell.mediumPosition, cell.position));

    const row = await insertAt(db, options.importId, next, {
      sourceTitle: cell.title ?? `Track ${String(cell.position)}`,
      sourceDuration: cell.lengthSeconds,
      trackMbid: cell.trackMbid ?? null,
      recordingMbid: cell.recordingMbid,
      trackTitle: cell.title,
      trackPosition: cell.position,
      mediumPosition: cell.mediumPosition,
      note:
        options.by === undefined
          ? "no video covers this track of the release"
          : `no video covers this track of the release (${options.by})`,
    });
    created.push(row);
    next = row.position + 1;
  }

  return { created, existing };
}

/** Postgres' unique-violation. The only insert failure here that is worth retrying. */
const UNIQUE_VIOLATION = "23505";

/**
 * Insert one sourceless row, stepping past a listing position somebody else has taken.
 *
 * `import_tracks.position` is unique per import, and the free one is chosen from a `select`
 * that is not in the same transaction as the `insert`. That gap is a real race for the second
 * caller of this module — completing an album from the library page, where two clicks on two
 * missing tracks can land together — and losing it would surface as a raw constraint violation
 * from a button, which is not an answer anybody can act on.
 *
 * Retrying on the conflict rather than locking the table, because the value is arbitrary: any
 * free position will do, the number means nothing to a row that is in no listing, and a
 * conflict is proof that somebody else got there first rather than that anything is wrong.
 */
async function insertAt(
  db: Database,
  importId: string,
  from: number,
  fields: {
    sourceTitle: string;
    sourceDuration: number | null;
    trackMbid: string | null;
    recordingMbid: string | null;
    trackTitle: string | null;
    trackPosition: number;
    mediumPosition: number;
    note: string;
  },
): Promise<ImportTrack> {
  let position = from;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [row] = await db
        .insert(importTracks)
        .values({
          id: newId("importTrack"),
          importId,
          position,
          // The two that make this row what it is. Nothing is invented: there is no video.
          videoId: null,
          url: null,
          uploader: null,
          // `raw` is the yt-dlp entry everywhere else, and there is no entry here. An empty
          // object rather than a fabricated one: `documents.ts` reads it as "no YouTube
          // provenance", which is the truth, and an adoption record will be written beside it
          // the moment somebody gives this track a source.
          raw: {},
          // **`mapped`**, because it is: this row is bound to a track of the confirmed release,
          // which is precisely the condition `refuseAdoption` checks before allowing a file.
          // `unmatched` would make the whole row pointless.
          role: "mapped",
          state: "sourceless",
          // Not a guess the matcher made — a fact read off the release — so it is not scored.
          confidence: null,
          ...fields,
        })
        .returning();
      if (row !== undefined) return row;
      throw new Error("the insert returned no row");
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== UNIQUE_VIOLATION || attempt >= 50) throw error;
      position += 1;
    }
  }
}

/**
 * The `uncovered_tracks` Inbox payload → the cells to materialise.
 *
 * `steps/match.ts` writes that payload — position, medium, title, recording, length — from the
 * release's own tracklist, at the moment it works out what the mapping does not cover. Reading
 * it back is strictly better than recomputing: it is the same grid the notice shown to the
 * owner was built from, so the rows created here are the tracks the card listed, and it costs
 * no MusicBrainz lookup at a moment (`confirm`) when somebody is waiting for an answer.
 *
 * Tolerant by construction. An item written by an older build, or one whose payload has been
 * edited, yields the cells it can parse and drops the rest — a malformed notice must not stop
 * a confirmation, because the import is fine and only the bookkeeping is not.
 */
export function cellsFromUncoveredPayload(payload: unknown): SourcelessCell[] {
  if (typeof payload !== "object" || payload === null) return [];
  const tracks = (payload as { tracks?: unknown }).tracks;
  if (!Array.isArray(tracks)) return [];

  const cells: SourcelessCell[] = [];
  for (const entry of tracks) {
    if (typeof entry !== "object" || entry === null) continue;
    const held = entry as Record<string, unknown>;
    const position = held["position"];
    if (typeof position !== "number" || !Number.isInteger(position) || position < 1) continue;
    const medium = held["mediumPosition"];
    cells.push({
      position,
      // Absent means a single-disc record, which is what every other reader of this payload
      // assumes and what `uncoveredTracks` writes when there is no tracklist to say otherwise.
      mediumPosition: typeof medium === "number" && medium >= 1 ? medium : 1,
      title: typeof held["title"] === "string" ? held["title"] : null,
      recordingMbid: typeof held["recordingMbid"] === "string" ? held["recordingMbid"] : null,
      lengthSeconds: typeof held["lengthSeconds"] === "number" ? held["lengthSeconds"] : null,
    });
  }
  return cells;
}

/**
 * Throw away the sourceless rows **nobody has given a source to**, for a discarded mapping.
 *
 * `forgetMapping` — "match again" — unmatches every row of the import and nulls the mapping
 * columns, which is right for a video: the video is the *listing*, it survives any number of
 * re-matches, and only its binding was wrong. A sourceless row is the opposite. It exists
 * **only** as a consequence of the mapping being discarded: it is a track of *that* release,
 * at a position on *that* tracklist, and once the release is gone it describes nothing.
 *
 * Left alone it became a ghost — no video, no role, no position — and the next confirmation
 * would not recognise it (`taken` is keyed on `trackPosition`, which had just been nulled), so
 * it would create a *second* row for the same gap. Re-matching a record with a hole twice would
 * leave two ghosts and a real row for one missing track.
 *
 * **A row somebody has already adopted onto is kept**, and that is the whole of the condition.
 * It has bytes on disk and possibly a file in the library; it is no longer a statement about a
 * tracklist but a track with audio, and deleting it would throw away the very thing this
 * feature exists to let people put there.
 */
export async function discardUnclaimedSourcelessTracks(
  importId: string,
  db: Database = defaultDb(),
): Promise<number> {
  const gone = await db
    .delete(importTracks)
    .where(
      and(
        eq(importTracks.importId, importId),
        isNull(importTracks.videoId),
        // Still empty. Anything adopted has moved on to `downloaded` and beyond.
        eq(importTracks.state, "sourceless"),
      ),
    )
    .returning({ id: importTracks.id });
  return gone.length;
}

/** The sourceless rows of one import, in tracklist order. */
export async function sourcelessTracksOf(
  importId: string,
  db: Database = defaultDb(),
): Promise<ImportTrack[]> {
  return await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), isNull(importTracks.videoId)))
    .orderBy(
      sql`coalesce(${importTracks.mediumPosition}, 1)`,
      sql`coalesce(${importTracks.trackPosition}, 0)`,
    );
}
