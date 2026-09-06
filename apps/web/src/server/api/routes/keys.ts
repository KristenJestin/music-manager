/**
 * `/api/v1/keys` and `/api/v1/webhooks` — managing the credentials and the callbacks.
 *
 * Both are behind `settings:write`, which is the strongest scope short of `*`. That is
 * deliberate: a key that can mint keys is a key that can escalate itself to `*`, so the
 * ability to do it must not be a casual grant. In practice the Settings page uses a session
 * for this, and a key needs it only when an agent is provisioning another agent.
 *
 * `POST /keys` returns the plaintext, once. Nothing stores it and no endpoint returns it
 * again — `key` in the table is a SHA-256 of it.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isApiScope, MMError, SCOPE_DESCRIPTIONS, SCOPE_ORDER } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { create as createKey, list as listKeys, revoke } from "#/server/services/api-keys.ts";
import {
  create as createWebhook,
  list as listWebhooks,
  remove as removeWebhook,
  testSend,
  update as updateWebhook,
} from "#/server/services/webhooks.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  createdKeySchema,
  createdWebhookSchema,
  createKeySchema,
  createWebhookSchema,
  errorSchema,
  idParam,
  keySchema,
  patchWebhookSchema,
  okSchema,
  webhookViewSchema,
} from "#/server/api/schemas.ts";

const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad input" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
} as const;

export function keyRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/scopes",
      tags: ["keys"],
      summary: "Every scope a key can carry, and what it permits",
      middleware: [requireScope("settings:read")] as const,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                scopes: z.array(z.object({ scope: z.string(), description: z.string() })),
              }),
            },
          },
          description: "The scopes",
        },
        ...FAILURES,
      },
    }),
    (c) =>
      c.json(
        {
          scopes: SCOPE_ORDER.map((scope) => ({
            scope,
            description: SCOPE_DESCRIPTIONS[scope] ?? "",
          })),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["keys"],
      summary: "List API keys. The secrets are not here and cannot be.",
      middleware: [requireScope("settings:read")] as const,
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ keys: z.array(keySchema) }) } },
          description: "The keys",
        },
        ...FAILURES,
      },
    }),
    async (c) => c.json({ keys: await listKeys(c.get("principal").userId, db()) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["keys"],
      summary: "Mint an API key",
      description: "The plaintext is in this response and nowhere else, ever. Store it now.",
      middleware: [requireScope("settings:write")] as const,
      request: {
        body: { content: { "application/json": { schema: createKeySchema } }, required: true },
      },
      responses: {
        201: {
          content: { "application/json": { schema: createdKeySchema } },
          description: "Created — the only time `key` is returned",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const unknown = body.scopes.filter((scope) => !isApiScope(scope));
      if (unknown.length > 0) {
        throw new MMError("INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`, {
          hint: `GET /api/v1/keys/scopes lists them.`,
          details: { unknown },
          status: 400,
        });
      }
      const created = await createKey({
        name: body.name,
        scopes: body.scopes,
        expiresInDays: body.expiresInDays,
        userId: c.get("principal").userId,
      });
      return c.json({ ...created.view, key: created.secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["keys"],
      summary: "Revoke a key",
      description:
        "A hard delete, not a disable. A revoked key's secret is on somebody's disk; a row " +
        "that lingers disabled is a row somebody re-enables instead of issuing a fresh one.",
      middleware: [requireScope("settings:write")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: { content: { "application/json": { schema: okSchema } }, description: "Revoked" },
        ...FAILURES,
      },
    }),
    async (c) => {
      await revoke(c.req.valid("param").id, c.get("principal").userId, db());
      return c.json({ ok: true }, 200);
    },
  );

  return app;
}

export function webhookRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: ["webhooks"],
      summary: "List webhook endpoints",
      middleware: [requireScope("settings:read")] as const,
      responses: {
        200: {
          content: {
            "application/json": { schema: z.object({ webhooks: z.array(webhookViewSchema) }) },
          },
          description: "The endpoints",
        },
        ...FAILURES,
      },
    }),
    async (c) => c.json({ webhooks: await listWebhooks(db()) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/",
      tags: ["webhooks"],
      summary: "Register a webhook endpoint",
      description:
        "The response carries the HMAC secret once. Every delivery is signed with it as " +
        "`x-mm-signature: t=<unix>,v1=<hex>`, computed over `\"<t>.<body>\"` — the timestamp " +
        "is inside the signed material so a captured delivery cannot be replayed for ever.",
      middleware: [requireScope("settings:write")] as const,
      request: {
        body: { content: { "application/json": { schema: createWebhookSchema } }, required: true },
      },
      responses: {
        201: {
          content: { "application/json": { schema: createdWebhookSchema } },
          description: "Created — the only time `secret` is returned",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const created = await createWebhook(
        { name: body.name, url: body.url, events: body.events },
        db(),
      );
      return c.json({ ...created.view, secret: created.secret }, 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags: ["webhooks"],
      summary: "Change an endpoint's URL, events, or enabled state",
      middleware: [requireScope("settings:write")] as const,
      request: {
        params: z.object({ id: idParam }),
        body: {
          content: {
            "application/json": {
              /*
               * Declared field by field rather than as `createWebhookSchema.partial()`.
               *
               * `.partial()` makes a field optional but does **not** remove its `.default()`,
               * so a body of `{"events": []}` came back out of the parser carrying
               * `name: ""` — and the handler dutifully renamed the endpoint to nothing. A
               * PATCH must not change what it was not asked to change.
               */
              schema: patchWebhookSchema,
            },
          },
          required: true,
        },
      },
      responses: {
        200: {
          content: { "application/json": { schema: webhookViewSchema } },
          description: "Updated",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      return c.json(await updateWebhook(c.req.valid("param").id, body, db()), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags: ["webhooks"],
      summary: "Delete an endpoint",
      middleware: [requireScope("settings:write")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: { content: { "application/json": { schema: okSchema } }, description: "Deleted" },
        ...FAILURES,
      },
    }),
    async (c) => {
      await removeWebhook(c.req.valid("param").id, db());
      return c.json({ ok: true }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/test",
      tags: ["webhooks"],
      summary: "Send a signed test delivery now",
      description:
        "Sends a real `import.done` with obviously fake data, synchronously, and reports what " +
        "the endpoint answered. A bespoke `test` event would exercise a path the subscriber " +
        "does not have.",
      middleware: [requireScope("settings:write")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                ok: z.boolean(),
                status: z.number().nullable(),
                error: z.string().nullable(),
              }),
            },
          },
          description: "What the endpoint answered",
        },
        ...FAILURES,
      },
    }),
    async (c) => c.json(await testSend(c.req.valid("param").id, { db: db() }), 200),
  );

  return app;
}
