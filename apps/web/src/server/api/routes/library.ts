/**
 * `/api/v1/library` — what is on disk, scored, and the two things you can do to it.
 *
 * Reads go through `library.service` and `quality.service` rather than querying tables, for
 * the reason `mm library` gives: a score printed by the CLI, drawn by the Console and returned
 * here must not be computed three ways. Writes are `retag` and `verify`, both of which hand
 * the real work to the worker by default — a re-tag of a whole library inside an HTTP request
 * would die with the request.
 *
 * `search` is deliberately one endpoint over three kinds rather than three endpoints. An agent
 * asked "do I have Discovery?" does not know yet whether the answer is an album, a track or an
 * artist, and making it ask three times to find out is a worse API than one that answers.
 */
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { albumDetail, albumGrid, artistList, trackList } from "#/server/services/library.ts";
import { createRun, runToCompletion } from "#/server/services/retag.ts";
import { relocate } from "#/server/services/relocate.ts";
import { verifyAlbum, verifyLibrary } from "#/server/services/verify.ts";
import { enqueueRetagRun } from "#/server/services/queue.ts";
import { requireScope, type ApiEnv } from "#/server/api/auth.ts";
import {
  albumSchema,
  errorSchema,
  idParam,
  listAlbumsQuery,
  listTracksQuery,
  relocateSchema,
  retagSchema,
  searchQuery,
  verifySchema,
} from "#/server/api/schemas.ts";

const TAG = "library";

const FAILURES = {
  400: { content: { "application/json": { schema: errorSchema } }, description: "Bad input" },
  401: { content: { "application/json": { schema: errorSchema } }, description: "No credential" },
  403: { content: { "application/json": { schema: errorSchema } }, description: "Missing scope" },
  404: { content: { "application/json": { schema: errorSchema } }, description: "Not found" },
} as const;

