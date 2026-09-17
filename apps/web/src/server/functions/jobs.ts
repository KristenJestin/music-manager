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
import { MMError, type JobEventPayload } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STEPS, type ImportStatus, type StepName } from "#/server/db/schema/enums.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { readEvents, readLatestEvents } from "#/server/services/events.ts";
import {
  bumpImport,
  cancelImport,
  forgetMapping,
  pauseImport,
  requeueUpstreamFailures,
  resetTrack,
  resumeStepOf,
  rewindTo,
  type BumpResult,
} from "#/server/services/jobs/index.ts";
import { requireImport } from "#/server/services/jobs/context.ts";
import {
  collapseParkedDuplicates,
  countParkedDuplicates,
  type CollapseResult,
} from "#/server/services/imports.reuse.ts";
import { forgetsMapping, retryOptionsFor } from "#/server/services/retry-plan.ts";
import { pageInfo } from "#/server/api/paging.ts";
import {
  countJobs,
  jobCounts,
  jobDetail,
  jobProgress,
  listJobs,
  stepResult,
  type DashboardStats,
  type JobDetail,
  type JobSummary,
} from "#/server/services/console.queries.ts";
import { enqueue, enqueueAll } from "#/server/services/queue.ts";
import { confirmProposed } from "#/server/services/confirm.ts";
import { adoptTrackFile as adoptFile } from "#/server/services/adopt.ts";

const statusFilter = z.enum([
  "all",
  "active",
  "pending",
  "running",
  "awaiting_confirm",
  "awaiting_review",
  "paused",
  "waiting_upstream",
  "done",
  "failed",
  "cancelled",
]);

export type JobStatusFilter = z.infer<typeof statusFilter>;

/**
 * Rows per page of `/imports`.
 *
 * Fifty, like `/api/v1`'s default and like the library's sixty: enough that the first page is
 * the answer most of the time, few enough that the five follow-up queries `listJobs` runs are
 * keyed on fifty ids and not on the whole table. The page never grows with the table, which is
 * the whole of the performance requirement.
 */
export const JOBS_PAGE_SIZE = 50;

export interface JobListPayload {
  readonly jobs: readonly JobSummary[];
  /** Unfiltered totals, so the chips say how big each set is, not how big this page is. */
  readonly counts: Record<ImportStatus | "all" | "active", number>;
  /** Imports matching the current chip, before paging. */
  readonly total: number;
  readonly hasMore: boolean;
  readonly page: number;
  readonly pageSize: number;
  /**
   * How many parked imports a collapse would cancel as redundant siblings.
   *
   * Unfiltered, like `counts`: the offer to tidy up is about the table, not about the page.
   * Zero on a healthy installation, and the button is not drawn at all then.
   */
  readonly parkedDuplicates: number;
}

