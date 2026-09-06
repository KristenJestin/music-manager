/**
 * Settings › API & agents, server side (`docs/phases/P08-api-agents.md`).
 *
 * Keys, webhooks, and the two URLs the page shows. Every one of these is also a REST route —
 * the page could have used `fetch("/api/v1/keys")` — but it uses server functions like every
 * other Console page, for the reason `docs/06-stack.md` gives: *l'UI utilise les server
 * functions, les agents l'API REST/MCP*. Both reach the same service layer, so there is no
 * second implementation, only a second door.
 *
 * The one thing this file must get right is that **a secret is returned exactly once**.
 * `createKey` and `createWebhookEndpoint` are the only functions here that ever return one,
 * and the page shows it in a panel that says so.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import {
  isApiScope,
  MMError,
  NOTIFIABLE_EVENTS,
  notifiableEventSchema,
  SCOPE_DESCRIPTIONS,
  SCOPE_ORDER,
  type ApiKeyView,
  type WebhookView,
} from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { create, list, revoke } from "#/server/services/api-keys.ts";
import {
  create as createHook,
  list as listHooks,
  remove as removeHook,
  testSend,
  update as updateHook,
} from "#/server/services/webhooks.ts";
import { serverEnv } from "#/server/env.ts";

export interface ApiSettingsPayload {
  readonly keys: readonly ApiKeyView[];
  readonly webhooks: readonly WebhookView[];
  readonly scopes: readonly { scope: string; description: string }[];
  readonly events: readonly string[];
  /** The three URLs the page shows so nobody has to guess them. */
  readonly endpoints: {
    readonly base: string;
    readonly openapi: string;
    readonly docs: string;
    readonly mcp: string;
  };
}

export const fetchApiSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async ({ context }): Promise<ApiSettingsPayload> => {
    try {
      const base = serverEnv().MM_WEB_URL.replace(/\/+$/, "");
      return {
        keys: await list(context.session.userId, db()),
        webhooks: await listHooks(db()),
        scopes: SCOPE_ORDER.map((scope) => ({
          scope,
          description: SCOPE_DESCRIPTIONS[scope] ?? "",
        })),
        events: [...NOTIFIABLE_EVENTS],
        endpoints: {
          base: `${base}/api/v1`,
          openapi: `${base}/api/openapi.json`,
          docs: `${base}/api/docs`,
          mcp: `${base}/mcp`,
        },
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const createKey = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      name: z.string().trim().min(1),
      scopes: z.array(z.string()).min(1),
      /** `null` never expires, which is the form's default. */
      expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
    }),
  )
  .handler(async ({ data, context }): Promise<{ key: ApiKeyView; secret: string }> => {
    try {
      const unknown = data.scopes.filter((scope) => !isApiScope(scope));
      if (unknown.length > 0) {
        throw new MMError("INVALID_INPUT", `Unknown scope(s): ${unknown.join(", ")}.`, {
          status: 400,
        });
      }
      const created = await create({
        name: data.name,
        scopes: data.scopes,
        expiresInDays: data.expiresInDays,
        userId: context.session.userId,
      });
      return { key: created.view, secret: created.secret };
    } catch (error) {
      return toFailure(error);
    }
  });

export const revokeKey = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data, context }): Promise<{ ok: true }> => {
    try {
      await revoke(data.id, context.session.userId, db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const createWebhookEndpoint = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      name: z.string().default(""),
      url: z.string().trim().min(1),
      events: z.array(notifiableEventSchema).default([]),
    }),
  )
  .handler(async ({ data }): Promise<{ webhook: WebhookView; secret: string }> => {
    try {
      const created = await createHook(
        { name: data.name, url: data.url, events: data.events },
        db(),
      );
      return { webhook: created.view, secret: created.secret };
    } catch (error) {
      return toFailure(error);
    }
  });

export const deleteWebhookEndpoint = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    try {
      await removeHook(data.id, db());
      return { ok: true };
    } catch (error) {
      return toFailure(error);
    }
  });

export const toggleWebhookEndpoint = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), enabled: z.boolean() }))
  .handler(async ({ data }): Promise<WebhookView> => {
    try {
      return await updateHook(data.id, { enabled: data.enabled }, db());
    } catch (error) {
      return toFailure(error);
    }
  });

export const testWebhookEndpoint = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(
    async ({
      data,
    }): Promise<{ ok: boolean; status: number | null; error: string | null }> => {
      try {
        return await testSend(data.id, { db: db() });
      } catch (error) {
        return toFailure(error);
      }
    },
  );
