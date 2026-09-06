/**
 * The `/api/v1` application (`docs/phases/P08-api-agents.md`).
 *
 * Hono, mounted on a TanStack Start server route (`routes/api.v1.$.ts`). Hono rather than more
 * file routes for one reason that matters: `@hono/zod-openapi` derives the OpenAPI document
 * from the same zod schemas the handlers validate with, so the documentation cannot describe
 * an endpoint that does not exist or miss one that does. A hand-written `openapi.json` is
 * wrong within a fortnight.
 *
 * Three things are set up here and nowhere else:
 *
 *  - **`basePath("/api/v1")`.** Hono has to know its own mount point or every generated path
 *    and every redirect is off by one segment.
 *  - **One error handler.** Every route may simply `throw new MMError(...)`; `onError` turns
 *    it into the same `{error: {code, message, hint, action}}` body the server functions and
 *    the toolbox use. Handlers that had to catch and shape their own failures would each
 *    invent a slightly different one.
 *  - **The OpenAPI document and the docs UI**, at `/api/openapi.json` and `/api/docs`. Both
 *    are *outside* `/api/v1` — they describe the API rather than being part of it — so they
 *    are served by their own routes and mounted here only for convenience.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { MMError } from "@mm/contracts";
import { APP_VERSION } from "#/server/version.ts";
import { errorBody, requireScope, resolvePrincipal, type ApiEnv } from "#/server/api/auth.ts";
import { importRoutes } from "#/server/api/routes/imports.ts";
import { inboxRoutes } from "#/server/api/routes/inbox.ts";
import { discoverRoutes } from "#/server/api/routes/discover.ts";
import { libraryRoutes } from "#/server/api/routes/library.ts";
import { settingsRoutes } from "#/server/api/routes/settings.ts";
import { toolsRoutes } from "#/server/api/routes/tools.ts";
import { eventRoutes } from "#/server/api/routes/events.ts";
import { keyRoutes, webhookRoutes } from "#/server/api/routes/keys.ts";
import { principalSchema } from "#/server/api/schemas.ts";
import { createRoute, z } from "@hono/zod-openapi";

export const API_BASE = "/api/v1";

/**
 * Map a thrown error onto a status.
 *
 * The codes carry their own status where they have one (`MMError.status`); the rest fall back
 * to a table, because a `NOT_FOUND` raised deep inside a service has no business knowing it
 * will one day be an HTTP response.
 */
const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_INPUT: 400,
  RATE_LIMITED: 429,
  LOCKED: 409,
  CANCELLED: 409,
  AWAITING_CONFIRM: 409,
  AWAITING_REVIEW: 409,
  TIMEOUT: 504,
  TOOLBOX_UNREACHABLE: 502,
  NAVIDROME_UNREACHABLE: 502,
};

export function buildApi(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>({
    /*
     * A zod failure is an `INVALID_INPUT`, in the app's own error shape.
     *
     * Without this hook `@hono/zod-openapi` answers with its own `{success:false, error:{...}}`
     * envelope, which would make `/api/v1` the one surface in this app whose 400 does not look
     * like every other failure — and the error decoder would not recognise it.
     */
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          errorBody(
            new MMError("INVALID_INPUT", "The request body or query is not valid.", {
              hint: "Check the schema at /api/docs.",
              details: { issues: result.error.issues },
              status: 400,
            }),
          ),
          400,
        );
      }
      return undefined;
    },
  }).basePath(API_BASE) as unknown as OpenAPIHono<ApiEnv>;

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    const failure = MMError.from(error);
    const status = failure.status ?? STATUS_BY_CODE[failure.code] ?? 500;
    if (status >= 500) console.error(`[api] ${c.req.method} ${c.req.path}:`, failure);
    return c.json(errorBody(failure), status as 500);
  });

  app.notFound((c) =>
    c.json(
      errorBody(
        new MMError("NOT_FOUND", `No route for ${c.req.method} ${c.req.path}.`, {
          hint: "The full list is at /api/docs.",
          status: 404,
        }),
      ),
      404,
    ),
  );

  /**
   * `GET /api/v1/me` — "does this credential work, and what may it do?"
   *
   * The first call every integration makes, and the only route with no scope requirement
   * beyond being authenticated at all: refusing to tell a key what it may do, because it may
   * not do that, would be a riddle.
   */
  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags: ["meta"],
      summary: "Who am I, and what may this credential do?",
      responses: {
        200: {
          content: { "application/json": { schema: principalSchema } },
          description: "The principal",
        },
        401: {
          content: { "application/json": { schema: z.object({ error: z.unknown() }) } },
          description: "No credential",
        },
      },
    }),
    async (c) => {
      const resolution = await resolvePrincipal(c.req.raw);
      if (!resolution.ok) return c.json(errorBody(resolution.error), resolution.status as 401);
      return c.json(resolution.principal, 200);
    },
  );

  app.route("/imports", importRoutes());
  app.route("/inbox", inboxRoutes());
  app.route("/library", libraryRoutes());
  app.route("/settings", settingsRoutes());
  app.route("/tools", toolsRoutes());
  app.route("/events", eventRoutes());
  app.route("/keys", keyRoutes());
  app.route("/discover", discoverRoutes());
  app.route("/webhooks", webhookRoutes());

  return app;
}

