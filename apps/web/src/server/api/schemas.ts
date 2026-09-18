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
// The import-status vocabulary, from the import-free module the `pgEnum` is built from — so
// the query filter and the column can never name different sets.
import { IMPORT_STATUSES, INBOX_TYPES, RETAG_SELECTIONS } from "#/server/db/schema/enums.vocab.ts";
// The batch cap and the coverage bar belong to the service that enforces them; restating them
// here would be a second copy to keep in step with the OpenAPI text that quotes them.
import { DEFAULT_MIN_COVERAGE, MAX_BATCH_URLS } from "#/server/services/imports.bulk.ts";
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

export const errorSchema = z.object({ error: mmErrorBodySchema }).openapi("Error", {
  description:
    "Every failure, everywhere, in one shape. `code` is stable and machine-readable; " +
    "`hint` and `action` are for a human or an agent deciding what to do next.",
});

/** The id in a path. Named so the document says `imp_…` rather than `string`. */
export const idParam = z.string().min(1).openapi({ example: "imp_01K4XQ7N8ZC3RB2VMD9T6HFPGA" });

/**
 * The two query parameters every list route in this API takes.
 *
 * They existed before and said so nowhere: neither the OpenAPI document nor the MCP tool
 * descriptions mentioned them, so the owner's bulk-import session was spent reading the fifty
 * most recent imports over and over, believing that was all there were. A parameter a client
 * cannot discover is a parameter that does not exist, which is why the `.describe()` text here
 * is part of the fix rather than decoration.
 *
 * Every list route that takes these also answers `total` and `hasMore` — see `pageFields`.
 */
export const paginationQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .openapi({ example: 50, description: "Page size. 1–200, default 50." }),
  offset: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .openapi({
      example: 0,
      description:
        "How many rows to skip. Page 2 of a 50-row page is `offset=50`. " +
        "Read `total` and `hasMore` on the answer to know when to stop.",
    }),
});

/**
 * The two fields that make a paged answer usable.
 *
 * `total` is the number of rows the filter matches, *before* `limit` and `offset`; `hasMore`
 * says whether another page exists, so a client never has to work it out from three numbers and
 * an off-by-one. Both are spelled once here so every list route answers the same shape.
 */
export const pageFields = {
  total: z
    .number()
    .int()
    .openapi({ description: "Rows matching the filter, ignoring `limit` and `offset`." }),
  hasMore: z
    .boolean()
    .openapi({ description: "True when `offset + limit < total` — ask for the next page." }),
} as const;

// The arithmetic itself is in `api/paging.ts` so that a caller who wants `{total, hasMore}`
// and nothing else — the Console's job list — does not have to import an OpenAPI generator
// to get it. Re-exported here because this is where every route already looks for it.
export { pageInfo } from "#/server/api/paging.ts";

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
    untaggedFallback: z
      .boolean()
      .optional()
      .openapi({
        description:
          "When MusicBrainz has nothing, import from the source's own tags instead of parking " +
          "the job in the review queue. Omitted means *decide by the source*: on for a folder, " +
          "off for a URL — a folder's files carry real tags, a video title does not.",
      }),
  })
  .openapi("ImportOptions");

export const createImportSchema = z
  .object({
    url: z
      .string()
      .min(1)
      .openapi({
        example: "fixture://discovery",
        description:
          "The source. A YouTube URL, `fixture://…`, **or the absolute path of a folder of " +
          "audio files** on the server (`/srv/musique/album`, `D:\\Musique\\album`, or the " +
          "same thing as `file:///srv/musique/album`).\n\n" +
          "A folder is listed the way a playlist is: each file becomes an entry with its " +
          "title, its exact duration and its existing tags, matched like a video and then " +
          "**adopted** — no byte is downloaded. The folder must be inside the library or " +
          "inside a directory the operator listed in `adoptSourceRoots`, which is empty by " +
          "default; anything else is `ADOPT_PATH_REFUSED` (403). The listing is not " +
          "recursive: one folder is one release.",
      }),
    releaseMbid: z
      .string()
      .nullish()
      .openapi({ description: "Pin the MusicBrainz release instead of letting the matcher pick." }),
    options: importOptionsSchema.optional(),
    priority: z.enum(["low", "normal", "next"]).default("normal"),
  })
  .openapi("CreateImport");

