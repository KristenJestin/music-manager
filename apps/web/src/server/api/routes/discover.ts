/**
 * `/api/v1/discover` — the recommendation set, for an agent.
 *
 * Four routes, and they are the same four things the page can do: read the blocks, recompute
 * them, hide one for good, and turn one into a parked import. That last one is the interesting
 * endpoint: it answers `{ importId, release }`, which is exactly what `POST /imports/:id/confirm`
 * needs, so an agent can go from "what should I add?" to a queued album without ever leaving
 * the API — and still through the same wizard state a person would have confirmed.
 *
 * It reuses the **`library:*` scopes** rather than inventing `discover:*`. Discover reads the
 * library and proposes additions to it; a separate scope would be a fourth thing to grant for
 * no extra safety, and `API_RESOURCES` is a closed list whose arity is asserted in
 * `packages/contracts/src/api.test.ts`.
 *
 * Schemas are declared with `@hono/zod-openapi`'s `z`, never with the one from `@mm/contracts`
 * — see the long note at the top of `server/api/schemas.ts` for why that distinction is not
 * cosmetic.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import { errorSchema } from "#/server/api/schemas.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { pauseImport } from "#/server/services/jobs/index.ts";
import { rankFor } from "#/server/services/matching.queries.ts";
import { resolveDiscoverSource } from "#/server/services/discover.bridge.ts";
import {
  discoverList,
  getItem,
  markImported,
  notInterested,
  syncDiscover,
  type DiscoverItemView,
} from "#/server/services/discover.ts";
import { loadSettings } from "#/server/services/settings.ts";

const TAG = "discover";

const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad input" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
} as const;

const discoverItemSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["discography", "recommendation", "similar_artist"]),
    status: z.enum(["open", "later", "imported"]),
    subject: z.string(),
    title: z.string(),
    artist: z.string(),
    albumTitle: z.string().nullable(),
    artistMbid: z.string().nullable(),
    releaseGroupMbid: z.string().nullable(),
    recordingMbid: z.string().nullable(),
    year: z.number().nullable(),
    primaryType: z.string().nullable(),
    secondaryTypes: z.array(z.string()),
    score: z.number(),
    reason: z.string(),
    source: z.string(),
    inLibrary: z.boolean(),
    payload: z.record(z.string(), z.unknown()),
  })
  .openapi("DiscoverItem");

const discoverPayloadSchema = z
  .object({
    lastSync: z
      .object({
        id: z.string(),
        at: z.string(),
        status: z.string(),
        durationMs: z.number().nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
    signals: z.object({
      windowDays: z.number(),
      topArtists: z.array(
        z.object({ name: z.string(), plays: z.number(), mbid: z.string().nullable() }),
      ),
      topGenres: z.array(z.object({ name: z.string(), plays: z.number() })),
    }),
    discography: z.array(discoverItemSchema),
    recommendations: z.array(discoverItemSchema),
    similarArtists: z.array(discoverItemSchema),
  })
  .openapi("DiscoverPayload");

/** One item, with its `readonly` arrays copied so it matches the response schema. */
function plain(item: DiscoverItemView): z.infer<typeof discoverItemSchema> {
  return { ...item, secondaryTypes: [...item.secondaryTypes] };
}

