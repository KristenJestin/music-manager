/**
 * `/api/v1/imports` — everything an agent needs to run the pipeline.
 *
 * Every handler calls the **service layer** and nothing else. That is the rule of
 * `docs/phases/P08-api-agents.md`, and it is what makes "an agent sees the same candidates and
 * the same Inbox as you" (`docs/01-vision-et-principes.md` §8) true by construction rather
 * than by diligence: `POST /imports` and the Console's paste box reach `createImport` by
 * different doors into the same room.
 *
 * `POST /{id}/confirm-mapping` used to be the one place this file had logic of its own — a
 * transcription of the wizard's step 4, which the Console then transcribed a second time and
 * which had nowhere to put a third. It is now `services/confirm.ts`, one function called by
 * this route, by the wizard and by the job page alike.
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
import { createImport, getImport } from "#/server/services/imports.ts";
import { confirmBest, createImportsBatch, MAX_BATCH_URLS } from "#/server/services/imports.bulk.ts";
import { adoptTrackFile, type AdoptSource } from "#/server/services/adopt.ts";
import {
  bumpImport,
  cancelImport,
  countImports,
  forgetMapping,
  listImports,
  pauseImport,
  requeueUpstreamFailures,
  rewindTo,
} from "#/server/services/jobs/index.ts";
import { jobDetail, setImportOptions } from "#/server/services/console.queries.ts";
import { confirmSupplied } from "#/server/services/confirm.ts";
import { hintsFor, rankFor, videosOf } from "#/server/services/matching.queries.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { enqueue, enqueueAll } from "#/server/services/queue.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import { forgetsMapping } from "#/server/services/retry-plan.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  batchImportSchema,
  batchResultSchema,
  bumpResultSchema,
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
  adoptFileSchema,
  adoptFileResultSchema,
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

/**
 * The validated body of the adopt route → the service's own `AdoptSource`.
 *
 * A `switch` over the discriminant rather than a ternary, so that a fourth member of
 * `AdoptSource` is a compile error here instead of a body silently read as an upload.
 */
