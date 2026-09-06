/**
 * The zod schemas `/api/v1` validates with and generates its OpenAPI document from.
 *
 * These deliberately *reuse* the shapes the server functions already parse — the wizard's
 * `startInput`, the settings registry, the Inbox's resolution — rather than restating them.
 * `docs/phases/P08-api-agents.md` asks for "schémas zod partagés avec les server functions",
 * and the reason is stronger than tidiness: a REST route that accepted a slightly different
 * mapping payload from the one the Console sends would be a second, untested way to start an
 * import, and the first one to drift would be the one nobody was looking at.
 *
 * `.openapi()` names a schema so it appears once under `components/schemas` and is referenced
 * everywhere else. Without it the document inlines the same object thirty times and is
 * unreadable in Scalar.
 */
import { z } from "@hono/zod-openapi";
import { NOTIFIABLE_EVENTS, STEP_NAMES } from "@mm/contracts";
import type {
  ApiKeyView,
  ApiPrincipal,
  JobEventPayload,
  MMErrorBody,
  WebhookView,
} from "@mm/contracts";

/**
 * ## Why the shared shapes are re-declared here rather than imported
 *
 * `@mm/contracts` builds its schemas with plain `zod`, as it must: it is loaded in the browser
 * too and has no business depending on a server-side OpenAPI generator. `.openapi()` is an
 * extension that `@hono/zod-openapi` applies to **its** zod. Under Bun the two resolve to one
 * module and calling `.openapi()` on a contracts schema appears to work; under Vite's SSR
 * module runner they are two distinct copies, and it fails at *import* time with
 * `apiPrincipalSchema.openapi is not a function` — so `/api/v1` answered 500 before any
 * handler ran, in `vite dev` only. Patching the other copy's prototype was tried and is worse:
 * it depends on which of two module graphs wins, which is not a thing to build an API on.
 *
 * So the half-dozen shapes that cross this boundary are declared below with the local `z`, and
 * each is annotated with the contracts **type** it must satisfy. A field added there and
 * forgotten here is then a type error rather than a silently thinner API. The types are the
 * contract; these are its OpenAPI projection.
 */
const mmErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<MMErrorBody>;

const apiPrincipalSchema = z.object({
  kind: z.enum(["session", "apiKey"]),
  userId: z.string(),
  label: z.string(),
  scopes: z.array(z.string()),
}) satisfies z.ZodType<ApiPrincipal>;

const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
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
}) satisfies z.ZodType<ApiKeyView>;

const notifiableEventSchema = z.enum(NOTIFIABLE_EVENTS);

const webhookSchema = z.object({
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
}) satisfies z.ZodType<WebhookView>;

const jobEventSchema = z.object({
  id: z.number(),
  importId: z.string().nullable(),
  trackId: z.string().nullable(),
  step: z.enum(STEP_NAMES).nullable(),
  level: z.enum(["info", "warn", "error"]),
  type: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  at: z.string(),
}) satisfies z.ZodType<JobEventPayload>;

/* ------------------------------------------------------------------ */
/* the common ones                                                     */
/* ------------------------------------------------------------------ */

export const errorSchema = z
  .object({ error: mmErrorBodySchema })
  .openapi("Error", {
    description:
      "Every failure, everywhere, in one shape. `code` is stable and machine-readable; " +
      "`hint` and `action` are for a human or an agent deciding what to do next.",
  });

/** The id in a path. Named so the document says `imp_…` rather than `string`. */
export const idParam = z.string().min(1).openapi({ example: "imp_01K4XQ7N8ZC3RB2VMD9T6HFPGA" });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).openapi({ example: 50 }),
  offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
});

export const principalSchema = apiPrincipalSchema.openapi("Principal", {
  description: "Who the server thinks you are, and what your credential may do.",
});

export const okSchema = z.object({ ok: z.boolean() }).openapi("Ok");

/* ------------------------------------------------------------------ */
/* imports                                                             */
/* ------------------------------------------------------------------ */

/**
 * The options an import carries. Same four booleans the wizard's step 4 offers.
 *
 * `autoConfirm` is the API's equivalent of pressing Start: an agent that has already decided
 * does not want the pipeline to stop and raise an Inbox item asking it to confirm.
 */
