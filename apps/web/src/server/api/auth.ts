/**
 * Who is calling `/api/v1`, and may they do this? (`docs/phases/P08-api-agents.md`.)
 *
 * Two credentials are equivalent, as the spec asks: a **session cookie** — so the Console's
 * own fetches and a `curl -b` from a signed-in browser work — and an **API key**, presented
 * as `x-api-key` or `Authorization: Bearer`. They differ in exactly one way, and it is the
 * point of the whole module: a session carries every scope, a key carries the scopes it was
 * issued with.
 *
 * **401 and 403 are kept apart on purpose.** "I do not know who you are" and "I know who you
 * are and you may not do this" are different problems with different fixes, and an API that
 * answers 401 to both sends people to re-issue a key that was working perfectly. This is also
 * why the scope check happens here rather than by handing `permissions` to Better Auth's
 * `verifyApiKey`: that call reports a permission failure as `KEY_NOT_FOUND`, which would make
 * every 403 a 401 and every message a lie. See `services/api-keys.ts`.
 *
 * The guard is a Hono middleware factory rather than a function each handler calls, because a
 * guard you have to remember is a guard you will forget — the same reasoning that made
 * `sessionMiddleware` the only way to declare a server function.
 */
import { createMiddleware } from "hono/factory";
import { grants, MMError, type ApiPrincipal, type ApiScope } from "@mm/contracts";
import { getSession } from "#/server/auth/session.ts";
import { verifyKey } from "#/server/services/api-keys.ts";

/** What the handlers read off the context. */
export interface ApiEnv {
  readonly Variables: {
    principal: ApiPrincipal;
  };
}

/** A session may do anything the Console may do, which is everything. */
const SESSION_SCOPES = ["*"];

/**
 * Pull the presented secret out of the request.
 *
 * Both spellings are accepted because both are idiomatic somewhere: `x-api-key` is what
 * Better Auth's plugin defaults to and what most dashboards show, `Authorization: Bearer` is
 * what every HTTP client, the MCP specification and `curl -H` reach for first.
 */
export function presentedKey(request: Request): string | null {
  const header = request.headers.get("x-api-key");
  if (header !== null && header.trim() !== "") return header.trim();
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match?.[1]?.trim() ?? null;
}

export type Resolution =
  | { readonly ok: true; readonly principal: ApiPrincipal }
  | { readonly ok: false; readonly status: number; readonly error: MMError };

/**
 * Identify the caller. Does not consider scopes — that is `requireScope`'s job.
 *
 * The key is tried first. A request that carries one is *asking* to be judged as that key;
 * falling back to an ambient cookie because the key was expired would silently give a
 * revoked credential the powers of whoever happened to be signed in in the same browser.
 */
export async function resolvePrincipal(request: Request): Promise<Resolution> {
  const secret = presentedKey(request);

  if (secret !== null) {
    const outcome = await verifyKey(secret);
    if (!outcome.ok) {
      const { refusal } = outcome;
      if (refusal.reason === "rateLimited") {
        return {
          ok: false,
          status: 429,
          error: new MMError("RATE_LIMITED", refusal.message, {
            hint: `Try again in ${String(Math.ceil(refusal.retryAfterMs / 1000))}s.`,
            status: 429,
          }),
        };
      }
      return {
        ok: false,
        status: 401,
        error: new MMError("UNAUTHORIZED", refusal.message, {
          hint: "Check the key, or issue a new one in Settings › API & agents.",
          action: "Issue a new key",
          status: 401,
        }),
      };
    }
    return {
      ok: true,
      principal: {
        kind: "apiKey",
        userId: outcome.key.userId,
        label: outcome.key.name,
        scopes: outcome.key.scopes,
      },
    };
  }

  const session = await getSession(request.headers);
  if (session !== null) {
    return {
      ok: true,
      principal: {
        kind: "session",
        userId: session.userId,
        label: session.email,
        scopes: SESSION_SCOPES,
      },
    };
  }

  return {
    ok: false,
    status: 401,
    error: new MMError("UNAUTHORIZED", "This endpoint needs a session or an API key.", {
      hint: "Send `x-api-key: mm_…`, or `Authorization: Bearer mm_…`.",
      action: "Issue a key in Settings › API & agents",
      status: 401,
    }),
  };
}

/** The error body every refusal uses. Same shape as `MMError.toBody()` everywhere else. */
export function errorBody(error: MMError): { error: ReturnType<MMError["toBody"]> } {
  return { error: error.toBody() };
}

/**
 * The guard. `app.use("/imports/*", requireScope("imports:write"))`, or per route.
 *
 * On success the principal is on the context, so a handler that wants to know who is calling
 * — `/me`, the audit line in a log — reads it rather than re-deriving it.
 */
export function requireScope(scope: ApiScope) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const resolution = await resolvePrincipal(c.req.raw);
    if (!resolution.ok) {
      return c.json(errorBody(resolution.error), resolution.status as 401);
    }
    if (!grants(resolution.principal.scopes, scope)) {
      return c.json(
        errorBody(
          new MMError("FORBIDDEN", `This key does not carry the \`${scope}\` scope.`, {
            hint: `It has: ${resolution.principal.scopes.join(", ") || "no scopes"}.`,
            action: "Issue a key with that scope",
            details: { required: scope, granted: resolution.principal.scopes },
            status: 403,
          }),
        ),
        403,
      );
    }
    c.set("principal", resolution.principal);
    await next();
    return undefined;
  });
}
