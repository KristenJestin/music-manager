/**
 * The projection invariant, enforced.
 *
 * `AGENTS.md` opens on it and `docs/03-metadonnees.md` §8 is built on it: *the database is the
 * source of truth for metadata, with provenance per field; files are a regenerable projection
 * of it*. An invariant nobody enforces is a slogan, and this repository had the slogan.
 * Correcting a field queued a re-tag because `services/overrides.ts` remembered to; refreshing
 * an album from its source queued one because `services/album-refresh.ts` remembered to;
 * **confirming a different release queued nothing at all**, and an album re-matched from the
 * wizard kept the previous edition's `MUSICBRAINZ_RELEASETRACKID` on disk until somebody who
 * knew a re-tag existed ran one by hand.
 *
 * This module is the one place that decides what to do about it. The *test* — which files
 * disagree with the database, and why — lives in `quality.tracksAdrift`, beside
 * `tracksBehindSchema`, because the two are the two selections a re-tag run can be opened
 * with and they belong next to each other.
 *
 * ## Why not `persistDocument` / `storeDocument`
 *
 * `services/documents.ts` is the single place a document reaches the database, and hooking
 * `persist()` there is the obvious idea. It is the wrong seam, for a reason that is not a
 * matter of taste: **the path this defect is about writes no document.** `matchStep` rewrites
 * `imports.release_mbid` and every `import_tracks` row and leaves `metadata_documents` exactly
 * as it was, so a hook on document persistence would never fire and the re-matched album would
 * still be wrong. Two further facts point the same way. `persist()` receives the *per-track*
 * build, before `unifyScope` has applied the album's value for the 36 `albumScope` fields, so
 * its projection legitimately differs from the file's on every album that has been unified —
 * `retagOne` calls `applyAlbumScopeTo` before projecting for exactly this reason. And it is
 * called from inside the `tag` step, one line before that step writes the file itself.
 *
 * So the seam is one level out: **the end of a unit of work that changed what a placed file
 * would be written from.** There are three such units, and all three now end here:
 *
 *  - `matchStep` — every confirmation in the application funnels into it: `confirmSupplied`
 *    (the wizard's Start, `POST /confirm-mapping`, MCP's `confirm_mapping`, the album page's
 *    "Change release"), `confirmBest`/`applyAndReport` (`POST /confirm-best`, MCP, the batch),
 *    and an Inbox `{action: "retry", step: "match"}`. One call covers the lot, which is also
 *    why `services/confirm.ts` needed no change;
 *  - `overrides.write` — a field set or released by hand;
 *  - `refreshAlbumFromSource` — MusicBrainz answering differently than it used to.
 *
 * ## Loops, and floods
 *
 * **A re-tag must not queue a re-tag.** It cannot: `retagOne` rebuilds with `persist: false`
 * and `stamp` writes `metadata_documents` and `library_tracks` directly, so nothing inside a
 * re-tag passes through any of the three units above. That is an accident of where the code
 * sits rather than a guarantee, so it is made explicit twice over — `runBatch` runs inside
 * `withoutProjection()`, and `ensureProjection` refuses to open a second run while one that
 * covers the same scope is still `pending` or `running`.
 *
 * **A bulk write must not queue one run per track.** Three exist — the v1 migration,
 * `repair-orphans`, and the re-tag itself — and all three are already writing every file they
 * touch, so the honest answer for them is **suppression at the caller** rather than batching:
 * `withoutProjection()` wraps the whole pass, ambiently, through `AsyncLocalStorage`. For
 * everything else the coalescing is structural instead: a run is opened per **album**, never
 * per track, and the "is one already open?" check collapses a second write onto the first run.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { libraryTracks, retagRuns, type RetagTrigger } from "#/server/db/schema/index.ts";
import { enqueueRetagRun } from "#/server/services/queue.ts";
import { tracksAdrift, type AdriftTrack } from "#/server/services/quality.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* suppression                                                         */
/* ------------------------------------------------------------------ */

const SUPPRESSED = new AsyncLocalStorage<true>();

/**
 * Run `fn` with the catch-up switched off, for code that is already writing the files itself.
 *
 * Ambient rather than a flag threaded through six signatures: the three writers that need it
 * call into services several layers deep, and "everything under here" is the only form of the
 * rule that stays true when somebody adds a layer.
 */
export async function withoutProjection<T>(fn: () => Promise<T>): Promise<T> {
  return await SUPPRESSED.run(true, fn);
}

/** True inside `withoutProjection`. Exported so a test can assert the wrapping, not hope for it. */
export function projectionSuppressed(): boolean {
  return SUPPRESSED.getStore() === true;
}

/* ------------------------------------------------------------------ */
/* the act                                                             */
/* ------------------------------------------------------------------ */

export interface EnsureOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  /** A `library_albums.id`, or a `library_tracks.id` with `scope: "track"`. */
  readonly scope: "album" | "track";
  readonly targetId: string;
  /** Why the run exists, for the run list. */
  readonly trigger?: RetagTrigger;
  /** Skip without looking. The caller is already writing these files. */
  readonly suppress?: boolean;
}

