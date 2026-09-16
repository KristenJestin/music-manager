/**
 * `/api/v1/imports` — everything an agent needs to run the pipeline.
 *
 * Every handler calls the **service layer** and nothing else. That is the rule of
 * `docs/phases/P08-api-agents.md`, and it is what makes "an agent sees the same candidates and
 * the same Inbox as you" (`docs/01-vision-et-principes.md` §8) true by construction rather
 * than by diligence: `POST /imports` and the Console's paste box reach `createFromUrl` by
 * different doors into the same room.
 *
 * The one place this file has logic of its own is `POST /{id}/confirm-mapping`, and it is a
 * transcription of the wizard's step 4 rather than an invention — same `SuppliedMapping`, same
 * synchronous `match`, same hand-off to the worker. The comments there say which lines are
 * load-bearing.
 *
 * `POST /batch` and `POST /{id}/confirm-best` deliberately have none of their own: they are
 * `services/imports.bulk.ts`, which the MCP tools and the CLI call too. The mapping
 * `confirm-best` confirms has to be the same mapping however it was asked for, and three
 * transcriptions of one algorithm is how that stops being true.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import type { Import, ImportStatus, StepName } from "#/server/db/schema/index.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { confirmBest, createImportsBatch, MAX_BATCH_URLS } from "#/server/services/imports.bulk.ts";
import {
  bumpImport,
  cancelImport,
  countImports,
  listImports,
  pauseImport,
  requeueUpstreamFailures,
  rewindTo,
  runStep,
} from "#/server/services/jobs/index.ts";
import { jobDetail, setImportOptions } from "#/server/services/console.queries.ts";
import { hintsFor, rankFor, videosOf } from "#/server/services/matching.queries.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { enqueue, enqueueAll } from "#/server/services/queue.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  batchImportSchema,
  batchResultSchema,
  candidatesSchema,
  confirmBestResultSchema,
  confirmBestSchema,
  confirmMappingSchema,
  createImportSchema,
  errorSchema,
  idParam,
  importDetailSchema,
  type importOptionsSchema,
  importSchema,
  listImportsQuery,
  bulkRetrySchema,
  bulkRetryResultSchema,
  pageFields,
  pageInfo,
  retryStepSchema,
} from "#/server/api/schemas.ts";

/** `low | normal | next` as the priority column stores it. Same three as the wizard. */
const PRIORITY: Record<"low" | "normal" | "next", number> = { low: -10, normal: 0, next: 100 };

const TAG = "imports";

/** Responses every route in this file may produce. Declared once so the document is uniform. */
const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad input" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "No such import" },
} as const;