export function libraryRoutes(): OpenAPIHono<ApiEnv> {
  const app = new OpenAPIHono<ApiEnv>();

  /* ---- albums ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/albums",
      tags: [TAG],
      summary: "The album grid, with quality scores and the library-wide numbers",
      middleware: [requireScope("library:read")] as const,
      request: { query: listAlbumsQuery },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                albums: z.array(albumSchema),
                total: z.number(),
                stats: z.record(z.string(), z.unknown()),
              }),
            },
          },
          description: "The albums",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { limit, offset, filter, profile, q } = c.req.valid("query");
      const payload = await albumGrid(
        {
          ...(q === undefined ? {} : { search: q }),
          ...(filter === undefined ? {} : { filter: filter as never }),
          ...(profile === undefined ? {} : { profile: profile as never }),
        },
        db(),
      );
      return c.json(
        {
          albums: payload.albums.slice(offset, offset + limit).map((album) => ({
            id: album.id,
            title: album.title,
            albumArtist: album.albumArtist,
            year: album.year,
            folder: album.folder,
            releaseMbid: album.releaseMbid,
            trackCount: album.trackCount,
            presentCount: album.presentCount,
            score: album.quality.score,
          })),
          total: payload.albums.length,
          stats: payload.stats as unknown as Record<string, unknown>,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/albums/{id}",
      tags: [TAG],
      summary: "One album: identifiers, tracks, what is missing, the tag map",
      middleware: [requireScope("library:read")] as const,
      request: { params: z.object({ id: idParam }) },
      responses: {
        200: {
          content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
          description: "The album",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const id = c.req.valid("param").id;
      const detail = await albumDetail(id, db());
      if (detail === null) {
        throw new MMError("NOT_FOUND", `No album with id ${id}.`, { status: 404 });
      }
      return c.json(detail as unknown as Record<string, unknown>, 200);
    },
  );

  /* ---- tracks ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/tracks",
      tags: [TAG],
      summary: "Every file, one row each",
      middleware: [requireScope("library:read")] as const,
      request: { query: listTracksQuery },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                tracks: z.array(z.record(z.string(), z.unknown())),
                total: z.number(),
              }),
            },
          },
          description: "The tracks",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { limit, offset, search, filter, albumId } = c.req.valid("query");
      const payload = await trackList(
        {
          ...(search === undefined ? {} : { search }),
          ...(filter === undefined ? {} : { filter: filter as never }),
          limit,
          offset,
        },
        db(),
      );
      const rows =
        albumId === undefined
          ? payload.tracks
          : payload.tracks.filter((track) => track.albumId === albumId);
      return c.json(
        { tracks: rows as unknown as Record<string, unknown>[], total: payload.total },
        200,
      );
    },
  );

  /* ---- artists ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/artists",
      tags: [TAG],
      summary: "The artists, grouped as the folders name them",
      middleware: [requireScope("library:read")] as const,
      request: { query: z.object({ q: z.string().optional() }) },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({ artists: z.array(z.record(z.string(), z.unknown())) }),
            },
          },
          description: "The artists",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { q } = c.req.valid("query");
      const artists = await artistList({ ...(q === undefined ? {} : { search: q }) }, db());
      return c.json({ artists: artists as unknown as Record<string, unknown>[] }, 200);
    },
  );

  /* ---- search ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/search",
      tags: [TAG],
      summary: "Search albums, tracks and artists at once",
      middleware: [requireScope("library:read")] as const,
      request: { query: searchQuery },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                albums: z.array(albumSchema),
                tracks: z.array(z.record(z.string(), z.unknown())),
                artists: z.array(z.record(z.string(), z.unknown())),
              }),
            },
          },
          description: "What matched",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { q, limit } = c.req.valid("query");
      const [grid, tracks, artists] = await Promise.all([
        albumGrid({ search: q }, db()),
        trackList({ search: q, limit }, db()),
        artistList({ search: q }, db()),
      ]);
      return c.json(
        {
          albums: grid.albums.slice(0, limit).map((album) => ({
            id: album.id,
            title: album.title,
            albumArtist: album.albumArtist,
            year: album.year,
            folder: album.folder,
            releaseMbid: album.releaseMbid,
            trackCount: album.trackCount,
            presentCount: album.presentCount,
            score: album.quality.score,
          })),
          tracks: tracks.tracks.slice(0, limit) as unknown as Record<string, unknown>[],
          artists: artists.slice(0, limit) as unknown as Record<string, unknown>[],
        },
        200,
      );
    },
  );

  /* ---- quality ---- */
  app.openapi(
    createRoute({
      method: "get",
      path: "/quality",
      tags: [TAG],
      summary: "The library-wide quality numbers",
      middleware: [requireScope("library:read")] as const,
      responses: {
        200: {
          content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
          description: "The numbers",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const payload = await albumGrid({}, db());
      return c.json(payload.stats as unknown as Record<string, unknown>, 200);
    },
  );

  /* ---- retag ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/retag",
      tags: [TAG],
      summary: "Re-project tags from the raw cache onto the files",
      description:
        "Offline: it re-reads the stored documents and rewrites tag blocks, downloading " +
        "nothing. `queue: false` runs it in this request, which is only sensible for one album.",
      middleware: [requireScope("library:write")] as const,
      request: {
        body: { content: { "application/json": { schema: retagSchema } }, required: true },
      },
      responses: {
        200: {
          content: {
            "application/json": {
              schema: z.object({
                runId: z.string(),
                total: z.number(),
                queued: z.boolean(),
                status: z.string().nullable(),
                changed: z.number().nullable(),
                failed: z.number().nullable(),
              }),
            },
          },
          description: "Started",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const scope =
        body.trackId !== undefined ? "track" : body.albumId !== undefined ? "album" : "library";
      const run = await createRun({
        db: db(),
        scope,
        targetId: body.trackId ?? body.albumId ?? null,
        dryRun: body.dryRun,
        onlyBehind: body.onlyBehind,
        trigger: "manual",
      });
      if (run.total === 0) {
        return c.json(
          { runId: run.id, total: 0, queued: false, status: "done", changed: 0, failed: 0 },
          200,
        );
      }
      if (body.queue) {
        await enqueueRetagRun(run.id);
        return c.json(
          {
            runId: run.id,
            total: run.total,
            queued: true,
            status: null,
            changed: null,
            failed: null,
          },
          200,
        );
      }
      const finished = await runToCompletion(run.id, { db: db() });
      return c.json(
        {
          runId: finished.id,
          total: finished.total,
          queued: false,
          status: finished.status,
          changed: finished.changed,
          failed: finished.failed,
        },
        200,
      );
    },
  );

  /* ---- verify ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/verify",
      tags: [TAG],
      summary: "Read the files back through Navidrome and compare, field by field",
      middleware: [requireScope("library:write")] as const,
      request: {
        body: { content: { "application/json": { schema: verifySchema } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
          description: "The report",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { albumId, rescan } = c.req.valid("json");
      const report =
        albumId === undefined
          ? await verifyLibrary({ db: db(), rescan })
          : await verifyAlbum(albumId, { db: db(), rescan });
      return c.json(report as unknown as Record<string, unknown>, 200);
    },
  );

  /* ---- relocate: the other half of a `pathTemplate` change (decision 074) ---- */
  app.openapi(
    createRoute({
      method: "post",
      path: "/relocate",
      tags: [TAG],
      summary: "Re-file the library against the current path template",
      description:
        "`retag` re-projects the tags and never touches a path, so a library keeps its old " +
        "names for ever after `pathTemplate` changes. This moves the files that no longer " +
        "match it, through the toolbox (a rename inside one mount, so atomic), updates the " +
        "rows, and asks Navidrome to rescan.\n\n" +
        "`dryRun: true` is the default and changes nothing. **Navidrome identifies a file by " +
        "its path, so a real move loses that track's play count and its favourites.** A " +
        "destination that already exists is skipped, never overwritten.",
      middleware: [requireScope("library:write")] as const,
      request: {
        body: { content: { "application/json": { schema: relocateSchema } }, required: true },
      },
      responses: {
        200: {
          content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
          description: "The report",
        },
        ...FAILURES,
      },
    }),
    async (c) => {
      const { albumId, dryRun } = c.req.valid("json");
      const report = await relocate({
        db: db(),
        dryRun,
        ...(albumId === undefined ? {} : { albumId }),
      });
      return c.json(report as unknown as Record<string, unknown>, 200);
    },
  );

  return app;
}
