/**
 * The public API's vocabulary: scopes, and the shapes every client shares.
 *
 * `docs/phases/P08-api-agents.md`: the REST API, the MCP server and the remote CLI are the
 * same capabilities as the Console, so they are the same schemas. This module is the part of
 * that which the browser may also see — it is `@mm/contracts`, so it must stay free of
 * anything server-only (no Drizzle, no `node:` imports, no environment).
 *
 * **A scope is `resource:action`.** That is not decoration: Better Auth's `apiKey` plugin
 * stores permissions as `Record<resource, action[]>`, so a scope string and a permission
 * entry are two spellings of one fact, and `parseScope` / `permissionsOf` convert between
 * them without a table of special cases.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* scopes                                                              */
/* ------------------------------------------------------------------ */

/** The five things an API key can be given power over. */
export const API_RESOURCES = ["imports", "library", "review", "settings", "tools"] as const;
export type ApiResource = (typeof API_RESOURCES)[number];

/** What it may do with one. `write` implies `read`; see `grants`. */
export const API_ACTIONS = ["read", "write"] as const;
export type ApiAction = (typeof API_ACTIONS)[number];

/**
 * Every scope string, plus the wildcard.
 *
 * The wildcard exists because the overwhelmingly common case for a self-hosted, single-user
 * application is "a key for my own agent, which does everything". Making that spellable in
 * one token is what stops people from ticking all ten boxes and then never revisiting them.
 */
export const API_SCOPES = [
  "*",
  ...API_RESOURCES.flatMap((resource) => API_ACTIONS.map((action) => `${resource}:${action}`)),
] as const;

export type ApiScope = (typeof API_SCOPES)[number];
export const apiScopeSchema = z.enum(API_SCOPES);

/** The scopes named by the phase spec, in the order the Settings page offers them. */
export const SCOPE_ORDER: readonly ApiScope[] = [
  "imports:read",
  "imports:write",
  "library:read",
  "library:write",
  "review:read",
  "review:write",
  "settings:read",
  "settings:write",
  "tools:read",
  "tools:write",
  "*",
];

/** One line of help per scope, shown next to the checkbox and in the OpenAPI document. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "*": "Everything. Equivalent to the signed-in Console.",
  "imports:read": "List and inspect imports, their steps and their journal.",
  "imports:write": "Create imports, retry a step, cancel, pause, bump, confirm a mapping.",
  "library:read": "Browse albums, tracks, artists, search and quality scores.",
  "library:write": "Re-tag files and delete albums or tracks.",
  "review:read": "List and inspect Inbox items.",
  "review:write": "Resolve or dismiss Inbox items.",
  "settings:read": "Read the settings, with secrets masked.",
  "settings:write": "Change the settings.",
  "tools:read": "Health, the downloader's status, the error catalogue.",
  "tools:write": "Update yt-dlp, run a self-test, start a scan or a library verification.",
};

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

/** Split `library:read` into its two halves. Returns `null` for `*` and for nonsense. */
export function parseScope(scope: string): { resource: ApiResource; action: ApiAction } | null {
  const [resource, action] = scope.split(":");
  if (resource === undefined || action === undefined) return null;
  if (!(API_RESOURCES as readonly string[]).includes(resource)) return null;
  if (!(API_ACTIONS as readonly string[]).includes(action)) return null;
  return { resource: resource as ApiResource, action: action as ApiAction };
}

/**
 * Does a key holding `granted` satisfy `required`?
 *
 * Two implications, and only two: `*` grants everything, and `x:write` grants `x:read`. The
 * second is what stops the Settings page from being a puzzle — nobody expects a key that may
 * *change* the settings to be refused permission to *read* them, and a key that had to carry
 * both would make the checkbox list twice as long for no gain in expressiveness.
 */
export function grants(granted: readonly string[], required: ApiScope): boolean {
  if (required === "*") return granted.includes("*");
  if (granted.includes("*") || granted.includes(required)) return true;
  const wanted = parseScope(required);
  if (wanted === null) return false;
  return wanted.action === "read" && granted.includes(`${wanted.resource}:write`);
}

/**
 * Scope strings as Better Auth stores them.
 *
 * The wildcard is expanded rather than stored as a resource of its own: the plugin's own
 * `verifyApiKey` compares `Record<resource, action[]>` set-wise and knows nothing about our
 * `*`, so a key that meant "everything" but was stored as `{"*": ["*"]}` would fail every
 * check the plugin performed. It is expanded on the way in and folded back on the way out.
 */
