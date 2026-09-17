/**
 * What a step is handed, and the few writes every step shares.
 *
 * A step function is `(ctx) => Promise<StepResult>`: it reads the job out of the context,
 * does its work, persists what it learned, and says what happened. It never decides where
 * the job goes next — that is `machine.ts` — and it never talks to pg-boss.
 *
 * The context is rebuilt before each step rather than carried across the whole run, because a
 * step that resumes after a worker restart must see the rows as they are now, not as they
 * were when the job was first queued.
 */
import { existsSync, statSync } from "node:fs";
import { and, asc, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  importTracks,
  imports,
  type Import,
  type ImportTrack,
  type StepName,
  type StoredError,
  type TrackState,
} from "#/server/db/schema/index.ts";
import { serverEnv } from "#/server/env.ts";
import { hostPath, pathMap, type PathMap } from "#/server/paths.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { emit } from "#/server/services/events.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

export interface StepContext {
  readonly db: Database;
  readonly toolbox: ToolboxClient;
  readonly settings: Settings;
  readonly paths: PathMap;
  /** `MM_FIXTURES=1`: sources come from `packages/domain/fixtures`, jitter is zero. */
  readonly fixtures: boolean;
  readonly job: Import;
  readonly step: StepName;
  /** Aborted when the worker is shutting down or the job was cancelled. */
  readonly signal: AbortSignal | undefined;
  /**
   * The one track this run is about, or `null` for a run over the whole album.
   *
   * Set by the per-track queue (`track.step`): `fingerprint`, `tag` and `place` run once per
   * track so that track N's local work overlaps track N+1's download (decision 147). A step
   * that reads `mappedTracks()` therefore sees one row and needs no other change; a step that
   * genuinely reasons about the *album* — cleaning the work directory, measuring ReplayGain,
   * unifying the album-scope fields — must ask `albumTracks()` and say so.
   */
  readonly trackScope: string | null;
  /**
   * The Inbox items **this run of this step** raised or refreshed.
   *
   * Fresh for every run, and filled by the step itself. It is what lets a step close the
   * questions it asked last time and does not ask any more (`closeSupersededItems`):
   * `openInboxItem` makes a step idempotent in one direction only, and nothing used to close
   * the other, so an album re-matched onto a release that covers every track kept its
   * "6 tracks have no video" flag for ever.
   */
  readonly raised: Set<string>;
  /** Append one line to the journal, already tagged with this import and this step. */
  say(
    type: string,
    message: string,
    options?: {
      data?: Record<string, unknown>;
      level?: "info" | "warn" | "error";
      trackId?: string;
    },
  ): Promise<void>;
  /** The import's videos, in source order. Re-read on every call. */
  tracks(): Promise<ImportTrack[]>;
  /** The videos bound to a MusicBrainz track, in tracklist order — **narrowed to the scope**. */
  mappedTracks(): Promise<ImportTrack[]>;
  /** Every mapped video of the import, whatever the scope. The album's own view. */
  albumTracks(): Promise<ImportTrack[]>;
  /**
   * Called by `download` the instant one track's file is ready, so the rest of that track's
   * pipeline can start while the next download runs. `undefined` outside the worker, which is
   * what keeps `runImport` a straight, serial pipeline for the CLI and the tests.
   */
  readonly onTrackDownloaded: ((trackId: string) => Promise<void>) | undefined;
}

export interface ContextOptions {
  readonly db?: Database;
  readonly toolbox?: ToolboxClient;
  readonly settings?: Settings;
  readonly signal?: AbortSignal;
  /**
   * Refuse the step if the job has since been cancelled, has finished, or is paused.
   *
   * **For a caller that took the work off a queue, and only for one.** A queue message is a
   * statement about the past — the job it names may have been cancelled a minute ago, and
   * pg-boss has no idea — whereas `mm retry --step verify` on a `done` album is a person
   * asking for exactly that, on purpose. So the check belongs to the caller who cannot know,
   * not to `runStep` itself: the worker sets it, the CLI and the tests do not.
   */
  readonly skipIfStopped?: boolean;
  /** Run the step for this one track only (the `track.step` queue). */
  readonly trackId?: string;
  /** See `StepContext.onTrackDownloaded`. */
  readonly onTrackDownloaded?: (trackId: string) => Promise<void>;
}

/** Read one import, or explain that it does not exist. */
export async function requireImport(id: string, db: Database = defaultDb()): Promise<Import> {
  const [row] = await db.select().from(imports).where(eq(imports.id, id)).limit(1);
  if (row === undefined) {
    throw new MMError("NOT_FOUND", `No import with id ${id}.`, {
      hint: "Run `mm jobs` to list them.",
      action: "List jobs",
    });
  }
  return row;
}

/**
 * The library roots, honouring the two settings before falling back to the environment.
 *
 * They are two settings on purpose: the orchestrator and the toolbox look at the same
 * directory through different paths, and only the person who wired the bind mount knows both.
 */