/**
 * `POST /imports/batch` — the same options, applied to a list of URLs.
 *
 * `urls` is capped at `MAX_BATCH_URLS`, and the cap is in the route's description because a
 * limit a caller discovers by hitting it is a limit that costs a failed request to learn.
 */
export const batchImportSchema = z
  .object({
    urls: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BATCH_URLS)
      .openapi({
        example: ["https://www.youtube.com/playlist?list=OLAK5uy_a", "fixture://discovery"],
        description: `The URLs, in order. At most ${String(MAX_BATCH_URLS)} per call.`,
      }),
    options: importOptionsSchema.optional(),
    priority: z.enum(["low", "normal", "next"]).default("normal"),
  })
  .openapi("BatchImport");

/** One URL's outcome inside a batch, in the position it was sent. */
export const batchLineSchema = z
  .object({
    index: z.number().int().openapi({ description: "Position of this URL in the request." }),
    url: z.string(),
    ok: z.boolean(),
    id: z.string().nullable(),
    status: z.string().nullable(),
    step: z.string().nullable(),
    duplicates: z.array(z.string()),
    error: mmErrorBodySchema.nullable(),
  })
  .openapi("BatchImportLine");

export const batchResultSchema = z
  .object({
    requested: z.number().int(),
    created: z.number().int(),
    failed: z.number().int(),
    ids: z
      .array(z.string())
      .openapi({ description: "The created ids, in request order. Feed them to `confirm-best`." }),
    results: z.array(batchLineSchema),
  })
  .openapi("BatchImportResult");

/**
 * `POST /imports/{id}/confirm-best`.
 *
 * Four fields, because the server already has everything else. The mapping is built from the
 * chosen candidate's own `fitLines` (an album) or its own borrow release (a single), which is in
 * both cases the assignment the matching engine computed to score it — so there is nothing here
 * for a caller to get wrong.
 *
 * `minCoverage` and `minMargin` are the two bars, and exactly one of them applies to any given
 * import: which one is decided by what the source turned out to be, and the answer says so in
 * `kind`. Sending both is normal — a caller looping over a batch does not know which of its ids
 * resolved to a single.
 */
export const confirmBestSchema = z
  .object({
    minCoverage: z
      .number()
      .min(0)
      .max(1)
      .default(DEFAULT_MIN_COVERAGE)
      .openapi({
        example: DEFAULT_MIN_COVERAGE,
        description:
          "**Albums only.** Mapped videos ÷ videos in the import. Below it the call is a 409 " +
          "and the import is left waiting, untouched. A bar you may *raise*: an album is " +
          "confirmed here only on an exact match — every video bound, every track of the " +
          "release covered, the source's artist carried — and `minCoverage` cannot waive that. " +
          "A deliberately inexact album goes through `confirm-mapping`.",
      }),
    minMargin: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .openapi({
        example: 0.04,
        description:
          "**Singles only.** How far ahead of the runner-up the chosen recording has to score. " +
          "Defaults to this installation's `matchAmbiguityMargin` — the same gap under which " +
          "the `match` step already refuses to decide and opens an `ambiguous_recording` " +
          "notice. Duration, title and artist agreement are checked too, against the engine's " +
          "own tolerances, and are not tunable from here.",
      }),
    preferType: z
      .enum(["album", "any"])
      .default("album")
      .openapi({
        description:
          "`album` breaks a tie in favour of a release whose release-group `primary-type` is " +
          "Album, over an EP or a Single that maps the same number of videos. It changes " +
          "nothing else: the ranking is the matcher's own.",
      }),
    confirmedBy: z
      .string()
      .min(1)
      .openapi({
        example: "claude-desktop",
        description:
          "Who is confirming. Written to `decisions.decidedBy`, so an automatic confirmation is " +
          "never mistaken for a human one.",
      }),
  })
  .openapi("ConfirmBest");

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

/**
 * What `confirm-best` chose, flat next to the import it chose it for.
 *
 * Flat, like `POST /imports` is since this change: an envelope on one route and none on the
 * next is the inconsistency that made a client write `payload.import.id` in one place and
 * `payload.id` in another.
 *
 * **`kind` is the discriminator, and the fields of the other branch are `null`.** That is the
 * shape `GET /imports/{id}/candidates` already uses (`releases: []` against `recordings: []`),
 * and it is chosen over two response schemas for the same reason the endpoint is one endpoint:
 * a caller looping over a batch reads `kind` once rather than branching on the URL it called.
 */