/** Cached: building the app walks every route and compiles every schema. */
let cached: OpenAPIHono<ApiEnv> | undefined;
export function api(): OpenAPIHono<ApiEnv> {
  cached ??= buildApi();
  return cached;
}

/**
 * The OpenAPI 3.1 document.
 *
 * 3.1 rather than 3.0 because zod v4 emits JSON Schema 2020-12, which is what 3.1 embeds
 * natively; targeting 3.0 would force a lossy down-conversion of every nullable and every
 * union in the document.
 */
export function openApiDocument(): Record<string, unknown> {
  return api().getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "Music Manager",
      version: APP_VERSION,
      description:
        "Everything the Console does is an API call.\n\n" +
        "Authenticate with an API key — `x-api-key: mm_…` or `Authorization: Bearer mm_…` — " +
        "issued in Settings › API & agents, or with the session cookie of a signed-in browser. " +
        "A session carries every scope; a key carries the scopes it was issued with. A missing " +
        "scope is a **403** naming the scope it wanted, never a 401.\n\n" +
        'Errors are always `{"error": {"code", "message", "hint?", "action?"}}`.',
    },
    servers: [{ url: "/", description: "This installation" }],
    tags: [
      { name: "meta", description: "Who you are." },
      { name: "imports", description: "Create imports, read candidates, confirm a mapping." },
      { name: "inbox", description: "The questions the pipeline is waiting on." },
      { name: "library", description: "What is on disk, scored; re-tag and verify." },
      { name: "settings", description: "The typed registry. Secrets are masked." },
      { name: "tools", description: "Health, yt-dlp, scans." },
      { name: "events", description: "The job journal, live or paged." },
      { name: "keys", description: "API keys and their scopes." },
      { name: "discover", description: "Recommendations, and turning one into an import." },
      { name: "webhooks", description: "Signed HTTP callbacks." },
    ],
  }) as unknown as Record<string, unknown>;
}

/**
 * Register the two API-key security schemes on the document.
 *
 * Done here rather than inline on every route: the two apply to everything, and repeating a
 * `security` block on forty routes is forty chances to forget one.
 */
export function describeSecurity(document: Record<string, unknown>): Record<string, unknown> {
  const components = (document["components"] ?? {}) as Record<string, unknown>;
  return {
    ...document,
    components: {
      ...components,
      securitySchemes: {
        apiKeyHeader: {
          type: "apiKey",
          in: "header",
          name: "x-api-key",
          description: "A key from Settings › API & agents.",
        },
        bearer: {
          type: "http",
          scheme: "bearer",
          description: "The same key as `Authorization: Bearer mm_…`.",
        },
        session: {
          type: "apiKey",
          in: "cookie",
          name: "mm.session_token",
          description: "The Console's own cookie. Carries every scope.",
        },
      },
    },
    security: [{ apiKeyHeader: [] }, { bearer: [] }, { session: [] }],
  };
}

export { requireScope };