export function permissionsOf(scopes: readonly string[]): Record<string, string[]> {
  const effective = scopes.includes("*")
    ? API_RESOURCES.flatMap((resource) => API_ACTIONS.map((action) => `${resource}:${action}`))
    : scopes;
  const out: Record<string, string[]> = {};
  for (const scope of effective) {
    const parsed = parseScope(scope);
    if (parsed === null) continue;
    const actions = (out[parsed.resource] ??= []);
    if (!actions.includes(parsed.action)) actions.push(parsed.action);
  }
  return out;
}

/** The inverse of `permissionsOf`: fold a full grant back into the `*` the user ticked. */
export function scopesOf(permissions: Record<string, string[]> | null | undefined): ApiScope[] {
  if (permissions === null || permissions === undefined) return [];
  const scopes: ApiScope[] = [];
  for (const resource of API_RESOURCES) {
    for (const action of API_ACTIONS) {
      if (permissions[resource]?.includes(action) === true) scopes.push(`${resource}:${action}`);
    }
  }
  const total = API_RESOURCES.length * API_ACTIONS.length;
  return scopes.length === total ? ["*"] : scopes;
}

/* ------------------------------------------------------------------ */
/* the wire shapes the Console, the CLI and the MCP server all use      */
/* ------------------------------------------------------------------ */

/** How the caller proved who they are. Echoed by `GET /api/v1/me`, and useful in a log. */
export const apiPrincipalSchema = z.object({
  kind: z.enum(["session", "apiKey"]),
  userId: z.string(),
  /** The key's name, or the user's e-mail for a session. */
  label: z.string(),
  scopes: z.array(z.string()),
  /**
   * The `apikey` row's id, for an `apiKey` principal only.
   *
   * It is here so a caller can be told what is left of *its own* request budget — the rate
   * limit is per key, and `get_status.rateLimit` cannot report a budget it cannot find the row
   * for. Never the secret, and never anything a session has.
   */
  keyId: z.string().optional(),
});
export type ApiPrincipal = z.infer<typeof apiPrincipalSchema>;

/** An API key as it is listed. The secret is **not** here; it exists once, at creation. */
export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The first characters of the key, so a row can be told apart from its neighbours. */
  start: z.string().nullable(),
  scopes: z.array(z.string()),
  enabled: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  lastRequest: z.string().nullable(),
  requestCount: z.number(),
  rateLimitEnabled: z.boolean(),
  rateLimitMax: z.number().nullable(),
  rateLimitTimeWindow: z.number().nullable(),
});
export type ApiKeyView = z.infer<typeof apiKeySchema>;

/* ------------------------------------------------------------------ */
/* webhooks                                                            */
/* ------------------------------------------------------------------ */

/**
 * The events a webhook or a notification can subscribe to.
 *
 * A deliberately short list: these are the five moments at which a human would want to be
 * told something, not a mirror of the job journal. `job_events` already carries the journal,
 * and `GET /api/v1/events` already streams it.
 */
export const NOTIFIABLE_EVENTS = [
  "import.done",
  "import.failed",
  "review.needed",
  "ytdlp.updated",
  "cookies.expiring",
] as const;
export type NotifiableEvent = (typeof NOTIFIABLE_EVENTS)[number];
export const notifiableEventSchema = z.enum(NOTIFIABLE_EVENTS);

export const EVENT_DESCRIPTIONS: Record<NotifiableEvent, string> = {
  "import.done": "An import finished and its files are in the library.",
  "import.failed": "An import stopped on an error.",
  "review.needed": "The pipeline is waiting for a decision in the Inbox.",
  "ytdlp.updated": "yt-dlp was updated, successfully or not.",
  "cookies.expiring": "The YouTube cookies are close to expiry, or already unusable.",
};

/** What a delivery carries. Stable: it is the body a third party parses. */
export const webhookPayloadSchema = z.object({
  /** `evt_…`, unique per delivery attempt chain. Use it to deduplicate. */
  id: z.string(),
  event: notifiableEventSchema,
  /** RFC 3339, UTC. */
  at: z.string(),
  /** Which installation sent this. `MM_WEB_URL`. */
  source: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/** The header carrying `t=<unix seconds>,v1=<hex hmac-sha256>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-mm-signature";
export const WEBHOOK_EVENT_HEADER = "x-mm-event";
export const WEBHOOK_DELIVERY_HEADER = "x-mm-delivery";

export const webhookSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  events: z.array(notifiableEventSchema),
  enabled: z.boolean(),
  createdAt: z.string(),
  lastStatus: z.number().nullable(),
  lastError: z.string().nullable(),
  lastDeliveryAt: z.string().nullable(),
  failureCount: z.number(),
});
export type WebhookView = z.infer<typeof webhookSchema>;
