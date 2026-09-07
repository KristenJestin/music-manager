/**
 * API keys, as the Console and the API both see them (`docs/phases/P08-api-agents.md`).
 *
 * A thin service over Better Auth's `apiKey` plugin. It exists rather than letting callers
 * reach `auth.api.*` directly for three reasons, each of which is a bug that happened once:
 *
 *  - **`createApiKey` refuses `permissions` when it can see a request.** Its handler computes
 *    `authRequired = ctx.request || ctx.headers`, and every privileged field — `permissions`,
 *    `rateLimitMax`, `remaining`, the refill pair — throws `SERVER_ONLY_PROPERTY` when that is
 *    truthy. So a key with scopes has to be minted *without* headers, passing `userId`
 *    explicitly. That is the opposite of the habit every other Better Auth call teaches, and
 *    it belongs in one place with this comment attached to it.
 *  - **Scopes are not the plugin's `permissions`.** `@mm/contracts` speaks `library:read`;
 *    the plugin stores `{"library":["read"]}`. `permissionsOf` / `scopesOf` convert, and the
 *    wildcard is expanded on the way in — see the note in `contracts/api.ts`.
 *  - **The plaintext exists exactly once.** `createApiKey` is the only call that returns it;
 *    every other endpoint strips it. `create()` therefore returns it once, and nothing else
 *    here ever selects it.
 *
 * Verification deliberately does **not** hand `permissions` to `verifyApiKey`. The plugin
 * answers a failed permission check with `code: "KEY_NOT_FOUND"` — indistinguishable from a
 * key that does not exist — which would make every scope refusal a 401 and every
 * "your key is fine, it just may not do this" message a lie. So the key is verified for
 * *existence* here and the scope is checked in `server/api/auth.ts`, where a miss is a 403
 * that names the scope it wanted.
 */
import { desc, eq } from "drizzle-orm";
import { MMError, permissionsOf, scopesOf, type ApiKeyView } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { apikey } from "#/server/db/schema/auth.ts";
import { getAuth } from "#/server/auth/auth.ts";
import { KEY_RATE_LIMIT } from "#/server/auth/key-rate-limit.ts";

/** What `verifyKey` hands back when a key is good. */
export interface VerifiedKey {
  readonly id: string;
  readonly name: string;
  readonly userId: string;
  readonly scopes: string[];
}

/** Why a key was refused, in terms the HTTP layer can turn into a status. */
export type KeyRefusal =
  | { readonly reason: "invalid"; readonly message: string }
  | { readonly reason: "expired"; readonly message: string }
  | { readonly reason: "disabled"; readonly message: string }
  | { readonly reason: "rateLimited"; readonly message: string; readonly retryAfterMs: number };

export type VerifyOutcome =
  | { readonly ok: true; readonly key: VerifiedKey }
  | { readonly ok: false; readonly refusal: KeyRefusal };

/**
 * Codes the plugin returns that mean "slow down" rather than "no".
 *
 * `USAGE_EXCEEDED` is in here even though it is terminal (the plugin deletes the row) because
 * 429 is still the honest status for it: the request was refused for volume, not for identity.
 */
const RATE_CODES = new Set(["RATE_LIMITED", "RATE_LIMIT_EXCEEDED", "USAGE_EXCEEDED"]);

/**
 * Verify a presented secret.
 *
 * Never throws for a bad key — `verifyApiKey` catches internally and reports through its
 * return value, and a caller that had to wrap this in a `try` would be tempted to treat a
 * database outage and a typo'd key the same way.
 */
export async function verifyKey(secret: string): Promise<VerifyOutcome> {
  const auth = await getAuth();
  const result = await auth.api.verifyApiKey({ body: { key: secret } });

  if (!result.valid || result.key === null || result.key === undefined) {
    const code = result.error?.code ?? "INVALID_API_KEY";
    if (RATE_CODES.has(code)) {
      const details = (result.error as { details?: { tryAgainIn?: number } } | null)?.details;
      return {
        ok: false,
        refusal: {
          reason: "rateLimited",
          message: "This key has made too many requests.",
          retryAfterMs: details?.tryAgainIn ?? 60_000,
        },
      };
    }
    if (code === "KEY_EXPIRED") {
      return { ok: false, refusal: { reason: "expired", message: "This key has expired." } };
    }
    if (code === "KEY_DISABLED") {
      return { ok: false, refusal: { reason: "disabled", message: "This key is disabled." } };
    }
    return { ok: false, refusal: { reason: "invalid", message: "Unknown API key." } };
  }

  const row = result.key;
  return {
    ok: true,
    key: {
      id: row.id,
      name: row.name ?? "unnamed",
      userId: row.referenceId,
      scopes: scopesOf(row.permissions ?? null),
    },
  };
}

