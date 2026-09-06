/**
 * Jobs: the list, one job, its journal, and the four controls.
 *
 * Every function here carries `sessionMiddleware`, so none of them answers without a session.
 * The controls are thin on purpose — `retry`, `pause`, `cancel` and `bump` already exist in
 * `jobs.service` and already write the journal lines the SSE stream carries, so the Console's
 * job is to call them and get out of the way, not to reimplement what "retry" means.
 *
 * `retry` and `resume` also put the job back on a queue. Without that the row would say
 * `running` and nothing would be running it, which is the one failure mode a job page must
 * never show.
 */
import { z } from "zod";
import type { JobEventPayload } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STEPS, type ImportStatus, type StepName } from "#/server/db/schema/enums.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { readEvents } from "#/server/services/events.ts";
import {
  bumpImport,
  cancelImport,
  pauseImport,
  resetTrack,
  resumeStepOf,
  rewindTo,
} from "#/server/services/jobs/index.ts";
import {
  jobCounts,
  jobDetail,
  listJobs,
  stepResult,
  type DashboardStats,
  type JobDetail,
  type JobSummary,
} from "#/server/services/console.queries.ts";
import { enqueue } from "#/server/services/queue.ts";

const statusFilter = z.enum([
  "all",
  "active",
  "pending",
  "running",
  "awaiting_confirm",
  "awaiting_review",
  "paused",
  "done",
  "failed",
  "cancelled",
]);

export type JobStatusFilter = z.infer<typeof statusFilter>;

export interface JobListPayload {
  readonly jobs: readonly JobSummary[];
  readonly counts: Record<ImportStatus | "all" | "active", number>;
}

export const fetchJobs = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ status: statusFilter.default("all") }))
  .handler(async ({ data }): Promise<JobListPayload> => {
    try {
      const [jobs, counts] = await Promise.all([
        listJobs({ status: data.status, limit: 100 }),
        jobCounts(),
      ]);
      return { jobs, counts };
    } catch (error) {
      return toFailure(error);
    }
  });

export interface JobPagePayload extends JobDetail {
  /** What `match` decided, so the detail page can show the release without asking MusicBrainz. */
  readonly match: Record<string, unknown> | null;
  /** The journal so far. The SSE stream takes over from the last id. */
  readonly events: readonly JobEventPayload[];
}

export const fetchJob = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<JobPagePayload | null> => {
    try {
      const detail = await jobDetail(data.id);
      if (detail === null) return null;
      const [match, events] = await Promise.all([
        stepResult(data.id, "match"),
        readEvents({ importId: data.id, since: 0, limit: 500 }),
      ]);
      return { ...detail, match, events };
    } catch (error) {
      return toFailure(error);
    }
  });

/** More journal, for a page that was open across a reload or a long gap. */
export const fetchJobEvents = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), since: z.number().int().min(0).default(0) }))
  .handler(async ({ data }): Promise<readonly JobEventPayload[]> => {
    try {
      return await readEvents({ importId: data.id, since: data.since, limit: 500 });
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* controls                                                            */
/* ------------------------------------------------------------------ */

const stepName = z.enum(STEPS);

export const retryJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), step: stepName.optional() }))
  .handler(async ({ data }): Promise<{ step: StepName }> => {
    try {
      const from = data.step ?? (await resumeStepOf(data.id, db()));
      // Rewind the step rows without running anything here: the worker owns execution, and a
      // download started inside an HTTP request would die with the request — or, worse, race
      // the worker's own download for the toolbox's single slot (owner review C3).
      await rewindTo(data.id, from, db());
      await enqueue(data.id, "console retry", from);
      return { step: from };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Retry the most recent failed import — the palette's "Retry last failed".
 *
 * The prototype's ⌘K carries *actions*, not only navigation, and this is the one that saves
 * the most walking: a failure is discovered from a notification or from the Inbox, and the
 * answer is almost always "run it again". Returns `null` when nothing has failed, so the
 * palette can say so instead of pretending it did something.
 *
 * `rewindTo` and not `retryStep`, like every other caller: the palette entry landed on `main`
 * while this branch was removing the last of them, and `retryStep` ends in `runImport` — so a
 * ⌘K away from the job page would have started a download inside an HTTP request, beside the
 * worker, for the toolbox's single slot. That is the owner's C3, one keystroke further away.
 */
export const retryLastFailed = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ importId: string; step: StepName } | null> => {
    try {
      const [summary] = await listJobs({ status: "failed", limit: 1 }, db());
      if (summary === undefined) return null;
      const id = summary.job.id;
      const from = await resumeStepOf(id, db());
      await rewindTo(id, from, db());
      await enqueue(id, "palette retry", from);
      return { importId: id, step: from };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Retry **one track**, not the whole album (owner review C6).
 *
 * A single video that lost a bot check, or whose file was removed behind our back, used to
 * cost a re-run of the entire import — and the owner had no button for it at all, only a
 * track sitting at `failed` with no visible reason. This puts that one row back to
 * "not downloaded", rewinds the job to `download` and queues it: every other track keeps its
 * file, and `download` skips the ones that are already on disk.
 */
export const retryTrack = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), trackId: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ step: StepName }> => {
    try {
      await resetTrack(data.id, data.trackId, db());
      await rewindTo(data.id, "download", db());
      await enqueue(data.id, "console retry track", "download");
      return { step: "download" };
    } catch (error) {
      return toFailure(error);
    }
  });

export const resumeJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ step: StepName }> => {
    try {
      const step = await resumeStepOf(data.id, db());
      await enqueue(data.id, "console resume", step);
      return { step };
    } catch (error) {
      return toFailure(error);
    }
  });

export const pauseJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await pauseImport(data.id, "Paused from the Console.", db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const cancelJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await cancelImport(data.id, db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const bumpJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), by: z.number().int().default(10) }))
  .handler(async ({ data }): Promise<{ priority: number }> => {
    try {
      const priority = await bumpImport(data.id, data.by, db());
      await enqueue(data.id, "console bump");
      return { priority };
    } catch (error) {
      return toFailure(error);
    }
  });

export type { DashboardStats };