export const importOptionsSchema = z
  .object({
    fingerprint: z.boolean().default(true),
    lyrics: z.boolean().default(true),
    replaygain: z.boolean().default(true),
    force: z.boolean().default(false),
    autoConfirm: z.boolean().default(false),
  })
  .openapi("ImportOptions");

export const createImportSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .openapi({ example: "fixture://discovery", description: "A YouTube URL, or `fixture://…`." }),
    releaseMbid: z
      .string()
      .nullish()
      .openapi({ description: "Pin the MusicBrainz release instead of letting the matcher pick." }),
    options: importOptionsSchema.optional(),
    priority: z.enum(["low", "normal", "next"]).default("normal"),
  })
  .openapi("CreateImport");

export const importSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    kind: z.string(),
    status: z.string(),
    step: z.string(),
    title: z.string().nullable(),
    artist: z.string().nullable(),
    year: z.number().nullable(),
    releaseMbid: z.string().nullable(),
    priority: z.number(),
    error: mmErrorBodySchema.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Import");

export const importDetailSchema = importSchema
  .extend({
    steps: z.array(
      z.object({
        step: z.string(),
        status: z.string(),
        message: z.string().nullable(),
        startedAt: z.string().nullable(),
        finishedAt: z.string().nullable(),
      }),
    ),
    tracks: z.array(
      z.object({
        id: z.string(),
        position: z.number(),
        videoId: z.string(),
        title: z.string(),
        durationSeconds: z.number().nullable(),
        status: z.string(),
      }),
    ),
    inbox: z.array(
      z.object({ id: z.string(), type: z.string(), title: z.string(), status: z.string() }),
    ),
  })
  .openapi("ImportDetail");

export const listImportsQuery = paginationQuery.extend({
  status: z.string().optional().openapi({ description: "Filter on one import status." }),
  q: z.string().optional().openapi({ description: "Substring of the title or the URL." }),
});

export const retryStepSchema = z
  .object({ step: z.string().min(1).openapi({ example: "download" }) })
  .openapi("RetryStep");

/**
 * `POST /imports/{id}/confirm-mapping`.
 *
 * Field-for-field the wizard's `startInput` minus `importId`, which is in the path. The
 * comments there are the authority; the one thing worth repeating is that `releaseMbid: null`
 * is not "unknown", it is the deliberate **import without MusicBrainz** of P07a.
 */
export const confirmMappingSchema = z
  .object({
    releaseMbid: z.string().min(1).nullable(),
    releaseGroupMbid: z.string().nullable().default(null),
    album: z.string().default(""),
    albumArtist: z.string().default(""),
    year: z.number().int().nullable().default(null),
    trackTotal: z.number().int().min(0).default(0),
    bindings: z
      .array(
        z.object({
          position: z.number().int().min(0),
          trackPosition: z.number().int().min(1),
          mediumPosition: z.number().int().min(1).default(1),
          trackMbid: z.string().nullable().default(null),
          recordingMbid: z.string().nullable(),
          trackTitle: z.string().default(""),
          confidence: z.number().min(0).max(1).default(1),
        }),
      )
      .min(1),
    options: importOptionsSchema.optional(),
    priority: z.enum(["low", "normal", "next"]).default("normal"),
  })
  .openapi("ConfirmMapping");

export const candidatesSchema = z
  .object({
    kind: z.enum(["album", "single"]),
    releases: z.array(z.record(z.string(), z.unknown())),
    recordings: z.array(z.record(z.string(), z.unknown())),
    preselectedId: z.string().nullable(),
    safe: z.boolean(),
    ambiguous: z.boolean(),
    margin: z.number().nullable(),
    budget: z.object({ searches: z.number(), lookups: z.number() }),
    hints: z.object({ album: z.string().nullable(), artist: z.string().nullable() }),
  })
  .openapi("Candidates", {
    description:
      "The ranked MusicBrainz candidates, exactly as the Console's wizard shows them. " +
      "`releases`/`recordings` are the `ReleaseCandidate`/`RecordingCandidate` of packages/domain.",
  });

/* ------------------------------------------------------------------ */
/* inbox                                                               */
/* ------------------------------------------------------------------ */