export interface CreateKeyInput {
  readonly name: string;
  readonly scopes: readonly string[];
  /** Days until expiry. `null` never expires, which is the Console's default. */
  readonly expiresInDays: number | null;
  readonly userId: string;
}

export interface CreatedKey {
  readonly view: ApiKeyView;
  /** The plaintext. Shown once, stored nowhere, never returned again. */
  readonly secret: string;
}

/** Mint a key. See the module note on why this must not be given request headers. */
export async function create(input: CreateKeyInput): Promise<CreatedKey> {
  if (input.name.trim() === "") {
    throw new MMError("INVALID_INPUT", "A key needs a name.", {
      hint: "Name it after the agent that will hold it.",
      status: 400,
    });
  }
  if (input.scopes.length === 0) {
    throw new MMError("INVALID_INPUT", "A key with no scope can do nothing.", {
      hint: "Tick at least one scope, or `*` for everything.",
      status: 400,
    });
  }

  const auth = await getAuth();
  const created = await auth.api.createApiKey({
    body: {
      name: input.name.trim(),
      // Days on the form, seconds on the wire.
      expiresIn: input.expiresInDays === null ? null : input.expiresInDays * 24 * 60 * 60,
      permissions: permissionsOf(input.scopes),
      // The literal scopes as ticked, so a key created with `*` can be *shown* as `*`
      // rather than as the ten pairs the permission check needs.
      metadata: { scopes: [...input.scopes] },
      userId: input.userId,
    },
  });

  return {
    view: toView({
      ...created,
      permissions: created.permissions ?? permissionsOf(input.scopes),
    }),
    secret: created.key,
  };
}

/**
 * Every key, newest first. The secret is not selected; there is nothing to select.
 *
 * Read straight from the table rather than through `auth.api.listApiKeys`, which is
 * session-bound: it takes the caller's headers to decide whose keys to return, and this is
 * also called from a REST route authenticated by a key rather than by a cookie. The row is
 * the same row either way, and `key` — the hash — is simply never selected.
 */
