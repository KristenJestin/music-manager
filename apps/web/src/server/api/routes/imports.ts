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
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import type { Import, ImportStatus, StepName } from "#/server/db/schema/index.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import {
  bumpImport,
  cancelImport,
  listImports,
  pauseImport,
  retryStep,
  runStep,
} from "#/server/services/jobs/index.ts";
import { jobDetail, setImportOptions } from "#/server/services/console.queries.ts";
import { hintsFor, rankFor, videosOf } from "#/server/services/matching.queries.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { enqueue } from "#/server/services/queue.ts";
import { STEP_ORDER } from "#/server/services/jobs/machine.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  candidatesSchema,
  confirmMappingSchema,
  createImportSchema,
  errorSchema,
  idParam,
  importDetailSchema,
  type importOptionsSchema,
  importSchema,
  listImportsQuery,
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
      middleware: [requireScope("imports:read")] as const,
      request: { query: listImportsQuery },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ imports: z.array(importSchema) }) } },
          description: "The imports",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { limit, offset, status, q } = c.req.valid("query");
      const rows = await listImports(
        {
          limit: limit + offset,
          ...(status === undefined || status === "all" ? {} : { status: status as ImportStatus }),
        },
        db(),
      );
      const filtered =
        q === undefined
          ? rows
          : rows.filter((row) =>
              `${row.title ?? ""} ${row.url}`.toLowerCase().includes(q.toLowerCase()),
            );
      return c.json({ imports: filtered.slice(offset, offset + limit).map(toImport) }, 200);
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
        "and one worker owns it.",
      middleware: [requireScope("imports:write")] as const,
      request: {
        body: { content: { "application/json": { schema: createImportSchema } }, required: true },
      },
      responses: {
        201: {
          content: {
            "application/json": {
              schema: z.object({
                import: importSchema,
                duplicates: z.array(z.string()),
              }),
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
      });
      if (body.priority !== "normal") {
        await setImportOptions(created.job.id, {}, { priority: PRIORITY[body.priority] }, db());
      }
      await enqueue(created.job.id, "api");
      const fresh = (await getImport(created.job.id, db())) ?? created.job;
      return c.json(
        { import: toImport(fresh), duplicates: created.duplicates.map((row) => row.id) },
        201,
      );
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
      const outcome = await retryStep(id, step as StepName, { db: db(), only: true });
      await enqueue(id, "api retry", outcome.step === "download" ? "download" : undefined);
      const fresh = await getImport(id, db());
      return c.json(
        {
          import: toImport(fresh as Import),
          status: outcome.ran[0]?.result.status ?? "unknown",
        },
        200,
      );
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
