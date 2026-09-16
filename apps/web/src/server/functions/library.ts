/**
 * The library pages, as server functions.
 *
 * Every one carries `sessionMiddleware` — `functions.guard.test.ts` walks this file and would
 * fail if one did not. Nothing but types is exported besides the functions themselves: a
 * non-handler runtime export survives the Vite plugin's client/server split and drags Drizzle
 * into the browser bundle (see `base.ts`).
 *
 * The destructive ones are POSTs that say what they did — how many files, how many rows —
 * because a Console that answers "ok" to "delete this album" has told you nothing you can
 * check.
 */
import { z } from "zod";
import { PROFILE_IDS } from "@mm/domain";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  ALBUM_FILTER_FIELDS,
  ARTIST_FILTER_FIELDS,
  TRACK_FILTER_FIELDS,
  decodeFilter,
} from "#/lib/filters/index.ts";
import {
  ALBUM_FILTERS,
  ALBUM_SORTS,
  TRACK_FILTERS,
  albumDetail,
  albumGrid,
  albumHistory,
  artistList,
  compareWithFiles,
  coverOptions,
  deleteAlbum,
  deleteTrack,
  documentOfLibraryTrack,
  fetchMissing,
  importBehindAlbum,
  planRedownload,
  setCover,
  trackDetail,
  trackList,
  type AlbumDetail,
  type AlbumGridPayload,
  type ArtistRow,
  type CoverOption,
  type DeleteResult,
  type FetchMissingResult,
  type FileComparison,
  type RedownloadPlan,
  type TrackDetail,
  type TrackListPayload,
} from "#/server/services/library.ts";
import { enqueue } from "#/server/services/queue.ts";

const profile = z.enum(["global", ...PROFILE_IDS]);

/**
 * The filter builder's tree, as it travels: the `?f=` string, unparsed.
 *
 * A length, because it is a URL and a URL is untrusted; the grammar and the whitelist are
 * `decodeFilter`'s job, and it answers with a tree *and* a sentence rather than throwing. A
 * filter that does not parse must leave the page showing everything with a notice above it,
 * never a 500 — a link is the one input a reader cannot proof-read before using.
 */
const filterExpression = z.string().max(2_000).default("");

/** What every filtered list adds to its payload: why the filter in the URL was not applied. */
export interface FilteredPayload {
  readonly filterError: string | null;
}

/* ------------------------------------------------------------------ */
/* reading                                                             */
/* ------------------------------------------------------------------ */

export const fetchAlbums = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      search: z.string().default(""),
      filter: z.enum(ALBUM_FILTERS).default("all"),
      sort: z.enum(ALBUM_SORTS).default("recent"),
      profile: profile.default("global"),
      f: filterExpression,
    }),
  )
  .handler(async ({ data }): Promise<AlbumGridPayload & FilteredPayload> => {
    try {
      const { tree, error } = decodeFilter(data.f, ALBUM_FILTER_FIELDS);
      return { ...(await albumGrid({ ...data, filters: tree }, db())), filterError: error };
    } catch (error) {
      return toFailure(error);
    }
  });

export interface AlbumPagePayload extends AlbumDetail {
  /** The import the "change release" action would re-run step 2 of, if there is one. */
  readonly wizardImportId: string | null;
}

export const fetchAlbum = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<AlbumPagePayload | null> => {
    try {
      const detail = await albumDetail(data.id, db());
      if (detail === null) return null;
      return { ...detail, wizardImportId: await importBehindAlbum(data.id, db()) };
    } catch (error) {
      return toFailure(error);
    }
  });

