/**
 * The `retag` queue, and the two things that feed it (`docs/03-metadonnees.md` §8).
 *
 * **One job is one batch, not one run.** A library-wide re-tag can be thousands of files;
 * a single queue job that took all of them would be invisible while it ran, uncancellable
 * until it finished, and lost entirely if the worker were restarted. So a job re-tags
 * `retagBatchSize` files, writes their diffs, and — if there is more — sends itself back to
 * the queue. Progress is in the run row, cancellation is a status change the next batch
 * notices, and a worker killed mid-run resumes from the diffs it already wrote.
 *
 * The queue's policy is `standard` rather than `singleton`, and the `singletonKey` is the run
 * id: two different runs may be in flight (a dry run of one album while the library catches
 * up, say), but the same run can never be advanced twice at once.
 *
 * Two triggers besides a person pressing the button:
 *
 *  - **`retag.outdated`** — asked for at worker start and by the nightly cron. It compares the
 *    stored `tag_schema_version` of every library file with the one this installation projects
 *    to and, if anything is behind, opens a run over exactly those files. That is the whole of
 *    "bump the version and the library catches up".
 *  - **`sources.refresh`** — the weekly cron of §8. It re-fetches the MusicBrainz releases we
 *    hold and queues a re-tag for the albums whose payload actually changed. The comparison is
 *    on the payload rather than on MusicBrainz's `last-updated`, because that timestamp moves
 *    for edits that change nothing we project, and a re-tag nobody needs is still a write to
 *    every file of an album.
 */
import type { Job, PgBoss } from "pg-boss";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { libraryAlbums } from "#/server/db/schema/index.ts";
import { emit } from "#/server/services/events.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import { get as cacheGet } from "#/server/services/cache.ts";
import { filesBehindCount } from "#/server/services/quality.ts";
import { createRun, runBatch } from "#/server/services/retag.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { QUEUES } from "../queues.ts";
import { isNotNull } from "drizzle-orm";

export interface RetagJob {
  readonly runId: string;
}

/** Put a run (or the next slice of one) on the queue. */
export async function enqueueRetag(
  boss: PgBoss,
  job: RetagJob,
  options: { priority?: number } = {},
): Promise<string | null> {
  return await boss.send(QUEUES.retag, job, {
    singletonKey: job.runId,
    priority: options.priority ?? 0,
    retryLimit: 0,
    // A batch of twenty-five files against a local toolbox is seconds; an hour is a ceiling,
    // not an expectation, and it stops a wedged batch from blocking its run for ever.
    expireInSeconds: 60 * 60,
  });
}

/**
 * Open a run over everything behind the current schema, unless there is nothing to do.
 *
 * Returns the run id, or `null` when the library is already current — which is the normal
 * answer on every start after the first, and is deliberately not an event: a worker that
 * announced "0 files behind" on every boot would be noise in the one journal people read.
 */
export async function queueOutdated(
  boss: PgBoss,
  options: { db?: Database; trigger?: "schema" | "cron" } = {},
): Promise<string | null> {
  const db = options.db ?? defaultDb();
  const settings = await loadSettings(db);
  const behind = await filesBehindCount({ db, settings });
  if (behind.behind === 0) return null;

  const run = await createRun({
    db,
    settings,
    scope: "library",
    onlyBehind: true,
    trigger: options.trigger ?? "schema",
  });
  await enqueueRetag(boss, { runId: run.id });
  return run.id;
}

/**
 * The weekly source refresh.
 *
 * It only ever *reads* upstream — the re-tag that follows is still offline, because the
 * refreshed answer went into the raw cache and the raw cache is where the projection comes
 * from. That separation is the point: the network is touched once per release per week, and
 * never by the thing that writes files.
 */
export async function refreshSources(
  boss: PgBoss,
  options: { db?: Database; limit?: number } = {},
): Promise<{ checked: number; changed: number; runId: string | null }> {
  const db = options.db ?? defaultDb();
  const settings = await loadSettings(db);
  if (!settings.sourcesRefreshEnabled) return { checked: 0, changed: 0, runId: null };

  const albums = await db
    .select({ id: libraryAlbums.id, releaseMbid: libraryAlbums.releaseMbid })
    .from(libraryAlbums)
    .where(isNotNull(libraryAlbums.releaseMbid))
    .limit(options.limit ?? 200);

  const ctx = { db, config: sourcesConfig(settings), offline: false, refresh: true };
  const changedAlbums: string[] = [];
  let checked = 0;

  for (const album of albums) {
    const mbid = album.releaseMbid;
    if (mbid === null || mbid === "") continue;
    checked += 1;
    try {
      const before = await cacheGet<unknown>("musicbrainz", `release/${mbid}`, db);
      const after = await musicbrainz.lookupRelease(ctx, mbid);
      if (before === null || after.data === null) continue;
      if (JSON.stringify(before.data) !== JSON.stringify(after.data)) changedAlbums.push(album.id);
    } catch (error) {
      // One release being unreachable must not stop the sweep; it will be tried again in a
      // week, and the album is no worse off than before.
      await emit(
        {
          type: "sources.refresh",
          level: "warn",
          message: `Could not refresh release ${mbid}: ${MMError.from(error).message}`,
        },
        db,
      );
    }
  }

  if (changedAlbums.length === 0) {
    await emit(
      {
        type: "sources.refresh",
        message: `Source refresh: ${String(checked)} release(s) checked, none changed.`,
        data: { checked },
      },
      db,
    );
    return { checked, changed: 0, runId: null };
  }

  // One run per affected album rather than one library-wide run: the albums that changed are
  // the ones a person will want to look at, and a run scoped to an album is what the album
  // page can show.
  let firstRun: string | null = null;
  for (const albumId of changedAlbums) {
    const run = await createRun({
      db,
      settings,
      scope: "album",
      targetId: albumId,
      onlyBehind: false,
      trigger: "sources",
    });
    await enqueueRetag(boss, { runId: run.id });
    firstRun ??= run.id;
  }

  await emit(
    {
      type: "sources.refresh",
      message: `Source refresh: ${String(checked)} release(s) checked, ${String(changedAlbums.length)} changed upstream and queued for a re-tag.`,
      data: { checked, changed: changedAlbums.length },
    },
    db,
  );

  return { checked, changed: changedAlbums.length, runId: firstRun };
}

/** Register the `retag` consumer and the weekly source refresh on a running boss. */
export async function registerRetagHandlers(
  boss: PgBoss,
  options: {
    signal?: AbortSignal;
    log?: (message: string, extra?: Record<string, unknown>) => void;
  },
): Promise<void> {
  const say = options.log ?? ((): void => undefined);

  await boss.work<RetagJob>(
    QUEUES.retag,
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async (jobs: Job<RetagJob>[]) => {
      for (const job of jobs) {
        const { runId } = job.data;
        const result = await runBatch(runId, {
          db: defaultDb(),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        say("retag batch", {
          runId,
          processed: result.processed,
          remaining: result.remaining,
          finished: result.finished,
        });
        if (!result.finished) await enqueueRetag(boss, { runId });
      }
    },
  );

  await boss.work("cron.refresh-sources", { localConcurrency: 1 }, async (jobs: Job<object>[]) => {
    for (const _job of jobs) {
      void _job;
      const result = await refreshSources(boss, { db: defaultDb() });
      say("sources refreshed", { ...result });
    }
  });
}