export async function list(userId: string, db: Database = defaultDb()): Promise<ApiKeyView[]> {
  const rows = await db
    .select({
      id: apikey.id,
      name: apikey.name,
      start: apikey.start,
      enabled: apikey.enabled,
      createdAt: apikey.createdAt,
      expiresAt: apikey.expiresAt,
      lastRequest: apikey.lastRequest,
      requestCount: apikey.requestCount,
      rateLimitEnabled: apikey.rateLimitEnabled,
      rateLimitMax: apikey.rateLimitMax,
      rateLimitTimeWindow: apikey.rateLimitTimeWindow,
      permissions: apikey.permissions,
      metadata: apikey.metadata,
    })
    .from(apikey)
    .where(eq(apikey.referenceId, userId))
    .orderBy(desc(apikey.createdAt));

  return rows.map((row) =>
    toView({
      ...row,
      permissions: parseJson<Record<string, string[]>>(row.permissions),
      metadata: parseJson<Record<string, unknown>>(row.metadata),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* the request budget, as a caller can read it                         */
/* ------------------------------------------------------------------ */

/** What is left of a key's budget, in the terms the 429 uses. */
export interface RateLimitView {
  readonly enabled: boolean;
  /** Requests allowed per window. */
  readonly max: number;
  readonly windowMs: number;
  /** Requests still available in the window in flight. */
  readonly remaining: number;
  /** When the current window started, or `null` when the key has never been used. */
  readonly windowStartedAt: string | null;
  readonly note: string;
}

/**
 * What is left of `keyId`'s budget right now.
 *
 * Read from the row rather than asked of the plugin, because the plugin has no endpoint for
 * "how many do I have left" — it only tells you by refusing. That refusal is a 429 with a
 * countdown, which is a fine thing to receive and a terrible thing to *discover*: the report
 * followed the server's own instruction to poll, hit the ceiling at request 601, and read the
 * result as `get_import` being broken during downloads.
 *
 * The arithmetic mirrors the plugin's: `requestCount` is reset the first time a key is used
 * more than `timeWindow` after `lastRequest`, so a key idle for longer than the window has its
 * whole budget back whatever the stored counter says.
 */
export async function rateLimitFor(
  keyId: string,
  options: { db?: Database; now?: Date } = {},
): Promise<RateLimitView | null> {
  const database = options.db ?? defaultDb();
  const now = options.now ?? new Date();
  const [row] = await database
    .select({
      enabled: apikey.rateLimitEnabled,
      max: apikey.rateLimitMax,
      windowMs: apikey.rateLimitTimeWindow,
      requestCount: apikey.requestCount,
      lastRequest: apikey.lastRequest,
    })
    .from(apikey)
    .where(eq(apikey.id, keyId))
    .limit(1);
  if (row === undefined) return null;

  const max = row.max ?? KEY_RATE_LIMIT.maxRequests;
  const windowMs = row.windowMs ?? KEY_RATE_LIMIT.timeWindowMs;
  const last = row.lastRequest;
  const windowOpen = last !== null && now.getTime() - last.getTime() < windowMs;
  const used = windowOpen ? row.requestCount : 0;

  return {
    enabled: row.enabled,
    max,
    windowMs,
    remaining: row.enabled ? Math.max(0, max - used) : max,
    windowStartedAt: windowOpen ? last.toISOString() : null,
    note: row.enabled
      ? `${String(max)} request(s) per ${String(Math.round(windowMs / 1000))}s on this key; exceeding it answers 429 RATE_LIMITED with a countdown.`
      : "This key has no rate limit.",
  };
}

/** The plugin stores both JSON columns as text. A hand-edited row must not crash the page. */
function parseJson<T>(raw: string | null): T | null {
  if (raw === null || raw === "") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Revoke a key.
 *
 * A hard delete rather than `enabled: false`. A revoked key is not a key you might want back
 * — its secret is on somebody's disk — and a row that lingers disabled is a row somebody will
 * eventually re-enable instead of issuing a fresh one.
 */
export async function revoke(
  id: string,
  userId: string,
  db: Database = defaultDb(),
): Promise<void> {
  const [row] = await db
    .select({ referenceId: apikey.referenceId })
    .from(apikey)
    .where(eq(apikey.id, id));
  if (row === undefined || row.referenceId !== userId) {
    throw new MMError("NOT_FOUND", `No API key with id ${id}.`, { status: 404 });
  }
  await db.delete(apikey).where(eq(apikey.id, id));
}

/** The plugin's row, as the Console and the REST API show it. */
function toView(row: {
  id: string;
  name?: string | null;
  start?: string | null;
  enabled?: boolean;
  createdAt: Date | string;
  expiresAt?: Date | string | null;
  lastRequest?: Date | string | null;
  requestCount?: number;
  rateLimitEnabled?: boolean;
  rateLimitMax?: number | null;
  rateLimitTimeWindow?: number | null;
  permissions?: Record<string, string[]> | null;
  metadata?: Record<string, unknown> | null;
}): ApiKeyView {
  const asked = row.metadata?.["scopes"];
  return {
    id: row.id,
    name: row.name ?? "unnamed",
    start: row.start ?? null,
    // Prefer what the user actually ticked; fall back to folding the stored permissions.
    scopes: Array.isArray(asked) ? (asked as string[]) : scopesOf(row.permissions ?? null),
    enabled: row.enabled ?? true,
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
    expiresAt: iso(row.expiresAt),
    lastRequest: iso(row.lastRequest),
    requestCount: row.requestCount ?? 0,
    rateLimitEnabled: row.rateLimitEnabled ?? true,
    rateLimitMax: row.rateLimitMax ?? null,
    rateLimitTimeWindow: row.rateLimitTimeWindow ?? null,
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