/** One track's whole document — 50 KB of JSON, so it is asked for a track at a time. */
export const fetchTrackDocument = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<Record<string, unknown> | null> => {
    try {
      const document = await documentOfLibraryTrack(data.id, db());
      return document === null ? null : (document as unknown as Record<string, unknown>);
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * The "DB vs files" tab: open every file and say where it disagrees with the database.
 *
 * One toolbox round trip per file, so this is never called by a list page — only by the tab
 * you deliberately opened.
 */
export const fetchFileComparison = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<readonly FileComparison[]> => {
    try {
      return await compareWithFiles(data.id, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export interface HistoryLine {
  readonly id: number;
  readonly importId: string | null;
  readonly type: string;
  readonly level: string;
  readonly message: string;
  readonly at: string;
}

export const fetchAlbumHistory = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<readonly HistoryLine[]> => {
    try {
      const rows = await albumHistory(data.id, {}, db());
      return rows.map((row) => ({
        id: row.id,
        importId: row.importId,
        type: row.type,
        level: row.level,
        message: row.message,
        at: row.at.toISOString(),
      }));
    } catch (error) {
      return toFailure(error);
    }
  });

export const fetchTracks = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      search: z.string().default(""),
      filter: z.enum(TRACK_FILTERS).default("all"),
      page: z.number().int().min(0).default(0),
      f: filterExpression,
    }),
  )
  .handler(async ({ data }): Promise<TrackListPayload & FilteredPayload> => {
    try {
      const { tree, error } = decodeFilter(data.f, TRACK_FILTER_FIELDS);
      const payload = await trackList(
        {
          search: data.search,
          filter: data.filter,
          filters: tree,
          offset: data.page * 60,
          limit: 60,
        },
        db(),
      );
      return { ...payload, filterError: error };
    } catch (error) {
      return toFailure(error);
    }
  });

export const fetchTrack = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<TrackDetail | null> => {
    try {
      return await trackDetail(data.id, db());
    } catch (error) {
      return toFailure(error);
    }
  });

export interface ArtistListPayload extends FilteredPayload {
  readonly artists: readonly ArtistRow[];
  /** From a `count(*)` over the same `where`; the page draws them all, so it equals the length. */
  readonly total: number;
}

export const fetchArtists = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ search: z.string().default(""), f: filterExpression }))
  .handler(async ({ data }): Promise<ArtistListPayload> => {
    try {
      const { tree, error } = decodeFilter(data.f, ARTIST_FILTER_FIELDS);
      const artists = await artistList({ search: data.search, filters: tree }, db());
      return { artists, total: artists.length, filterError: error };
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* the cover picker                                                    */
/* ------------------------------------------------------------------ */

export const fetchCoverOptions = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<readonly CoverOption[]> => {
    try {
      return await coverOptions(data.id, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

export const chooseCover = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), url: z.string().url() }))
  .handler(async ({ data }): Promise<{ path: string; bytes: number; tracks: number }> => {
    try {
      return await setCover(data.id, data.url, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Ask the sources again for what this album is missing.
 *
 * Online, deliberately and visibly: it is the one action in the library pages that leaves the
 * machine, and it reports how many requests it made so that is never a surprise.
 */
export const fetchMissingTags = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ albumId: z.string().min(1) }))
  .handler(async ({ data }): Promise<FetchMissingResult> => {
    try {
      return await fetchMissing(data.albumId, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* destructive                                                         */
/* ------------------------------------------------------------------ */

export const removeAlbum = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<DeleteResult> => {
    try {
      return await deleteAlbum(data.id, db());
    } catch (error) {
      return toFailure(error);
    }
  });

export const removeTrack = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1) }))
  .handler(async ({ data }): Promise<DeleteResult> => {
    try {
      return await deleteTrack(data.id, db());
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Re-download, keeping the mapping.
 *
 * The rewind happens here; the download itself is queued, because a download inside an HTTP
 * request dies with the request — the same reason the wizard queues rather than runs.
 */
export const redownload = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z
      .object({ albumId: z.string().optional(), trackId: z.string().optional() })
      .refine(
        (value) => value.albumId !== undefined || value.trackId !== undefined,
        "Give an album id or a track id.",
      ),
  )
  .handler(async ({ data }): Promise<readonly RedownloadPlan[]> => {
    try {
      const plans = await planRedownload(
        {
          ...(data.albumId === undefined ? {} : { albumId: data.albumId }),
          ...(data.trackId === undefined ? {} : { trackId: data.trackId }),
        },
        db(),
      );
      for (const plan of plans) await enqueue(plan.importId, "console re-download", "download");
      return plans;
    } catch (error) {
      return toFailure(error);
    }
  });