export const fetchJobs = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      // `active` and not `all`: see the route. The default lives here too so that a caller
      // that omits the filter — the palette, a test — gets the same view the page shows.
      status: statusFilter.default("active"),
      page: z.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ data }): Promise<JobListPayload> => {
    try {
      const offset = data.page * JOBS_PAGE_SIZE;
      const [jobs, total, counts, parkedDuplicates] = await Promise.all([
        listJobs({ status: data.status, limit: JOBS_PAGE_SIZE, offset }),
        countJobs(data.status),
        jobCounts(),
        countParkedDuplicates(db()),
      ]);
      return {
        jobs,
        counts,
        ...pageInfo(total, offset, JOBS_PAGE_SIZE),
        page: data.page,
        pageSize: JOBS_PAGE_SIZE,
        parkedDuplicates,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * The moving parts of the rows already on screen — status, step, tracks — and nothing else.
 *
 * The Jobs list keeps a live stream open (`/api/events`) and asks for this when the journal
 * says one of its rows moved. It is deliberately *not* `fetchJobs`: re-running the loader
 * would re-sort and re-page the table under the reader's cursor every time a track finished,
 * which is the opposite of the calm the page is supposed to have. This reads one indexed
 * lookup and one grouped tally over the fifty ids on screen, and the row keeps its place.
 */
export interface JobProgress {
  readonly id: string;
  readonly status: ImportStatus;
  readonly step: StepName;
  readonly tracksDone: number;
  readonly tracksTotal: number;
  readonly updatedAt: string;
}

export const fetchJobProgress = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ ids: z.array(z.string().min(1)).max(200) }))
  .handler(async ({ data }): Promise<readonly JobProgress[]> => {
    try {
      if (data.ids.length === 0) return [];
      return await jobProgress(data.ids, db());
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
      const [match, latest] = await Promise.all([
        stepResult(data.id, "match"),
        // Newest 500 first, then back to chronological order: a job with a longer journal
        // than that must never lose the end of its own history the way `since: 0, limit: 500`
        // silently did (it always returned the *oldest* 500 lines).
        readLatestEvents({ importId: data.id, limit: 500 }),
      ]);
      const events = [...latest].reverse();
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

/**
 * Retry an import, from its resume point or from a step the reader chose.
 *
 * The `step` parameter has been here since P03 and nothing in the Console ever sent one, so a
 * finished album could only be retried from `verify` — the resume point of a job whose every step
 * finished — and a re-match meant `mm retry --step match` in a terminal. The menu on the Retry
 * button sends it now.
 *
 * A chosen step is **checked against `retryOptionsFor`**, the same list the menu drew, rather
 * than against `STEPS`: `place` on an import that has never downloaded is a request the machine
 * can honour and a person cannot have meant, and a 400 naming what is on offer is a better answer
 * than a step that fails three seconds later for a reason nobody can read.
 *
 * `forgetMapping` is what makes "Match again" mean anything — see its own note.
 */
export const retryJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), step: stepName.optional() }))
  .handler(async ({ data }): Promise<{ step: StepName; forgotMapping: boolean }> => {
    try {
      /*
       * Only a *chosen* step discards anything.
       *
       * The plain Retry means "run it again as it is", and a job that failed at `match` with a
       * supplied mapping is retried by re-applying that mapping — which is what it has always
       * done and what somebody pressing a button with no menu open expects. "Match again" is the
       * deliberate gesture, and the dialog says what it costs before it happens.
       */
      let from: StepName;
      let chosen = false;
      if (data.step === undefined) {
        from = await resumeStepOf(data.id, db());
      } else {
        chosen = true;
        const job = await requireImport(data.id, db());
        const offered = retryOptionsFor(job);
        if (!offered.some((option) => option.step === data.step)) {
          throw new MMError(
            "INVALID_INPUT",
            `This import cannot be retried from \`${data.step}\`.`,
            {
              hint:
                offered.length === 0
                  ? "A cancelled import has no step to retry."
                  : `It has reached ${job.step}. On offer: ${offered.map((o) => o.step).join(", ")}.`,
              status: 400,
            },
          );
        }
        from = data.step;
      }

      // Before the rewind, not after: a worker that picked the job up between the two would
      // otherwise run `match` against the mapping this retry exists to discard.
      const forgotMapping = chosen && forgetsMapping(from);
      if (forgotMapping) await forgetMapping(data.id, db());

      // Rewind the step rows without running anything here: the worker owns execution, and a
      // download started inside an HTTP request would die with the request — or, worse, race
      // the worker's own download for the toolbox's single slot (owner review C3).
      await rewindTo(data.id, from, db());
      await enqueue(data.id, "console retry", from);
      return { step: from, forgotMapping };
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
 * Requeue every import a source killed — the outage, in one button.
 *
 * The Console's other retries are all "this one, now". After a source outage that shape is
 * wrong: the failures are not related to each other except in *why*, and there may be forty-
 * five of them. The selection is `classifyFailure`'s, so what this button does is exactly what
 * the machine would have done on its own had the rule existed at the time — and a 404 or a
 * parse error is never swept up with them.
 *
 * Idempotent: a requeued import is no longer `failed`, so pressing it twice requeues nothing.
 */
export const retryFailedUpstream = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<{ requeued: number; sources: readonly string[] }> => {
    try {
      const planned = await requeueUpstreamFailures({}, db());
      await enqueueAll(
        planned.map((job) => ({ importId: job.id, step: job.restartAt })),
        "console retry failed-upstream",
      );
      const sources = [
        ...new Set(
          planned.map((job) => job.source).filter((name): name is string => name !== null),
        ),
      ];
      return { requeued: planned.length, sources };
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

/**
 * Adopt a local file as one track's source, from the Console.
 *
 * The Console's half of `POST /api/v1/imports/{id}/tracks/{trackId}/file`, and it reaches the
 * same `adoptTrackFile` service, so the refusals, the allow-list and the provenance are one
 * implementation rather than three.
 *
 * The browser sends the bytes base64 in the RPC body rather than as a multipart upload: the
 * app has no multipart parser, every other boundary in it is a zod schema, and the one
 * existing file input in the Console (`settings/integrations`, the backup import) already
 * reads the file in the browser and posts its contents. `MAX_ADOPT_UPLOAD_BYTES` is the cap on
 * the decoded bytes, checked again in the service — the dialog only checks it to give a
 * faster, kinder answer than a rejected request.
 */
export const adoptTrackFile = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      id: z.string().min(1),
      trackId: z.string().min(1),
      source: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("path"), path: z.string().min(1) }),
        z.object({
          kind: z.literal("upload"),
          filename: z.string().min(1),
          content: z.string().min(1),
        }),
      ]),
    }),
  )
  .handler(
    async ({ data }): Promise<{ path: string; originalName: string; nextStep: string | null }> => {
      try {
        const result = await adoptFile({
          importId: data.id,
          trackId: data.trackId,
          source:
            data.source.kind === "path"
              ? { kind: "path", path: data.source.path }
              : {
                  kind: "upload",
                  filename: data.source.filename,
                  bytes: new Uint8Array(Buffer.from(data.source.content, "base64")),
                },
          adoptedBy: "console",
          db: db(),
        });
        return {
          path: result.path,
          originalName: result.originalName,
          nextStep: result.nextStep,
        };
      } catch (error) {
        return toFailure(error);
      }
    },
  );

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