export const confirmBestResultSchema = importSchema
  .extend({
    kind: z
      .enum(["album", "single"])
      .openapi({ description: "Which bar decided it: coverage (album) or the margin (single)." }),
    chosenTitle: z.string(),
    chosenArtist: z.string(),
    /** `Album`, `EP`, `Single`… — the release's type, or the borrow release's on a single. */
    chosenType: z.string().nullable(),
    chosenScore: z.number(),
    /** The recording MBID. `null` on an album, where `releaseMbid` is the identifier. */
    recordingMbid: z.string().nullable(),
    coverage: z
      .number()
      .nullable()
      .openapi({ description: "Album only: mapped videos ÷ videos in the import." }),
    minCoverage: z.number().nullable(),
    preferType: z.enum(["album", "any"]).nullable(),
    videos: z.number().int().nullable(),
    margin: z
      .number()
      .nullable()
      .openapi({ description: "Single only: the chosen recording's lead over the runner-up." }),
    minMargin: z.number().nullable(),
    durationDelta: z
      .number()
      .nullable()
      .openapi({ description: "Single only: video − recording, in seconds." }),
    candidatesConsidered: z.number().int(),
    mapped: z.number().int().nullable(),
    extras: z.number().int().nullable(),
    uncovered: z.number().int(),
    queued: z.boolean(),
    confirmedBy: z.string(),
  })
  .openapi("ConfirmBestResult");

/**
 * What `POST /imports/{id}/bump` did to the queue, next to the import it did it to.
 *
 * Reported rather than implied, because the four actions are four different situations and only
 * one of them means "it will now be picked up sooner". See `reprioritiseImport`.
 */
export const bumpResultSchema = z
  .object({
    action: z.enum(["reprioritised", "sent", "running", "none"]),
    queue: z.string().nullable(),
    priority: z.number().int(),
    updated: z.number().int(),
    removed: z.number().int(),
    messages: z.number().int().openapi({
      description: "Unfinished import-level messages this import holds. Never above 1.",
    }),
    trackMessages: z
      .number()
      .int()
      .openapi({
        description:
          "Unfinished `track.step` messages. Counted, never touched: one per track per step is " +
          "what the pipelined tail is made of.",
      }),
  })
  .openapi("BumpResult");

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
  // A free `z.string()` reached the `where` clause and Postgres answered with the failed
  // statement, leaking the column list of `imports` into an error body. The closed vocabulary
  // is the column's own, so an unknown value is a 400 naming the eight that exist.
  status: z
    .enum(["all", ...IMPORT_STATUSES])
    .optional()
    .openapi({ description: "Filter on one import status.", example: "awaiting_review" }),
  q: z.string().optional().openapi({ description: "Substring of the title or the URL." }),
});

export const retryStepSchema = z
  .object({ step: z.string().min(1).openapi({ example: "download" }) })
  .openapi("RetryStep");

/**
 * `POST /imports/{id}/tracks/{trackId}/file` — adopt a local file as this track's source.
 *
 * **One content type, two ways for the bytes to arrive**, discriminated on `source`. JSON and
 * not `multipart/form-data` for a reason worth writing down: every boundary in this
 * application is a zod schema (`CLAUDE.md` § Code style), there is no multipart parser
 * anywhere in it, and adding one for a single route would make this the only body in the app
 * that is validated by hand. Base64 costs a third more bytes on a file that is at most 64 MB
 * and at most one per call — and the caller who minds that is the caller who should be using
 * `source: "path"`, which sends no bytes at all.
 */
export const adoptFileSchema = z
  .discriminatedUnion("source", [
    z
      .object({
        source: z.literal("path"),
        path: z
          .string()
          .min(1)
          .openapi({
            example: "D:\\Musique\\Daft Punk\\Discovery\\03 Digital Love.flac",
            description:
              "An absolute path **on the server**. It is resolved (symlinks included) and " +
              "refused unless it lands inside the library or inside one of the directories " +
              "listed in the `adoptSourceRoots` setting, which is empty by default.",
          }),
      })
      .openapi("AdoptFileByPath"),
    z
      .object({
        source: z.literal("upload"),
        filename: z
          .string()
          .min(1)
          .openapi({
            example: "03 Digital Love.flac",
            description:
              "The file's own name. Only its extension and its basename are used — the " +
              "destination name is chosen by the server — and the basename is what ends up in " +
              "the file's `ORIGINALFILENAME` tag.",
          }),
        content: z
          .string()
          .min(1)
          // Standard base64, padding optional, whitespace not allowed: an unchecked string
          // reaching `Buffer.from(…, "base64")` is silently truncated at the first bad
          // character, which would store a corrupt file and report success.
          .regex(/^[A-Za-z0-9+/]+={0,2}$/, "`content` must be standard base64, with no whitespace.")
          .openapi({ description: "The file's bytes, base64. 64 MB before encoding." }),
      })
      .openapi("AdoptFileUpload"),
  ])
  .openapi("AdoptFile");