function sourceOf(body: z.infer<typeof adoptFileSchema>): AdoptSource {
  switch (body.source) {
    case "path":
      return { kind: "path", path: body.path };
    case "url":
      return { kind: "url", url: body.url };
    case "upload":
      return {
        kind: "upload",
        filename: body.filename,
        bytes: new Uint8Array(Buffer.from(body.content, "base64")),
      };
  }
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
      const created = await createImport(body.url, {
        db: db(),
        ...(body.releaseMbid === null || body.releaseMbid === undefined
          ? {}
          : { releaseMbid: body.releaseMbid }),
        ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
        ...(options.lyrics === undefined ? {} : { lyrics: options.lyrics }),
        ...(options.replaygain === undefined ? {} : { replaygain: options.replaygain }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.autoConfirm === undefined ? {} : { autoConfirm: options.autoConfirm }),
        ...(options.untaggedFallback === undefined
          ? {}
          : { untaggedFallback: options.untaggedFallback }),
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
          // The schema has advertised this on a batch since P08 and the handler dropped it,
          // which is how a hundred URLs could not state the one option that matters for a
          // record MusicBrainz has never published. The single route has always forwarded it.
          ...(options.untaggedFallback === undefined
            ? {}
            : { untaggedFallback: options.untaggedFallback }),
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
            // Null for a `sourceless` track: it came from no video. The id above is still the
            // one the adopt route takes, which is the whole point of the row existing.
            videoId: track.videoId,
            title: track.sourceTitle,
            durationSeconds: track.sourceDuration,
            status: track.state,
            trackPosition: track.trackPosition,
            mediumPosition: track.mediumPosition,
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

      // `services/confirm.ts` — the same function the wizard's Start button calls. This route
      // used to hold the only copy of that logic with its own header apologising for it; the
      // Console then grew a second and there was nowhere for a third to go.
      const outcome = await confirmSupplied(
        {
          importId: id,
          confirmedBy: "api",
          mapping,
          options: {
            fingerprint: options.fingerprint ?? true,
            lyrics: options.lyrics ?? true,
            replaygain: options.replaygain ?? true,
            force: options.force ?? false,
          },
          priority: PRIORITY[body.priority],
          acknowledgedIn: "api",
          reason: "api confirm-mapping",
        },
        db(),
      );

      return c.json(
        {
          import: toImport(outcome.job),
          mapped: outcome.mapped,
          extras: outcome.extras,
          uncovered: outcome.uncovered,
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
      summary: "Confirm the engine's best candidate, without building a mapping",
      description:
        "`confirm-mapping` for a caller that has nothing to add. It reads the same ranked " +
        "candidates `GET /imports/{id}/candidates` returns and confirms the engine's own best " +
        "answer, building the mapping from that candidate's own evidence. Nothing is " +
        "recomputed here, so the mapping cannot disagree with the score it was chosen on, and " +
        "there is no `recordingMbid` for a client to omit.\n\n" +
        "**Two criteria, one endpoint, chosen by what the import is** — `kind` in the answer " +
        "says which one ran. A caller looping over the ids `POST /imports/batch` returned does " +
        "not know which of them the `resolve` step made a single, and should not have to.\n\n" +
        "**An album is decided on an exact match.** This is the only path that commits a " +
        "release without anybody reading the card, so it commits only when there is nothing " +
        "left to ask: every video of the import bound to a track, no track of the release left " +
        "without a video, and a candidate credited to the artist the source names. The release " +
        "that binds the most videos wins and the mapping comes from its `fitLines`; " +
        "`minCoverage` (mapped videos ÷ videos in the import) is a bar you may *raise* on top " +
        "of the rule and cannot use to waive it — a deliberately inexact album is what " +
        '`confirm-mapping` is for. `preferType: "album"` breaks a tie in favour of ' +
        "an Album over an EP or a Single that maps the same number of videos; it is a " +
        "tie-break, not a weight, and never promotes a candidate that maps fewer.\n\n" +
        "**A single is decided on the margin.** One video is ranked against *recordings*, so " +
        "there is no tracklist and coverage would be 1 whatever was chosen. The bar is instead " +
        "four conditions that mean something for one song, all read from thresholds the engine " +
        "already uses: the chosen recording's lead over the runner-up is at least `minMargin` " +
        "(default: this installation's `matchAmbiguityMargin`, the same gap under which " +
        "`match` itself refuses to decide); the durations agree within the ± 2 s tolerance; " +
        "the title and the artist both agree at or above `titleMatchThreshold`. A missing " +
        "duration on either side fails the check rather than skipping it. The release the " +
        "track is filed under is the engine's own borrow release.\n\n" +
        "**Both bars are real gates.** Below either one the answer is a **409** naming the " +
        "candidate and every condition it missed — and the import is left exactly where it " +
        "was, waiting for a human. That is what makes this safe to run over three hundred " +
        "imports in a loop.\n\n" +
        "The confirmation is automatic but **signed**: `confirmedBy` is written to " +
        "`decisions.decidedBy`, exactly as `autoConfirm` is on the other routes, so the audit " +
        'trail can still answer "which of my albums did nobody look at?".',
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
            "Nothing cleared the bar. `error.details` names the best candidate and either its " +
            "coverage (album) or its margin, duration delta and agreements plus a `failures` " +
            "list (single); the import is untouched.",
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
        ...(body.minMargin === undefined ? {} : { minMargin: body.minMargin }),
        preferType: body.preferType,
        confirmedBy: body.confirmedBy,
        db: db(),
        source: "api confirm-best",
      });
      const fresh = await getImport(id, db());
      const chosen = outcome.chosen;
      // The branch's own fields, and `null` for the other's — see `confirmBestResultSchema`.
      const perKind =
        chosen.kind === "release"
          ? {
              chosenType: chosen.primaryType,
              recordingMbid: null,
              coverage: chosen.coverage,
              videos: chosen.videos,
              margin: null,
              durationDelta: null,
            }
          : {
              chosenType: chosen.releaseType,
              recordingMbid: chosen.mbid,
              coverage: null,
              videos: null,
              margin: chosen.margin,
              durationDelta: chosen.durationDelta,
            };
      return c.json(
        {
          ...toImport(fresh as Import),
          kind: outcome.kind,
          chosenTitle: chosen.title,
          chosenArtist: chosen.artist,
          chosenScore: chosen.score,
          ...perKind,
          minCoverage: outcome.minCoverage,
          preferType: outcome.preferType,
          minMargin: outcome.minMargin,
          candidatesConsidered: outcome.candidatesConsidered,
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

  /* ---- adopt a local file as one track's source ---- */
  //
  // Declared before `/{id}/retry` for the same reason `retry-failed-upstream` is: Hono matches
  // in declaration order, and a `/{id}/…` route declared first would swallow anything deeper.
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/tracks/{trackId}/file",
      tags: [TAG],
      summary: "Adopt a file, or a replacement address, as this track's source",
      description:
        "Gives one track audio from somewhere other than its own video. For a video that " +
        "has been deleted, a video behind an age check or behind Music Premium, and for " +
        "taking over an existing library track by track.\n\n" +
        "**The bytes arrive one of three ways**, chosen by `source`:\n\n" +
        "- `path` — an absolute path *on the server*. The honest answer when the files are " +
        "already on the machine. It is resolved through `realpath` and refused with **403 " +
        "`ADOPT_PATH_REFUSED`** unless it lands inside the library or inside one of the " +
        "directories the `adoptSourceRoots` setting lists. That list is **empty by default**: " +
        "until an operator names a folder in Settings, this route will not read anything " +
        "outside the library.\n" +
        "- `upload` — the file's bytes, base64, up to 64 MB. The honest answer for a browser " +
        "or for a caller with no shell on the machine.\n" +
        "- `url` — a **replacement address** to download from, for when you have no file at " +
        "all. A deleted or age-checked video is almost always still on YouTube under another " +
        "upload; this fetches *that* one. Only `http://`, `https://` and (in fixtures mode) " +
        "`fixture://` are accepted, and any other scheme is refused with `INVALID_INPUT`. " +
        "Unlike the other two, **this one spends the single download slot** and so can " +
        "answer **409 `LOCKED`** — retry it when the slot is free.\n\n" +
        "The file lands in `<library>/.mm-work/<import>/<trackId><ext>`, which is where " +
        "`place` expects to find it and what `download` probes for. The track resumes at the " +
        "step *after* `download` — `fingerprint`, then `tag`, then `place` — on the per-track " +
        "queue, and **the track's own video is never fetched**.\n\n" +
        "**The document says so, and says which address gave up the bytes.** For `path` and " +
        '`upload` the track\'s `COMMENT` becomes *Adopted local file "…" · not downloaded ' +
        "from youtu.be/…*; for `url` it becomes *Downloaded from youtu.be/… · original " +
        "source youtu.be/… unavailable*. Either way `MUSICMANAGER_SOURCEURL` still carries " +
        "the **original** video's URL, because that is the track's identity and not a claim " +
        "about where the audio came from.\n\n" +
        "**Refusals**, each with its own code so the fix is unambiguous: `ADOPT_UNSUPPORTED` " +
        "(a container the tagger cannot write to), `ADOPT_NOT_AUDIO` (ffprobe found no audio " +
        "stream), `ADOPT_CONFLICT` (the track already has a file — retry it first), " +
        "`ADOPT_PATH_REFUSED` (outside the allow-list), `LOCKED` (a download is already " +
        "running) and `ADOPT_NOT_READY` (the import is cancelled, or has not been confirmed, " +
        "or this video is not bound to a track).",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: idParam, trackId: idParam }),
        body: { content: { "application/json": { schema: adoptFileSchema } }, required: true },
      },
      responses: {
        ...FAILURES,
        200: {
          content: { "application/json": { schema: adoptFileResultSchema } },
          description: "Adopted; the track carries on from `fingerprint`",
        },
        // Overrides the shared 403, which only knows about a missing scope: on this route the
        // interesting refusal is the allow-list, and a reader must not be told to fix a key.
        403: {
          content: { "application/json": { schema: errorSchema } },
          description: "Missing scope, or `ADOPT_PATH_REFUSED`: the path is outside the allow-list",
        },
        409: {
          content: { "application/json": { schema: errorSchema } },
          description:
            '`ADOPT_CONFLICT`, `ADOPT_NOT_READY`, or `LOCKED` when `source: "url"` asked ' +
            "for the download slot and something else was holding it",
        },
        413: {
          content: { "application/json": { schema: errorSchema } },
          description: "The upload is larger than 64 MB. Adopt it by path instead.",
        },
        415: {
          content: { "application/json": { schema: errorSchema } },
          description: "`ADOPT_UNSUPPORTED` or `ADOPT_NOT_AUDIO`",
        },
      },
    }),
    async (c) => {
      const { id, trackId } = c.req.valid("param");
      const body = c.req.valid("json");
      const result = await adoptTrackFile({
        importId: id,
        trackId,
        source: sourceOf(body),
        adoptedBy: "api",
        db: db(),
      });
      return c.json(result, 200);
    },
  );

  /* ---- the four controls ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/retry",
      tags: [TAG],
      summary: "Re-run one step",
      description:
        "Rewinds the import to `step` and puts it back on the queue; the worker runs it.\n\n" +
        "**`resolve` and `match` discard the confirmed mapping.** The `match` step applies a " +
        "supplied mapping verbatim when `imports.options` carries one, so a rewind that kept " +
        "it would re-apply the very mapping you are asking to replace. The confirmed release, " +
        "the per-video mapping, the signature that opened the confirmation gate and the Inbox " +
        "items the old match raised all go; the `decisions` rows stay, because they are the " +
        "audit trail and not the answer. `forgotMapping` in the response says whether it " +
        "happened. Every other step keeps the mapping and rewinds only the tail.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: { content: { "application/json": { schema: retryStepSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                import: importSchema,
                status: z.string(),
                forgotMapping: z.boolean(),
              }),
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
      // A re-match discards the confirmed mapping, here exactly as in the Console and the CLI:
      // `matchStep` applies `options.mapping` verbatim when it is there, so leaving it would
      // make `--step match` re-apply the very mapping the caller is asking to replace.
      const forgotMapping = forgetsMapping(step as StepName);
      if (forgotMapping) await forgetMapping(id, db());
      // Rewind, then queue. Running the step here would put a second downloader in the web
      // process, next to the worker's — see `rewindTo` and owner review C3.
      await rewindTo(id, step as StepName, db());
      await enqueue(id, "api retry", step as StepName);
      const fresh = await getImport(id, db());
      return c.json({ import: toImport(fresh as Import), status: "queued", forgotMapping }, 200);
    },
  );

  /* ---- bump ---- */
  //
  // Its own route rather than a third entry in the loop below, because its answer is no longer
  // "here is the import": a bump now reports what it did to the *message* on the queue, and that
  // is the only way a caller can tell "moved to the front" from "the worker already has it".
  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/bump",
      tags: [TAG],
      summary: "Move an import to the front of the queue",
      description:
        "Raises `imports.priority` **and** moves the message the import already has on a " +
        "pg-boss queue, which is the half that used to be missing: nothing read the column " +
        "when enqueuing, so a bumped import kept the priority it was sent with and did not " +
        "move.\n\n" +
        "`bump.action` says which of four things happened. `reprioritised` — the waiting " +
        "message was edited in place. `sent` — the import held no message at all, so one was " +
        "created (checked against pg-boss's own ledger first, because `singletonKey` " +
        "deduplicates nothing on a `standard` queue and sending blindly is how an import ends " +
        "up with two). `running` — a worker is already executing the step, so the message " +
        "cannot move and the new priority applies to whatever is queued next. `none` — the " +
        "import is finished, cancelled or waiting for a human, and a bump is not a way to " +
        "restart it.\n\n" +
        "`bump.messages` is how many unfinished messages the import holds afterwards, and it " +
        "is never more than one; `bump.removed` counts duplicates cleared on the way past.",
      middleware: [requireScope("imports:write")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ import: importSchema, bump: bumpResultSchema }),
            },
          },
          description: "Bumped",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      if ((await getImport(id, db())) === null) throw notFound(id);
      const result = await bumpImport(id, 10, db());
      const fresh = await getImport(id, db());
      return c.json(
        { import: toImport(fresh as Import), bump: { ...result.queue, priority: result.priority } },
        200,
      );
    },
  );

  // Two routes with one body. Each verb is wrapped rather than referenced directly, because the
  // service functions take different second arguments (a reason, the database) and a shared loop
  // must not care.
  const controls: readonly [string, string, (id: string) => Promise<unknown>][] = [
    ["cancel", "Cancel an import", async (id) => await cancelImport(id, db())],
    ["pause", "Pause an import", async (id) => await pauseImport(id, "paused via the API", db())],
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
