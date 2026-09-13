/**
 * `/api/v1/watched-sources` — the playlists and channels, for an agent.
 *
 * Five routes and they are the five things the page can do: list, read one, add, change one,
 * forget one, and ask for a scan. Nothing here scans inline: a scan is a flat extraction plus
 * one import per new video, which belongs on the queue exactly as it does in the Console.
 *
 * It reuses the **`imports:*` scopes** rather than inventing `sources:*`. A watched source is
 * a thing that creates imports, and `API_RESOURCES` is a closed list whose arity is asserted
 * in `packages/contracts/src/api.test.ts`; a sixth resource for four routes would be a fourth
 * grant to make for no extra safety.
 *
 * Schemas are declared with `@hono/zod-openapi`'s `z`, never the one from `@mm/contracts` —
 * see the note at the top of `server/api/schemas.ts` for why that is not cosmetic.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import { errorSchema } from "#/server/api/schemas.ts";
import { enqueueWatchedSourceScan } from "#/server/services/queue.ts";
import {
  createWatchedSource,
  deleteWatchedSource,
  getWatchedSource,
  listWatchedSources,
  updateWatchedSource,
} from "#/server/services/watched-sources.ts";
import type { WatchedSource } from "#/server/db/schema/index.ts";

const TAG = "watched-sources";

const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad input" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
} as const;

const sourceSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    kind: z.enum(["playlist", "channel"]),
    label: z.string(),
    enabled: z.boolean(),
    autoAccept: z.boolean(),
    autoAcceptThreshold: z.number().nullable(),
    minDuration: z.number().nullable(),
    maxDuration: z.number().nullable(),
    requireProvidedToYouTube: z.boolean(),
    lastScanAt: z.string().nullable(),
    lastScanStatus: z.enum(["never", "ok", "partial", "failed"]),
    lastError: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .openapi("WatchedSource");

const summarySchema = z
  .object({
    source: sourceSchema,
    total: z.number(),
    imported: z.number(),
    pending: z.number(),
    skipped: z.number(),
  })
  .openapi("WatchedSourceSummary");

const itemSchema = z
  .object({
    id: z.string(),
    videoId: z.string(),
    title: z.string(),
    status: z.enum(["new", "imported", "skipped", "ignored"]),
    reason: z.string().nullable(),
    importId: z.string().nullable(),
    importStatus: z.string().nullable(),
    firstSeenAt: z.string(),
  })
  .openapi("WatchedSourceItem");

const bodySchema = z.object({
  url: z.string().min(1),
  label: z.string().max(200).optional(),
  kind: z.enum(["playlist", "channel"]).optional(),
  autoAccept: z.boolean().optional(),
  autoAcceptThreshold: z.number().min(0).max(1).nullable().optional(),
  minDuration: z.number().int().min(0).nullable().optional(),
  maxDuration: z.number().int().min(0).nullable().optional(),
  requireProvidedToYouTube: z.boolean().optional(),
});

const patchBodySchema = bodySchema.partial().omit({ url: true });

function plain(source: WatchedSource): z.infer<typeof sourceSchema> {
  return {
    id: source.id,
    url: source.url,
    kind: source.kind,
    label: source.label,
    enabled: source.enabled,
    autoAccept: source.autoAccept,
    autoAcceptThreshold: source.autoAcceptThreshold,
    minDuration: source.minDuration,
    maxDuration: source.maxDuration,
    requireProvidedToYouTube: source.requireProvidedToYouTube,
    lastScanAt: source.lastScanAt?.toISOString() ?? null,
    lastScanStatus: source.lastScanStatus,
    lastError: source.lastError === null ? null : { ...source.lastError },
    createdAt: source.createdAt.toISOString(),
  };
}

export function watchedSourceRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "Every watched playlist and channel, with its counts",
      middleware: [requireScope("imports:read")] as const,
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ sources: z.array(summarySchema) }) },
          },
          description: "The sources",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const rows = await listWatchedSources(db());
      return c.json({ sources: rows.map((row) => ({ ...row, source: plain(row.source) })) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: [TAG],
      summary: "Watch a playlist or channel",
      description:
        "`autoAccept` is the one switch that lets an import be confirmed with nobody looking " +
        "at it, and only when the match is safe and unambiguous. It defaults to " +
        "`watchedSourcesAutoAcceptDefault`, which is itself off.",
      middleware: [requireScope("imports:write")] as const,
      request: { body: { content: { "application/json": { schema: bodySchema } } } },
      responses: {
        201: {
          content: { "application/json": { schema: sourceSchema } },
          description: "Now watched",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = await createWatchedSource(body, { db: db() });
      return c.json(plain(created), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags: [TAG],
      summary: "One source, and every video it has seen",
      middleware: [requireScope("imports:read")] as const,
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                source: sourceSchema,
                total: z.number(),
                imported: z.number(),
                pending: z.number(),
                skipped: z.number(),
                items: z.array(itemSchema),
              }),
            },
          },
          description: "The source",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const detail = await getWatchedSource(id, db());
      if (detail === null) throw new MMError("NOT_FOUND", `No watched source with id ${id}.`);
      return c.json(
        {
          source: plain(detail.source),
          total: detail.total,
          imported: detail.imported,
          pending: detail.pending,
          skipped: detail.skipped,
          items: detail.items.map((item) => ({
            id: item.id,
            videoId: item.videoId,
            title: item.title,
            status: item.status,
            reason: item.reason,
            importId: item.importId,
            importStatus: item.job?.status ?? null,
            firstSeenAt: item.firstSeenAt.toISOString(),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: [TAG],
      summary: "Change a source's label, its filters, or what it may confirm alone",
      middleware: [requireScope("imports:write")] as const,
      request: {
        params: z.object({ id: z.string().min(1) }),
        body: { content: { "application/json": { schema: patchBodySchema } } },
      },
      responses: {
        200: { content: { "application/json": { schema: sourceSchema } }, description: "Updated" },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const updated = await updateWatchedSource(id, c.req.valid("json"), db());
      return c.json(plain(updated), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: [TAG],
      summary: "Stop watching it",
      description:
        "The videos it remembers go with it. The imports it already opened are kept, and so " +
        "is everything they put in the library.",
      middleware: [requireScope("imports:write")] as const,
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ deleted: z.string() }) } },
          description: "Forgotten",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await deleteWatchedSource(id, db());
      return c.json({ deleted: id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/scan",
      tags: [TAG],
      summary: "Ask the worker to scan this source now",
      description:
        "Queued, not run: a scan lists the source and opens one import per new video, which " +
        "is worker work. The answer says the scan was accepted, not what it found — read " +
        "`GET /watched-sources/{id}` after.",
      middleware: [requireScope("imports:write")] as const,
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        202: {
          content: {
            "application/json": { schema: z.object({ queued: z.boolean(), sourceId: z.string() }) },
          },
          description: "Queued",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const detail = await getWatchedSource(id, db());
      if (detail === null) throw new MMError("NOT_FOUND", `No watched source with id ${id}.`);
      const jobId = await enqueueWatchedSourceScan({ sourceId: id, trigger: "api" });
      return c.json({ queued: jobId !== null, sourceId: id }, 202);
    },
  );

  return app;
}