export const inboxItemSchema = z
  .object({
    id: z.string(),
    importId: z.string().nullable(),
    type: z.string(),
    status: z.string(),
    title: z.string(),
    detail: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()).nullable(),
    preselected: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
  })
  .openapi("InboxItem");

export const resolveInboxSchema = z
  .object({
    /** `true` takes the preselection; `false` dismisses the question. */
    accept: z.boolean(),
    /** Overrides the preselected answer when accepting. */
    resolution: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("ResolveInbox");

/* ------------------------------------------------------------------ */
/* library                                                             */
/* ------------------------------------------------------------------ */

export const albumSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    albumArtist: z.string(),
    year: z.number().nullable(),
    folder: z.string(),
    releaseMbid: z.string().nullable(),
    trackCount: z.number(),
    presentCount: z.number(),
    score: z.number().nullable(),
  })
  .openapi("Album");

export const listAlbumsQuery = paginationQuery.extend({
  filter: z.string().optional(),
  profile: z.string().optional(),
  q: z.string().optional(),
});

export const listTracksQuery = paginationQuery.extend({
  search: z.string().optional(),
  filter: z.string().optional(),
  albumId: z.string().optional(),
});

export const searchQuery = z.object({
  q: z.string().min(1).openapi({ example: "discovery" }),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const retagSchema = z
  .object({
    albumId: z.string().optional(),
    trackId: z.string().optional(),
    dryRun: z.boolean().default(false),
    /** `false` re-tags everything in scope, not only the files behind the schema. */
    onlyBehind: z.boolean().default(true),
    /** Hand it to the worker instead of running it in this request. */
    queue: z.boolean().default(true),
  })
  .openapi("Retag");

export const verifySchema = z
  .object({
    albumId: z.string().optional().openapi({ description: "Omit to verify the whole library." }),
    rescan: z.boolean().default(false),
  })
  .openapi("Verify");

/* ------------------------------------------------------------------ */
/* settings, tools, events                                             */
/* ------------------------------------------------------------------ */

export const settingsSchema = z
  .record(z.string(), z.unknown())
  .openapi("Settings", { description: "Every key of the registry. Secrets are masked." });

/**
 * A settings patch: any subset of the registry.
 *
 * Not a closed object, because the registry has ~70 keys and enumerating them here would be a
 * second copy that drifts. Each value is validated by that key's own zod schema inside
 * `setSetting`, which is where the authority already lives.
 */
export const patchSettingsSchema = z
  .record(z.string(), z.unknown())
  .openapi("SettingsPatch", { description: "A partial settings object. Unknown keys are refused." });

export const healthSchema = z
  .object({
    ok: z.boolean(),
    version: z.string(),
    fixtures: z.boolean(),
    toolbox: z.record(z.string(), z.unknown()),
    database: z.object({ ok: z.boolean() }),
  })
  .openapi("Health");

export const eventSchema = jobEventSchema.openapi("JobEvent");

export const listEventsQuery = z.object({
  importId: z.string().optional(),
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/* ------------------------------------------------------------------ */
/* keys and webhooks                                                   */
/* ------------------------------------------------------------------ */

export const keySchema = apiKeySchema.openapi("ApiKey");

export const createKeySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "claude-desktop" }),
    scopes: z.array(z.string()).min(1).openapi({ example: ["imports:write", "library:read"] }),
    expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
  })
  .openapi("CreateApiKey");

export const createdKeySchema = keySchema
  .extend({
    /** Shown once. There is no endpoint that returns it again. */
    key: z.string().openapi({ example: "mm_xxxxxxxxxxxxxxxxxxxx" }),
  })
  .openapi("CreatedApiKey");

export const webhookViewSchema = webhookSchema.openapi("Webhook");

export const createWebhookSchema = z
  .object({
    name: z.string().default(""),
    url: z.string().min(1).openapi({ example: "https://example.test/hooks/mm" }),
    events: z
      .array(notifiableEventSchema)
      .default([])
      .openapi({ description: "Empty subscribes to every event." }),
  })
  .openapi("CreateWebhook");

export const createdWebhookSchema = webhookViewSchema
  .extend({ secret: z.string().openapi({ description: "The HMAC key. Shown once." }) })
  .openapi("CreatedWebhook");