/**
 * "Yes, the mapping as shown" — the answer an import parked at `awaiting_confirm` was waiting
 * for, and which the Console had no way of giving.
 *
 * `confirm` is the one deliberately blocking step of the pipeline, and confirming it was
 * possible from `/api/v1`, MCP and `mm` and from nowhere in the browser: the wizard opens the
 * gate inside its own flow, before the import ever reaches this state, so every import that
 * got here another way — a batch, a watched source, a job re-matched after an Inbox answer —
 * sat with a Retry button and a Cancel button and no way to say yes.
 *
 * It supplies nothing and re-runs nothing: `services/confirm.ts` opens the gate signed
 * `console`, answers the `awaiting_confirm` Inbox item if one is open, and hands the job back
 * to the worker. The `decisions` row is written by `confirmStep`, exactly as it is for the
 * wizard, for `--yes` and for the API.
 */
export const confirmJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ mapped: number; status: ImportStatus }> => {
    try {
      const { job, mapped } = await confirmProposed(data.id, "console", db());
      return { mapped, status: job.status };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Collapse the parked duplicates of the whole table — the owner's 204 rows, in one press.
 *
 * A dry run unless `apply` is set, and the Console uses both: the page asks for the count on
 * every load (`parkedDuplicates`), and the button applies. The guard is
 * `services/imports.reuse.ts`'s and is deliberately narrow — only imports that are `paused`,
 * not by the worker, no further than `match`, and with **no track that has done any work**;
 * never the newest of a URL, so every URL keeps one.
 */
export const collapseParkedImports = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({ url: z.string().min(1).optional(), apply: z.boolean().default(false) }),
  )
  .handler(async ({ data }): Promise<CollapseResult> => {
    try {
      return await collapseParkedDuplicates({
        apply: data.apply,
        db: db(),
        ...(data.url === undefined ? {} : { url: data.url }),
      });
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

/**
 * Move an import up the queue.
 *
 * The `enqueue` that used to follow `bumpImport` here is **gone**, and its absence is the fix:
 * it sent a message unconditionally, so every bump of an import that already had one left two.
 * `bumpImport` now asks pg-boss's own ledger what the import holds and either edits that message
 * or sends the first one — see `reprioritiseImport`. What it did comes back in `queue` and goes
 * into the journal, so "bumped" is no longer a claim nobody can check.
 */
export const bumpJob = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), by: z.number().int().default(10) }))
  .handler(async ({ data }): Promise<BumpResult> => {
    try {
      return await bumpImport(data.id, data.by, db());
    } catch (error) {
      return toFailure(error);
    }
  });

export type { DashboardStats };