export const adoptFileResultSchema = z
  .object({
    importId: z.string(),
    trackId: z.string(),
    /** Library-relative, forward slashes: `.mm-work/imp_…/itr_….flac`. */
    path: z.string(),
    bytes: z.number().int(),
    container: z.string(),
    codec: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    via: z.enum(["path", "upload"]),
    originalName: z.string(),
    /** The step the track runs next — `fingerprint` unless the options turned it off. */
    nextStep: z.string().nullable(),
    /** True when the track was put back on the queue. */
    queued: z.boolean(),
    /**
     * True when the import had already given up and was re-opened by this call.
     *
     * An import whose download step failed is `failed`, and a per-track message would be
     * skipped by a runner that refuses terminal jobs. Such an import is rewound to `download`
     * and re-queued instead — which does **not** re-download this track (the file is there and
     * `download` reuses it) but does try the album's other failures again.
     */
    reopened: z.boolean(),
  })
  .openapi("AdoptFileResult");

/**
 * `POST /imports/retry-failed-upstream` — the whole outage in one call.
 *
 * A body with two optional knobs and no required field, so the common case is an empty POST.
 * `dryRun` exists because "which ones?" is a fair question to ask before answering it, and
 * `limit` because the first requeue after a long outage may be worth doing in batches.
 */
export const bulkRetrySchema = z
  .object({
    dryRun: z.boolean().default(false).openapi({ description: "List them and change nothing." }),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .openapi({ description: "Requeue at most this many, oldest first." }),
  })
  .default({ dryRun: false })
  .openapi("BulkRetry");

export const bulkRetryResultSchema = z
  .object({
    requeued: z.number().int(),
    dryRun: z.boolean(),
    imports: z.array(
      z.object({
        id: z.string(),
        url: z.string(),
        title: z.string().nullable(),
        /** Where the retry restarts — where the job actually stopped, not `resolve`. */
        step: z.string(),
        /** Which source refused, when the stored error named one. */
        source: z.string().nullable(),
        code: z.string(),
        upstreamAttempts: z.number().int(),
      }),
    ),
  })
  .openapi("BulkRetryResult");

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

/**
 * "Import it from the source's own tags" — the answer to a card MusicBrainz cannot fill.
 *
 * Shared by the single and the batch form of `resolve`, because an agent that has forty of
 * these answers them in one call and a person answering one answers it in the Console. Only
 * offered on an `ambiguous_release` the search found no candidate for; anywhere else it is a
 * 400 for that item, not a flag quietly set on its import.
 */
const untaggedAnswerField = z
  .boolean()
  .optional()
  .openapi({
    description:
      "Answer with **import from the source's own tags** instead of the preselection: the " +
      "album is built from the YouTube listing's own title, artist, year and track order, no " +
      "MusicBrainz identifier is written, and the library flags it `untagged`. Only valid on " +
      "an `ambiguous_release` item whose search returned no candidate. Sets " +
      "`options.untaggedFallback` on that import and re-runs `match`.",
  });

export const resolveInboxSchema = z
  .object({
    /** `true` takes the preselection; `false` dismisses the question. */
    accept: z.boolean(),
    /** Overrides the preselected answer when accepting. */
    resolution: z.record(z.string(), z.unknown()).optional(),
    untaggedFallback: untaggedAnswerField,
  })
  .openapi("ResolveInbox");

/**
 * The batch form: several items, one answer, and one restart per import.
 *
 * `itemIds` and `importId` are two ways of naming the same set and exactly one must be given —
 * the service refuses both and neither, rather than picking one and being quietly surprising.
 */
export const resolveBatchSchema = z
  .object({
    itemIds: z.array(z.string().min(1)).min(1).max(200).optional(),
    importId: z.string().min(1).optional(),
    /** With `importId` only: e.g. `fingerprint_mismatch`. */
    type: z.enum(INBOX_TYPES).optional(),
    accept: z.boolean().default(true),
    untaggedFallback: untaggedAnswerField,
  })
  .openapi("ResolveInboxBatch");

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
    /**
     * False when `trackCount` is the number of files held rather than the release's total.
     * A client that draws a progress bar must not draw a full one on the strength of it.
     */
    totalKnown: z.boolean(),
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
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .openapi({ description: "Caps each of the three lists. 1–100, default 20." }),
});

