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
import { pathMap, type PathMap } from "#/server/paths.ts";
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
  /** The videos bound to a MusicBrainz track, in tracklist order. */
  mappedTracks(): Promise<ImportTrack[]>;
}

export interface ContextOptions {
  readonly db?: Database;
  readonly toolbox?: ToolboxClient;
  readonly settings?: Settings;
  readonly signal?: AbortSignal;
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

  return {
    db,
    toolbox: options.toolbox ?? defaultToolbox(),
    settings,
    paths: resolvePaths(settings),
    fixtures: serverEnv().MM_FIXTURES,
    job,
    step,
    signal: options.signal,
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
      const rows = await db
        .select()
        .from(importTracks)
        .where(and(eq(importTracks.importId, importId), eq(importTracks.role, "mapped")))
        .orderBy(asc(importTracks.trackPosition));
      return rows;
    },
  };
}

/** Patch one import track and stamp `updated_at`. */
export async function updateTrack(
  ctx: StepContext,
  trackId: string,
  patch: Partial<Omit<ImportTrack, "id" | "importId" | "createdAt">>,
): Promise<void> {
  await ctx.db
    .update(importTracks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(importTracks.id, trackId));
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