export interface EnsureOutcome {
  readonly runId: string;
  readonly total: number;
  /** True when an unfinished run already covered this scope and was reused rather than doubled. */
  readonly reused: boolean;
  /** How many files were found behind the database. */
  readonly adrift: number;
}

/**
 * Queue a re-tag for the files of `scope` the database has left behind — or nothing at all.
 *
 * Returns `null` in the cases that must cost nothing: suppressed, no placed file in scope, and
 * — the one that matters most — **nothing adrift**. A write that changes no value the files
 * carry queues no run, and that is a property of the comparison rather than of a caller being
 * careful about when to call this.
 *
 * The run is opened with `selection: "adrift"`, so what it processes is what was counted here,
 * and `runBatch` re-derives the same set on every batch.
 */
export async function ensureProjection(options: EnsureOptions): Promise<EnsureOutcome | null> {
  if (options.suppress === true || projectionSuppressed()) return null;
  const db = options.db ?? defaultDb();

  const adrift = await tracksAdrift({
    db,
    ...(options.scope === "album" ? { albumId: options.targetId } : { trackId: options.targetId }),
  });
  if (adrift.length === 0) return null;

  /*
   * One run per **album**, never per track. An override on fourteen tracks, or a re-match of a
   * fourteen-track release, is one act: it deserves one run, one progress bar and one line in
   * the journal. A track-scoped caller is promoted to its album for the same reason — and
   * because the album-scope pass means a single track's re-projection is an album's question
   * anyway.
   */
  const albumId = albumOf(adrift);
  const scope = albumId === null ? "track" : "album";
  const targetId = albumId ?? options.targetId;

  const existing = await openRunFor(db, scope, targetId);
  if (existing !== null) {
    return { runId: existing.id, total: existing.total, reused: true, adrift: adrift.length };
  }

  const settings = options.settings ?? (await loadSettings(db));
  /*
   * Dynamic, and it is the one thing holding the dependency graph the right way up.
   * `services/retag.ts` imports `withoutProjection` from this module to wrap `runBatch` — the
   * loop guard — so a static import back into `retag.ts` from here would be a cycle. This edge
   * is one function call inside a rarely-taken branch; that one is on the hot path of every
   * batch. The same trick, for the same reason, as `services/queue.ts`.
   */
  const { createRun } = await import("#/server/services/retag.ts");
  const run = await createRun({
    db,
    settings,
    scope,
    targetId,
    selection: "adrift",
    dryRun: false,
    trigger: options.trigger ?? "manual",
  });
  if (run.total === 0) return null;

  await enqueueRetagRun(run.id);
  return { runId: run.id, total: run.total, reused: false, adrift: adrift.length };
}

/** The album every adrift track belongs to, or `null` when they are not all in one. */
function albumOf(adrift: readonly AdriftTrack[]): string | null {
  const first = adrift[0]?.track.albumId ?? null;
  if (first === null) return null;
  return adrift.every((entry) => entry.track.albumId === first) ? first : null;
}

/**
 * An unfinished run that already covers this scope, if there is one.
 *
 * This is the flood valve and half of the loop guard at once. Two overrides in a row, a
 * re-match followed by a correction, a `storeDocument` per track — none of them opens a second
 * run, because the first has not read the files yet and will re-derive its targets from
 * whatever the database says when it gets there.
 */
async function openRunFor(
  db: Database,
  scope: "album" | "track",
  targetId: string,
): Promise<{ id: string; total: number } | null> {
  const [row] = await db
    .select({ id: retagRuns.id, total: retagRuns.total })
    .from(retagRuns)
    .where(
      and(
        inArray(retagRuns.status, ["pending", "running"]),
        eq(retagRuns.dryRun, false),
        or(
          eq(retagRuns.scope, "library"),
          and(eq(retagRuns.scope, scope), eq(retagRuns.targetId, targetId)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The same act, addressed by import rather than by album.
 *
 * `matchStep` knows which import it has just re-mapped and not which albums that import's files
 * ended up in — a double album that was split, or a re-download filed under a new folder, is
 * more than one `library_albums` row — so the albums are resolved here and each gets its own
 * run. An import whose files are not placed yet resolves to none, which is the correct answer
 * during an ordinary first import and costs one indexed query.
 */
export async function ensureProjectionForImport(options: {
  readonly importId: string;
  readonly db?: Database;
  readonly settings?: Settings;
  readonly trigger?: RetagTrigger;
}): Promise<EnsureOutcome[]> {
  if (projectionSuppressed()) return [];
  const db = options.db ?? defaultDb();

  const rows = await db
    .selectDistinct({ albumId: libraryTracks.albumId })
    .from(libraryTracks)
    .where(and(eq(libraryTracks.importId, options.importId), isNotNull(libraryTracks.albumId)));

  const out: EnsureOutcome[] = [];
  for (const row of rows) {
    if (row.albumId === null) continue;
    const outcome = await ensureProjection({
      db,
      scope: "album",
      targetId: row.albumId,
      ...(options.settings === undefined ? {} : { settings: options.settings }),
      ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
    });
    if (outcome !== null) out.push(outcome);
  }
  return out;
}
