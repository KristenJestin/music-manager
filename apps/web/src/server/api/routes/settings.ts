/**
 * `/api/v1/settings` — the typed registry, over HTTP.
 *
 * Two rules, both inherited rather than invented:
 *
 *  - **Secrets are masked on the way out.** `maskedSettings()` is the same function the CLI's
 *    `mm settings list` uses, so a credential cannot leak through the API that does not also
 *    leak through the terminal — and neither does. There is no query parameter to unmask;
 *    an API that could return the AcoustID key would be a worse place to keep it than a file.
 *  - **Each value is parsed by its own key's schema.** The patch body is an open record
 *    because the registry has some seventy keys, but nothing is written without going through
 *    `setSetting`, which parses. An unknown key is a 400 rather than a silent no-op, because
 *    a typo'd setting that reports success is how you spend an afternoon.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import {
  isSettingKey,
  loadSettings,
  maskedSettings,
  SETTING_DEFINITIONS,
  setSetting,
} from "#/server/services/settings.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import { errorSchema, patchSettingsSchema, settingsSchema } from "#/server/api/schemas.ts";

const TAG = "settings";

const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Unknown key" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
} as const;

export function settingsRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "Every setting, with secrets masked",
      middleware: [requireScope("settings:read")] as const,
      responses: {
        200: {
          content: { "application/json": { schema: settingsSchema } },
          description: "The settings",
        },
        ...FAILURES,
      },
    }),
    async (c) => c.json(maskedSettings(await loadSettings(db())), 200),
  );

  /**
   * The registry itself: every key, its default and the sentence explaining it.
   *
   * Worth its own endpoint because an agent that may change a setting needs to know what the
   * setting *means* and what it may legally be set to, and the alternative is that it guesses.
   */
  app.openapi(
    createRoute({
      method: "get",
      path: "/schema",
      tags: [TAG],
      summary: "What each setting is for, and what it defaults to",
      middleware: [requireScope("settings:read")] as const,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                keys: z.array(
                  z.object({
                    key: z.string(),
                    doc: z.string(),
                    default: z.unknown(),
                    secret: z.boolean(),
                  }),
                ),
              }),
            },
          },
          description: "The registry",
        },
        ...FAILURES,
      },
    }),
    (c) =>
      c.json(
        {
          keys: Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => ({
            key,
            doc: definition.doc,
            // A secret's *default* is the empty string, so this leaks nothing.
            default: definition.default,
            secret: definition.secret === true,
          })),
        },
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/",
      tags: [TAG],
      summary: "Change a subset of the settings",
      description:
        "Send only the keys you mean to change. Each is validated by that key's own schema; " +
        "an unknown key refuses the whole request rather than being ignored.",
      middleware: [requireScope("settings:write")] as const,
      request: {
        body: { content: { "application/json": { schema: patchSettingsSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ saved: z.array(z.string()), settings: settingsSchema }),
            },
          },
          description: "Saved",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const patch = c.req.valid("json");
      const unknown = Object.keys(patch).filter((key) => !isSettingKey(key));
      if (unknown.length > 0) {
        throw new MMError("INVALID_INPUT", `Unknown setting(s): ${unknown.join(", ")}.`, {
          hint: "GET /api/v1/settings/schema lists every key.",
          details: { unknown },
          status: 400,
        });
      }
      const saved: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (!isSettingKey(key)) continue;
        // `setSetting` parses with the key's own zod schema and throws INVALID_INPUT on a
        // mismatch, which becomes a 400 with the key named in it.
        await setSetting(key, value as never, { db: db(), setBy: "api" });
        saved.push(key);
      }
      return c.json({ saved, settings: maskedSettings(await loadSettings(db())) }, 200);
    },
  );

  return app;
}