export function resolvePaths(settings: Settings): PathMap {
  const env = serverEnv();
  return pathMap({
    host: settings.libraryRoot === "" ? env.MM_LIBRARY_ROOT : settings.libraryRoot,
    container:
      settings.toolboxLibraryRoot === ""
        ? env.MM_TOOLBOX_LIBRARY_ROOT
        : settings.toolboxLibraryRoot,
    workDir: env.MM_WORK_DIR,
  });
}

/** Assemble the context for one step of one import. */
export async function makeContext(
  importId: string,
  step: StepName,
  options: ContextOptions = {},
): Promise<StepContext> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const job = await requireImport(importId, db);
  const scope = options.trackId ?? null;

  const everyMapped = async (): Promise<ImportTrack[]> =>
    await db
      .select()
      .from(importTracks)
      .where(and(eq(importTracks.importId, importId), eq(importTracks.role, "mapped")))
      // Tracklist order is `(medium, position)`. Ordering on the position alone interleaves the
      // two discs of a multi-disc record — 1, 1, 2, 2, 3, 3 — and every consumer of this list
      // reads it as "the album, in order".
      .orderBy(asc(importTracks.mediumPosition), asc(importTracks.trackPosition));

  return {
    db,
    toolbox: options.toolbox ?? defaultToolbox(),
    settings,
    paths: resolvePaths(settings),
    fixtures: serverEnv().MM_FIXTURES,
    job,
    step,
    signal: options.signal,
    trackScope: scope,
    raised: new Set<string>(),
    onTrackDownloaded: options.onTrackDownloaded,
    async say(type, message, extra = {}) {
      await emit(
        {
          importId,
          step,
          type,
          message,
          ...(extra.trackId === undefined ? {} : { trackId: extra.trackId }),
          ...(extra.level === undefined ? {} : { level: extra.level }),
          ...(extra.data === undefined ? {} : { data: extra.data }),
        },
        db,
      );
    },
    async tracks() {
      return await db
        .select()
        .from(importTracks)
        .where(eq(importTracks.importId, importId))
        .orderBy(asc(importTracks.position));
    },
    async mappedTracks() {
      const rows = await everyMapped();
      return scope === null ? rows : rows.filter((row) => row.id === scope);
    },
    async albumTracks() {
      return await everyMapped();
    },
  };
}

/**
 * The library-relative path `relative` if a real, non-empty file is sitting there — `null`
 * otherwise.
 *
 * The steps never trust a row about a file; they ask the filesystem. This is that question,
 * asked the same way everywhere, and the "non-empty **regular** file" part is the whole point
 * of having one function for it: a directory at the destination (`/place` answers
 * `PLACE_CONFLICT` for one) and a zero-byte stub left by a copy that died halfway are both
 * `existsSync`-true, and neither one is a track. Believing either would make `download` skip a
 * track that was never fetched, which is a silently missing file at the end of the import.
 */
export function fileOnDisk(paths: PathMap, relative: string | null): string | null {
  if (relative === null || relative === "") return null;
  const absolute = hostPath(paths, relative);
  if (!existsSync(absolute)) return null;
  const stat = statSync(absolute);
  return stat.isFile() && stat.size > 0 ? relative : null;
}

/**
 * Patch one import track and stamp `updated_at` — on the track **and on its import**.
 *
 * The second stamp is the point. `imports.updated_at` used to move only when a *step* row
 * changed state, so an album on its thirteenth file looked, to anything reading the import
 * row, exactly as still as one cancelled an hour earlier — and the Console cannot sort "what
 * is moving" to the top of a list of four hundred jobs using a column that does not move.
 * A track reaching a new state *is* the import moving, so the row now says so.
 *
 * One extra `update` per track *state* change, not per progress tick: the byte-by-byte
 * progress goes to the journal (`track.progress`) and never through here.
 */
export async function updateTrack(
  ctx: StepContext,
  trackId: string,
  patch: Partial<Omit<ImportTrack, "id" | "importId" | "createdAt">>,
): Promise<void> {
  const now = new Date();
  await ctx.db
    .update(importTracks)
    .set({ ...patch, updatedAt: now })
    .where(eq(importTracks.id, trackId));
  await ctx.db.update(imports).set({ updatedAt: now }).where(eq(imports.id, ctx.job.id));
}

/** Move a track to a new state, with an optional note the Console can show. */
export async function setTrackState(
  ctx: StepContext,
  trackId: string,
  state: TrackState,
  extra: { note?: string; error?: StoredError | null } = {},
): Promise<void> {
  await updateTrack(ctx, trackId, {
    state,
    ...(extra.note === undefined ? {} : { note: extra.note }),
    ...(extra.error === undefined ? {} : { error: extra.error }),
  });
}

/** True when the caller should stop what it is doing right now. */
export function aborted(ctx: StepContext): boolean {
  return ctx.signal?.aborted === true;
}

/** A cancellable sleep: a shutdown must not have to wait out a fifteen-second jitter. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolveSleep();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });
}