export const retagSchema = z
  .object({
    albumId: z.string().optional(),
    trackId: z.string().optional(),
    dryRun: z.boolean().default(false),
    /**
     * Which files inside the scope.
     *
     *  - `behind` — those written by an older tag **schema version**. The default, and a
     *    question about `MUSICMANAGER_TAGSCHEMA` rather than about values.
     *  - `adrift` — those whose tags disagree with the database: a release confirmed since the
     *    files were filed, a field corrected by hand. This is the one that repairs a divergence.
     *  - `all` — everything in scope.
     */
    selection: z.enum(RETAG_SELECTIONS).optional(),
    /** The older two-way spelling. `false` is `all`, `true` is `behind`. `selection` wins. */
    onlyBehind: z.boolean().default(true),
    /** Hand it to the worker instead of running it in this request. */
    queue: z.boolean().default(true),
  })
  .openapi("Retag");

export const verifySchema = z
  .object({
    albumId: z.string().optional().openapi({ description: "Omit to verify the whole library." }),
    rescan: z.boolean().optional().openapi({
      description:
        "Ask Navidrome to scan before reading back. Defaults to the `navidromeRescanOnVerify` setting.",
    }),
  })
  .openapi("Verify");

/**
 * `POST /library/relocate`.
 *
 * `dryRun` defaults to **true**, unlike `retag`'s: a re-tag rewrites a tag block and can be
 * run again, a relocate moves files and takes Navidrome's play counts with them. The safe
 * default is the one you would have chosen if you had read the warning.
 */
/**
 * One manual override of one field — `docs/03-metadonnees.md` §1's lock, written.
 *
 * `value` and `locked` are not two spellings of the same thing. A value sets *and* locks; no
 * value with `locked: true` pins what the resolvers already say; no value with `locked: false`
 * removes the field and re-resolves it offline, which is what "unlock" has to mean for a value
 * no resolver produced.
 */
export const fieldEditSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .openapi({ description: "A tag map field name — `album`, not `ALBUM`.", example: "album" }),
    value: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional()
      .openapi({ description: "The new value. An array (or newlines) for a multi-valued field." }),
    locked: z.boolean().optional().openapi({
      description: "Defaults to true when a value is given. `false` with no value releases it.",
    }),
  })
  .openapi("FieldEdit");

export const fieldsPatchSchema = z
  .object({ edits: z.array(fieldEditSchema).min(1) })
  .openapi("FieldsPatch");

export const relocateSchema = z
  .object({
    albumId: z.string().optional().openapi({ description: "Omit for the whole library." }),
    dryRun: z.boolean().default(true),
  })
  .openapi("Relocate");

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
export const patchSettingsSchema = z.record(z.string(), z.unknown()).openapi("SettingsPatch", {
  description: "A partial settings object. Unknown keys are refused.",
});

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
  since: z.coerce
    .number()
    .int()
    .min(0)
    .optional()
    .openapi({
      description:
        "Only events with a higher `id`. This is the journal's pagination: set it to the highest " +
        "`id` of the previous page.",
    }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(100)
    .openapi({ description: "1–500, default 100. A full page means there is more." }),
});

/* ------------------------------------------------------------------ */
/* keys and webhooks                                                   */
/* ------------------------------------------------------------------ */

export const keySchema = apiKeySchema.openapi("ApiKey");

export const createKeySchema = z
  .object({
    name: z.string().min(1).openapi({ example: "claude-desktop" }),
    scopes: z
      .array(z.string())
      .min(1)
      .openapi({ example: ["imports:write", "library:read"] }),
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

/**
 * The PATCH body: every field optional, and **no defaults**.
 *
 * Written out rather than derived with `createWebhookSchema.partial()`, because `.partial()`
 * only makes a field optional — it leaves the `.default()` in place, so a body that mentioned
 * only `events` parsed into one that also carried `name: ""`, and the handler renamed the
 * endpoint to nothing. A PATCH must not change what it was not asked to change.
 */
export const patchWebhookSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().min(1).optional(),
    events: z.array(notifiableEventSchema).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi("PatchWebhook");