export function discoverRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  app.openapi(
    createRoute({
      method: "get",
      path: "/",
      tags: [TAG],
      summary: "The three Discover blocks and the listening signals behind them",
      description:
        "Discography gaps, ListenBrainz recommendations and similar artists, each carrying its " +
        "score and a plain-English reason. Read-only: nothing here is recomputed by asking.",
      middleware: [requireScope("library:read")] as const,
      request: {
        query: z.object({
          kind: z.enum(["discography", "recommendation", "similar_artist"]).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        }),
      },
      responses: {
        200: {
          content: { "application/json": { schema: discoverPayloadSchema } },
          description: "The current set",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { kind, limit } = c.req.valid("query");
      const payload = await discoverList({
        db: db(),
        ...(kind === undefined ? {} : { kind }),
        ...(limit === undefined ? {} : { limit }),
      });
      // The service answers `readonly` arrays, as everything on the read path does; the
      // OpenAPI response type is mutable. Copying is the honest conversion — the alternative
      // is an assertion that says the two agree when the compiler has just said they do not.
      return c.json(
        {
          lastSync: payload.lastSync,
          signals: {
            windowDays: payload.signals.windowDays,
            topArtists: [...payload.signals.topArtists],
            topGenres: [...payload.signals.topGenres],
          },
          discography: payload.discography.map(plain),
          recommendations: payload.recommendations.map(plain),
          similarArtists: payload.similarArtists.map(plain),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/sync",
      tags: [TAG],
      summary: "Recompute the recommendations from Navidrome, ListenBrainz and Last.fm",
      description:
        "Runs in the caller's request rather than on the queue, so the answer is the report " +
        "itself. Dismissed subjects are never recomputed.",
      middleware: [requireScope("library:write")] as const,
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z
                .object({
                  id: z.string(),
                  status: z.enum(["done", "failed", "skipped"]),
                  durationMs: z.number(),
                  discography: z.number(),
                  recommendations: z.number(),
                  similarArtists: z.number(),
                  incompleteAlbums: z.number(),
                  error: z.string().nullable(),
                })
                .openapi("DiscoverSyncReport"),
            },
          },
          description: "What the sync produced",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const report = await syncDiscover({ db: db(), trigger: "api" });
      return c.json(
        {
          id: report.id,
          status: report.status,
          durationMs: report.durationMs,
          discography: report.discography,
          recommendations: report.recommendations,
          similarArtists: report.similarArtists,
          incompleteAlbums: report.incompleteAlbums,
          error: report.error,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/dismiss",
      tags: [TAG],
      summary: "Never suggest this again",
      description:
        "Remembered by subject, not by row: it survives a sync that would have proposed it again.",
      middleware: [requireScope("library:write")] as const,
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        200: {
          content: { "application/json": { schema: z.object({ dismissed: z.string() }) } },
          description: "Hidden",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await notInterested(id, db());
      return c.json({ dismissed: id }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/import",
      tags: [TAG],
      summary: "Find a YouTube source for this and open an import at the release-choice step",
      description:
        "Album → the YouTube Music playlist (`OLAK5uy_…`); track → a duration-ranked YouTube " +
        "search. The import is created and left **paused**, with the matching release " +
        "preselected: confirm it with `POST /imports/{id}/confirm`. Nothing downloads until you do.",
      middleware: [requireScope("imports:write")] as const,
      request: { params: z.object({ id: z.string().min(1) }) },
      responses: {
        201: {
          content: {
            "application/json": {
              schema: z
                .object({
                  importId: z.string(),
                  release: z.string().nullable(),
                  found: z.boolean(),
                  source: z.string(),
                })
                .openapi("DiscoverImport"),
            },
          },
          description: "The parked import",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const item = await getItem(id, db());
      if (item === null) {
        throw new MMError("NOT_FOUND", `No Discover item with id ${id}.`, { status: 404 });
      }
      if (item.kind === "similar_artist") {
        throw new MMError(
          "INVALID_INPUT",
          "An artist is not importable on its own; pick one of their release-groups.",
          { status: 400 },
        );
      }

      const isAlbum = item.kind === "discography" || item.payload["itemKind"] !== "track";
      const source = await resolveDiscoverSource(
        isAlbum
          ? { kind: "album", artist: item.artist, album: item.albumTitle ?? item.title }
          : { kind: "track", artist: item.artist, title: item.title },
      );
      if (source.url === "") {
        throw new MMError("NOT_FOUND", source.label, { status: 404 });
      }

      const created = await createFromUrl(source.url, { db: db() });
      await pauseImport(created.job.id, "Waiting for confirmation (from Discover).", db());
      await markImported(id, created.job.id, db());

      const job = await getImport(created.job.id, db());
      let release: string | null = null;
      if (job !== null) {
        const settings = await loadSettings(db());
        const ranked = await rankFor({ job, settings, db: db() });
        if (ranked.kind === "album") {
          const wanted =
            item.releaseGroupMbid === null
              ? undefined
              : ranked.ranking.candidates.find(
                  (candidate) => candidate.releaseGroupId === item.releaseGroupMbid,
                );
          release = wanted?.id ?? ranked.ranking.preselected?.id ?? null;
        }
      }

      return c.json(
        { importId: created.job.id, release, found: source.found, source: source.label },
        201,
      );
    },
  );

  return app;
}