/** One row, flattened for the wire. Dates become RFC 3339 strings; the error becomes its body. */
function toImport(job: Import): z.infer<typeof importSchema> {
  return {
    id: job.id,
    url: job.url,
    kind: job.kind,
    status: job.status,
    step: job.step,
    title: job.title,
    artist: job.artist,
    year: job.year,
    releaseMbid: job.releaseMbid,
    priority: job.priority,
    error: job.error === null ? null : MMError.fromBody(job.error).toBody(),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function importRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  /* ---- list ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "List imports, newest first",
      description:
        "**Paged.** `limit` (1–200, default 50) and `offset` (default 0) are how you reach " +
        "anything older than the first page — this route is not a feed of the fifty most " +
        "recent imports, it only looks like one when they are left out. `total` is the number " +
        "of imports matching `status` and `q` *before* paging, and `hasMore` is true while " +
        "another page exists, so walking the whole list is `offset += limit` until `hasMore` " +
        "is false.",
      middleware: [requireScope("imports:read")] as const,
      request: { query: listImportsQuery },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ imports: z.array(importSchema), ...pageFields }),
            },
          },
          description: "The imports, and how many there are in total",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { limit, offset, status, q } = c.req.valid("query");
      // `status` and `q` both narrow in SQL now, so the page and the total describe one set.
      const filter = {
        ...(status === undefined || status === "all" ? {} : { status: status as ImportStatus }),
        ...(q === undefined ? {} : { q }),
      };
      const [rows, total] = await Promise.all([
        listImports({ ...filter, limit, offset }, db()),
        countImports(filter, db()),
      ]);
      return c.json({ imports: rows.map(toImport), ...pageInfo(total, offset, limit) }, 200);
    },
  );

  /* ---- create ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: [TAG],
      summary: "Create an import from a URL",
      description:
        "Resolves the source in-process so the answer is immediate, then hands the job to the " +
        "worker. It does **not** run the pipeline in this request: the download slot is global " +
        "and one worker owns it.\n\n" +
        "**Breaking change.** The import's fields are now at the top level of the answer, next " +
        "to `duplicates`, where they used to be wrapped in an `import` object. Every other " +
        "route returning a single object was already flat; this one was the exception, and a " +
        "client that had to remember which was which got it wrong. Read `id`, not " +
        "`import.id`.\n\n" +
        "Creating many at once is `POST /imports/batch` — a hundred of these is a hundred " +
        "round trips.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        body: { content: { "application/json": { schema: createImportSchema } }, required: true },
      },
      responses: {
        201: {
          content: {
            "application/json": {
              schema: importSchema.extend({ duplicates: z.array(z.string()) }),
            },
          },
          description: "Created and queued",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const options: Partial<z.infer<typeof importOptionsSchema>> = body.options ?? {};
      const created = await createFromUrl(body.url, {
        db: db(),
        ...(body.releaseMbid === null || body.releaseMbid === undefined
          ? {}
          : { releaseMbid: body.releaseMbid }),
        ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
        ...(options.lyrics === undefined ? {} : { lyrics: options.lyrics }),
        ...(options.replaygain === undefined ? {} : { replaygain: options.replaygain }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.autoConfirm === undefined ? {} : { autoConfirm: options.autoConfirm }),
        // Whoever opens the confirmation gate signs it. `POST /imports` is `api`, even when
        // the `mm` CLI is what is talking to it in `--remote` mode: the audit trail records
        // the door the decision came through, and this is that door.
        ...(options.autoConfirm === true ? { confirmedBy: "api" } : {}),
      });
      if (body.priority !== "normal") {
        await setImportOptions(created.job.id, {}, { priority: PRIORITY[body.priority] }, db());
      }
      await enqueue(created.job.id, "api");
      const fresh = (await getImport(created.job.id, db())) ?? created.job;
      return c.json(
        { ...toImport(fresh), duplicates: created.duplicates.map((row) => row.id) },
        201,
      );
    },
  );

  /* ---- batch create ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/batch",
      tags: [TAG],
      summary: "Create many imports in one call",
      description:
        `Takes up to **${String(MAX_BATCH_URLS)} URLs** and creates one import per URL, in ` +
        "order. Over that limit the call is a 400 naming the cap; split the list.\n\n" +
        "**One bad URL loses only itself.** Each entry of `results` carries either an `id` or " +
        "an `error` in the app's usual `{code, message, hint}` shape, at the `index` it was " +
        "sent — a scheme this app cannot import does not cost you the other ninety-nine. " +
        "`ids` is the created ids in request order, which is the list to hand to " +
        "`POST /imports/{id}/confirm-best` afterwards.\n\n" +
        "**Unlike `POST /imports`, a batch does not resolve in-process.** A hundred " +
        "extractions would be minutes of a held connection; the rows come back `pending` at " +
        "step `resolve` and the worker resolves them. Poll `GET /imports?status=awaiting_review` " +
        "to find the ones that need a decision.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        body: { content: { "application/json": { schema: batchImportSchema } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: batchResultSchema } },
          description: "Every URL's outcome, in the order they were sent",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const options: Partial<z.infer<typeof importOptionsSchema>> = body.options ?? {};
      const outcome = await createImportsBatch({
        urls: body.urls,
        db: db(),
        source: "api batch",
        options: {
          ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
          ...(options.lyrics === undefined ? {} : { lyrics: options.lyrics }),
          ...(options.replaygain === undefined ? {} : { replaygain: options.replaygain }),
          ...(options.force === undefined ? {} : { force: options.force }),
          ...(options.autoConfirm === undefined ? {} : { autoConfirm: options.autoConfirm }),
          // Same rule as the single route: whoever opens the confirmation gate signs it.
          ...(options.autoConfirm === true ? { confirmedBy: "api" } : {}),
          ...(body.priority === "normal" ? {} : { priority: PRIORITY[body.priority] }),
        },
      });
      return c.json(outcome as z.infer<typeof batchResultSchema>, 200);
    },
  );

  /* ---- one ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: [TAG],
      summary: "One import, with its steps, tracks and open Inbox items",
      middleware: [requireScope("imports:read")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: { "application/json": { schema: importDetailSchema } },
          description: "The import",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const detail = await jobDetail(c.req.valid("param").id, db());
      if (detail === null) throw notFound(c.req.valid("param").id);
      return c.json(
        {
          ...toImport(detail.job),
          steps: detail.steps.map(({ step, row }) => ({
            step,
            status: row?.status ?? "pending",
            message: row?.message ?? null,
            startedAt: row?.startedAt?.toISOString() ?? null,
            finishedAt: row?.finishedAt?.toISOString() ?? null,
          })),
          tracks: detail.tracks.map((track) => ({
            id: track.id,
            position: track.position,
            videoId: track.videoId,
            title: track.sourceTitle,
            durationSeconds: track.sourceDuration,
            status: track.state,
          })),
          inbox: detail.inbox.map((item) => ({
            id: item.id,
            type: item.type,
            title: item.title,
            status: item.status,
          })),
        },
        200,
      );
    },
  );

  /* ---- candidates ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/candidates",
      tags: [TAG],
      summary: "The ranked MusicBrainz candidates for this import",
      description:
        "The same ranking, budget and preselection the Console's wizard shows at step 2 — " +
        "computed, not persisted, so asking decides nothing.",
      middleware: [requireScope("imports:read")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: { "application/json": { schema: candidatesSchema } },
          description: "The candidates",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const job = await getImport(id, db());
      if (job === null) throw notFound(id);
      const settings = await loadSettings(db());
      const result = await rankFor({ job, settings, db: db() });
      const { videos } = await videosOf(job.id, db());
      const hints = hintsFor(job, videos);
      const preselected = result.ranking.preselected;
      const shown = result.ranking.candidates.slice(0, 12);
      return c.json(
        {
          kind: result.kind,
          releases: result.kind === "album" ? (shown as unknown as Record<string, unknown>[]) : [],
          recordings:
            result.kind === "single" ? (shown as unknown as Record<string, unknown>[]) : [],
          preselectedId: preselected?.id ?? null,
          safe: preselected?.safe ?? false,
          ambiguous: result.ranking.ambiguous,
          margin: result.ranking.margin,
          budget: result.budget,
          hints: { album: hints.album ?? null, artist: hints.artist ?? null },
        },
        200,
      );
    },
  );

  /* ---- confirm-mapping ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/confirm-mapping",
      tags: [TAG],
      summary: "Choose the release and the video → track mapping, then start",
      description:
        "The API's equivalent of pressing Start in the wizard. `releaseMbid: null` is not " +
        "'unknown' — it is the deliberate *import without MusicBrainz*, which builds the " +
        "document from the source's own tags and flags the album `untagged`.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: confirmMappingSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                import: importSchema,
                mapped: z.number(),
                extras: z.number(),
                uncovered: z.number(),
              }),
            },
          },
          description: "Mapped and queued",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const body = c.req.valid("json");
      const job = await getImport(id, db());
      if (job === null) throw notFound(id);

      const mapping: SuppliedMapping = {
        releaseMbid: body.releaseMbid,
        releaseGroupMbid: body.releaseGroupMbid,
        ...(body.album === "" ? {} : { album: body.album }),
        ...(body.albumArtist === "" ? {} : { albumArtist: body.albumArtist }),
        year: body.year,
        trackTotal: body.trackTotal,
        // `SuppliedMapping` spells "absent" where the wire spells `null`; only one of the two
        // survives `exactOptionalPropertyTypes`.
        tracks: body.bindings.map((binding) => ({
          position: binding.position,
          trackPosition: binding.trackPosition,
          mediumPosition: binding.mediumPosition,
          recordingMbid: binding.recordingMbid,
          trackTitle: binding.trackTitle,
          confidence: binding.confidence,
          ...(binding.trackMbid === null ? {} : { trackMbid: binding.trackMbid }),
        })),
      };
      const options: Partial<z.infer<typeof importOptionsSchema>> = body.options ?? {};

      await setImportOptions(
        id,
        {
          mapping,
          releaseMbid: body.releaseMbid,
          fingerprint: options.fingerprint ?? true,
          lyrics: options.lyrics ?? true,
          replaygain: options.replaygain ?? true,
          force: options.force ?? false,
          // Supplying a mapping *is* the confirmation. Blocking on `confirm` afterwards would
          // ask the caller a question it has just answered in the body of this request.
          autoConfirm: true,
          confirmedBy: "api",
        },
        { priority: PRIORITY[body.priority], releaseMbid: body.releaseMbid },
        db(),
      );

      // `match` runs here rather than on the worker for the same reason the wizard runs it
      // here: it is the step that *applies* the supplied mapping, there is no MusicBrainz call
      // left to make, and running it now is what lets this response say "14 mapped, 1 extra".
      const settings = await loadSettings(db());
      const result = await runStep(id, "match", { db: db(), settings });
      await acknowledgeExtras(id);

      const open = await listInbox({ importId: id, status: "open" }, db());
      await enqueue(id, "api confirm-mapping");
      const fresh = (await getImport(id, db())) ?? job;
      const info = (result.data ?? {}) as { mapped?: number; extras?: number };

      return c.json(
        {
          import: toImport(fresh),
          mapped: info.mapped ?? body.bindings.length,
          extras: info.extras ?? 0,
          uncovered: open.filter((item) => item.type === "uncovered_tracks").length,
        },
        200,
      );
    },
  );

  /* ---- confirm-best ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/confirm-best",
      tags: [TAG],
      summary: "Confirm the candidate that maps the most videos, without building a mapping",
      description:
        "`confirm-mapping` for a caller that has nothing to add. It reads the same ranked " +
        "candidates `GET /imports/{id}/candidates` returns, picks the release that binds the " +
        "most of this import's videos, and builds the video → recording mapping from that " +
        "candidate's own `fitLines` — the assignment the matching engine computed in order to " +
        "score it. Nothing is recomputed here, so the mapping cannot disagree with the score " +
        "it was chosen on, and there is no `recordingMbid` for a client to omit.\n\n" +
        "**`minCoverage` is a real gate.** Coverage is mapped videos ÷ videos in the import. " +
        "Below the bar the answer is a **409** naming the best candidate, its release, its " +
        "type and the coverage it reached — and the import is left exactly where it was, " +
        "waiting for a human. That is what makes this safe to run over three hundred imports " +
        "in a loop.\n\n" +
        '`preferType: "album"` breaks a tie in favour of an Album over an EP or a Single ' +
        "that maps the same number of videos. It is a tie-break, not a weight: it never " +
        "promotes a candidate that maps fewer.\n\n" +
        "The confirmation is automatic but **signed**: `confirmedBy` is written to " +
        "`decisions.decidedBy`, exactly as `autoConfirm` is on the other routes, so the audit " +
        'trail can still answer "which of my albums did nobody look at?".\n\n' +
        "A single (one video, ranked against recordings rather than releases) is refused with " +
        "a 400: there is no tracklist to cover, so the bar would mean nothing.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: confirmBestSchema } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: confirmBestResultSchema } },
          description: "Confirmed and queued",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description:
            "Nothing cleared `minCoverage`. `error.details` names the best candidate and its " +
            "coverage; the import is untouched.",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const body = c.req.valid("json");
      const outcome = await confirmBest({
        importId: id,
        minCoverage: body.minCoverage,
        preferType: body.preferType,
        confirmedBy: body.confirmedBy,
        db: db(),
        source: "api confirm-best",
      });
      const fresh = await getImport(id, db());
      return c.json(
        {
          ...toImport(fresh as Import),
          chosenTitle: outcome.chosen.title,
          chosenArtist: outcome.chosen.artist,
          chosenType: outcome.chosen.primaryType,
          chosenScore: outcome.chosen.score,
          coverage: outcome.chosen.coverage,
          minCoverage: outcome.minCoverage,
          preferType: outcome.preferType,
          candidatesConsidered: outcome.candidatesConsidered,
          videos: outcome.chosen.videos,
          mapped: outcome.mapped,
          extras: outcome.extras,
          uncovered: outcome.uncovered,
          queued: outcome.queued,
          confirmedBy: outcome.confirmedBy,
        },
        200,
      );
    },
  );

  /* ---- the bulk requeue after a source outage ---- */
  //
  // Declared **before** `/{id}/retry`, and that is not cosmetic: `retry-failed-upstream` would
  // otherwise be read as an `{id}`, and the route that matched first would answer 404 for an
  // import nobody ever created.
  app.openapi(
    createRoute({
      method: "post",
      path: "/retry-failed-upstream",
      tags: [TAG],
      summary: "Requeue every import that failed because a source refused it",
      description:
        "Selects the `failed` imports whose stored error is a source refusal — a 429, a 5xx, a " +
        "timeout, a transport failure — rewinds each to where it stopped and puts it back on " +
        "the queue. A 404 or a parse error is never selected. Idempotent: a requeued import is " +
        "no longer `failed`, so calling this twice requeues nothing the second time.",
      middleware: [requireScope("imports:write")] as const,
      request: { body: { content: { "application/json": { schema: bulkRetrySchema } } } },
      responses: {
        200: {
          content: { "application/json": { schema: bulkRetryResultSchema } },
          description: "Requeued",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const planned = await requeueUpstreamFailures(
        { dryRun: body.dryRun, ...(body.limit === undefined ? {} : { limit: body.limit }) },
        db(),
      );
      if (!body.dryRun) {
        await enqueueAll(
          planned.map((job) => ({ importId: job.id, step: job.restartAt })),
          "api retry-failed-upstream",
        );
      }
      return c.json(
        {
          requeued: body.dryRun ? 0 : planned.length,
          dryRun: body.dryRun,
          imports: planned.map((job) => ({
            id: job.id,
            url: job.url,
            title: job.title,
            step: job.restartAt,
            source: job.source,
            code: job.code,
            upstreamAttempts: job.attempts,
          })),
        },
        200,
      );
    },
  );

  /* ---- the four controls ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/retry",
      tags: [TAG],
      summary: "Re-run one step",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: retryStepSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ import: importSchema, status: z.string() }),
            },
          },
          description: "Retried",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const { step } = c.req.valid("json");
      if (!(STEP_ORDER as readonly string[]).includes(step)) {
        throw new MMError("INVALID_INPUT", `Unknown step "${step}".`, {
          hint: `One of: ${STEP_ORDER.join(", ")}.`,
          status: 400,
        });
      }
      if ((await getImport(id, db())) === null) throw notFound(id);
      // Rewind, then queue. Running the step here would put a second downloader in the web
      // process, next to the worker's — see `rewindTo` and owner review C3.
      await rewindTo(id, step as StepName, db());
      await enqueue(id, "api retry", step as StepName);
      const fresh = await getImport(id, db());
      return c.json({ import: toImport(fresh as Import), status: "queued" }, 200);
    },
  );

  // Three routes with one body. Each verb is wrapped rather than referenced directly, because
  // the three service functions take different second arguments (a reason, an increment, the
  // database) and a shared loop must not care.
  const controls: readonly [string, string, (id: string) => Promise<unknown>][] = [
    ["cancel", "Cancel an import", async (id) => await cancelImport(id, db())],
    ["pause", "Pause an import", async (id) => await pauseImport(id, "paused via the API", db())],
    [
      "bump",
      "Move an import to the front of the queue",
      async (id) => await bumpImport(id, 10, db()),
    ],
  ];
  for (const [path, summary, act] of controls) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/{id}/${path}`,
        tags: [TAG],
        summary,
        middleware: [requireScope("imports:write")] as const,
        request: { params: z.object({ id: idParam }) },
        responses: {
          200: {
            content: { "application/json": { schema: z.object({ import: importSchema }) } },
            description: summary,
          },
          ...FAILURES,
        },
      }),
      async (c) => {
        const id = c.req.valid("param").id;
        if ((await getImport(id, db())) === null) throw notFound(id);
        await act(id);
        const fresh = await getImport(id, db());
        return c.json({ import: toImport(fresh as Import) }, 200);
      },
    );
  }

  return app;
}

function notFound(id: string): MMError {
  return new MMError("NOT_FOUND", `No import with id ${id}.`, {
    hint: "List them with `GET /api/v1/imports`.",
    status: 404,
  });
}

/**
 * Close the `extra_videos` notices this request has just answered.
 *
 * Exactly what the wizard does, and for the same reason: the caller supplied a mapping that
 * omits those videos, which *is* the answer to "what about these?". `uncovered_tracks` is
 * deliberately left open — "the release has tracks your source does not" is a question about
 * the album's completeness and belongs in Review.
 */
async function acknowledgeExtras(importId: string): Promise<void> {
  for (const item of await listInbox({ importId, status: "open" }, db())) {
    if (item.type !== "extra_videos") continue;
    await resolveInboxItem(
      item.id,
      { resolution: { action: "ignore", acknowledgedIn: "api" }, decidedBy: "api" },
      db(),
    );
  }
}
