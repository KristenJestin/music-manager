/**
 * `/api/v1/tools` — the maintenance verbs, and the one unauthenticated-adjacent read.
 *
 * `tools.service` guarantees that **nothing here throws**: a broken downloader is a *result*
 * with a reason, not an exception. That guarantee is why these handlers are so short, and it
 * is worth preserving — an agent asking "is yt-dlp alive?" wants an answer, and a 500 is not
 * one.
 *
 * `POST /scan` and `POST /verify-library` hand the work to the worker rather than doing it.
 * A library walk is minutes; an HTTP request that waited for it would be killed by every
 * proxy between here and the caller.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { db } from "#/server/db/client.ts";
import { APP_VERSION } from "#/server/version.ts";
import { serverEnv } from "#/server/env.ts";
import {
  cookiesStatus,
  downloaderHealth,
  errorCatalog,
  selftest,
  serviceLatencies,
  testUrl,
  updateYtdlp,
} from "#/server/services/tools.ts";
import { systemStatus } from "#/server/services/status.ts";
import { lastScan, recentScans } from "#/server/services/scan.ts";
import { enqueueLibraryScan } from "#/server/services/queue.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import { errorSchema, healthSchema } from "#/server/api/schemas.ts";

const TAG = "tools";

const FAILURES = {
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
} as const;

const anyJson = z.record(z.string(), z.unknown());

export function toolsRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  /* ---- health ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      tags: [TAG],
      summary: "Is the stack alive?",
      description:
        "The app's version, whether it is in fixtures mode, and what the toolbox reports for " +
        "its four binaries. Authenticated, unlike the public `/health` — this one names versions.",
      middleware: [requireScope("tools:read")] as const,
      responses: {
        200: {
          content: { "application/json": { schema: healthSchema } },
          description: "The status",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const env = serverEnv();
      const downloader = await downloaderHealth({ db: db() });
      let database = false;
      try {
        await db().$client`select 1`;
        database = true;
      } catch {
        database = false;
      }
      return c.json(
        {
          ok: database,
          version: APP_VERSION,
          fixtures: env.MM_FIXTURES,
          toolbox: downloader as unknown as Record<string, unknown>,
          database: { ok: database },
        },
        200,
      );
    },
  );

  /* ---- reads ---- */
  for (const [path, summary, run] of [
    ["cookies", "The YouTube cookies' status", async () => await cookiesStatus({ db: db() })],
    [
      "latencies",
      "Round-trip time to every external source",
      async () => ({
        services: await serviceLatencies({ db: db() }),
      }),
    ],
    [
      "errors",
      "The error catalogue: every code, its hint and its action",
      async () => await errorCatalog({ db: db() }),
    ],
    [
      "scans",
      "Recent library scans",
      async () => ({
        scans: await recentScans(10, db()),
        last: await lastScan(db()),
      }),
    ],
  ] as const) {
    app.openapi(
      createRoute({
        method: "get",
        path: `/${path}`,
        tags: [TAG],
        summary,
        middleware: [requireScope("tools:read")] as const,
        responses: {
          200: { content: { "application/json": { schema: anyJson } }, description: summary },
          ...FAILURES,
        },
      }),
      async (c) => c.json((await run()) as unknown as Record<string, unknown>, 200),
    );
  }

  app.openapi(
    createRoute({
      method: "get",
      path: "/url",
      tags: [TAG],
      summary: "Dry-run an extraction: what would this URL import?",
      middleware: [requireScope("tools:read")] as const,
      request: { query: z.object({ url: z.string().min(1) }) },
      responses: {
        200: { content: { "application/json": { schema: anyJson } }, description: "The verdict" },
        ...FAILURES,
      },
    }),
    async (c) =>
      c.json(
        (await testUrl(c.req.valid("query").url, { db: db() })) as unknown as Record<
          string,
          unknown
        >,
        200,
      ),
  );

  /* ---- writes ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/ytdlp/update",
      tags: [TAG],
      summary: "Update yt-dlp",
      description:
        "The single largest cause of breakage in v1 (decision 012), which is why it is a " +
        "first-class verb rather than a shell command someone has to remember.",
      middleware: [requireScope("tools:write")] as const,
      responses: {
        200: { content: { "application/json": { schema: anyJson } }, description: "The outcome" },
        ...FAILURES,
      },
    }),
    async (c) => {
      const outcome = await updateYtdlp({ db: db() });
      // The five notifiable events include this one: an update that changes the version, or
      // one that fails, is exactly the sort of thing worth being told about without asking.
      const { notify, describe } = await import("#/server/services/notifications.ts");
      const { dispatch } = await import("#/server/services/webhooks.ts");
      const data = { ...outcome } as unknown as Record<string, unknown>;
      await notify(describe("ytdlp.updated", data), { db: db() });
      await dispatch("ytdlp.updated", data, { db: db() });
      return c.json(outcome as unknown as Record<string, unknown>, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/ytdlp/selftest",
      tags: [TAG],
      summary: "Prove the downloader can still reach and parse a real page",
      middleware: [requireScope("tools:write")] as const,
      responses: {
        200: { content: { "application/json": { schema: anyJson } }, description: "The result" },
        ...FAILURES,
      },
    }),
    async (c) =>
      c.json((await selftest({}, { db: db() })) as unknown as Record<string, unknown>, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/scan",
      tags: [TAG],
      summary: "Walk the library: orphans, missing files, drift, duplicates",
      description:
        "Queued, not run here. The queue is `singleton`, so asking while the nightly scan is " +
        "running joins it rather than starting a second walk of the same tree.",
      middleware: [requireScope("tools:write")] as const,
      responses: {
        202: {
          content: {
            "application/json": {
              schema: z.object({ queued: z.boolean(), jobId: z.string().nullable() }),
            },
          },
          description: "Queued",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const jobId = await enqueueLibraryScan({ trigger: "api" });
      return c.json({ queued: true, jobId }, 202);
    },
  );

  /* ---- status: the four moving parts, in one answer ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/status",
      tags: [TAG],
      summary: "Which half of this installation is broken?",
      description:
        "Database, toolbox (reachable, fixtures mode, binary versions), Navidrome, and whether " +
        "a **worker** is alive to drain the queues — plus the last import that failed, with " +
        "its error in full. `/health` says the stack answers; this says whether it works.\n\n" +
        "`problems` is the actionable list and is empty exactly when `ok` is true. Like every " +
        "route in this file it never throws: a dead component is a field, not a 500.",
      middleware: [requireScope("tools:read")] as const,
      responses: {
        200: { content: { "application/json": { schema: anyJson } }, description: "The status" },
        ...FAILURES,
      },
    }),
    async (c) =>
      c.json((await systemStatus({ db: db() })) as unknown as Record<string, unknown>, 200),
  );

  return app;
}
