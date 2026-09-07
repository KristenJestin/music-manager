/**
 * The album-scope pass, wired to the database (`docs/03-metadonnees.md` §2, §6).
 *
 * `packages/domain`'s `resolveAlbumScope` is pure and knows nothing about rows: give it the
 * album's documents in track order and it says which of the 36 `albumScope` fields must be
 * rewritten and to what. This module is the two things it cannot do for itself:
 *
 *  1. **collect the album's documents** — the ones the `tag` step has just built during the
 *     pipeline, an offline rebuild of the whole album during a re-tag;
 *  2. **read the album's own answer** for a field the tracks can only guess at. Today that is
 *     `genre`: MusicBrainz puts genres on the *release group*, which is the album, and the
 *     per-track resolver deliberately prefers the *recording*'s. The release is already in the
 *     raw cache, so this lookup is offline and free — §8's "a re-tag makes no request" holds.
 *
 * Why not fix it in the resolvers alone: `copyright` comes from the ℗ line of each video's
 * description and there is no album-level video, so *some* aggregation is unavoidable. Doing
 * both in one place means one rule per field, written down once (`albumscope/rules.ts`), and
 * one answer for the pipeline, the re-tag, the tools and the Console.
 */
import { MMError } from "@mm/contracts";
import {
  applyAlbumScopeTo,
  changedChoices,
  field as makeField,
  resolveAlbumScope,
  topGenres,
  type AlbumScopeChoice,
  type AlbumScopeResolution,
  type Field,
  type TrackDocument,
} from "@mm/domain";
import { eq } from "drizzle-orm";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { libraryAlbums, libraryTracks } from "#/server/db/schema/index.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import { rebuild as rebuildDocument } from "#/server/services/documents.ts";
import type { Settings } from "#/server/services/settings.ts";

export type { AlbumScopeChoice, AlbumScopeResolution };

export interface ResolveOptions {
  readonly db?: Database;
  readonly settings: Settings;
  /** The album's MusicBrainz release, when it has one — the source of the genre hint. */
  readonly releaseMbid?: string | null;
  readonly signal?: AbortSignal;
}

/**
 * What an **album-scope source** says, per field.
 *
 * Offline on purpose: the release lookup is a raw-cache read, and a miss leaves the hint out
 * rather than reaching for the network. A re-tag that phoned MusicBrainz would be a defect —
 * `retagOne` counts the requests and fails the file if any were made.
 */
export async function albumValues(options: ResolveOptions): Promise<Record<string, Field>> {
  const mbid = options.releaseMbid;
  if (mbid === null || mbid === undefined || mbid === "") return {};
  const db = options.db ?? defaultDb();

  try {
    const answer = await musicbrainz.lookupRelease(
      {
        db,
        config: sourcesConfig(options.settings),
        offline: true,
        refresh: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      mbid,
    );
    const release = answer.data;
    if (release === null) return {};

    const out: Record<string, Field> = {};
    /*
     * The release group is the album; the release is one edition of it. Its genres are the
     * album's genres, and they are the answer the per-track chain never gets to give because
     * `fromMusicBrainzRecording` refines `genre` after `fromMusicBrainzRelease` has set it.
     */
    const genres = topGenres(
      release["release-group"]?.genres ?? release.genres,
      Math.max(1, options.settings.maxGenres),
    );
    if (genres.length > 0) {
      out["genre"] = makeField(genres, "musicbrainz", answer.fetchedAt);
    }
    return out;
  } catch (error) {
    // A cache miss is not a failure: the album simply has no album-level answer today, and
    // the union of the tracks' genres is the documented fallback.
    if (MMError.from(error).code === "OFFLINE_CACHE_MISS") return {};
    throw error;
  }
}

/** Resolve the album-scope fields over a set of documents already in track order. */
export async function resolveOver(
  documents: readonly TrackDocument[],
  options: ResolveOptions,
): Promise<AlbumScopeResolution> {
  return resolveAlbumScope(documents, {
    maxGenres: options.settings.maxGenres,
    albumValues: await albumValues(options),
  });
}

/**
 * The resolution of one **library** album, rebuilt from the raw cache.
 *
 * Two decisions are worth stating, because they are what makes a re-tag converge:
 *
 *  - **the whole album, always** — even when the batch holds four of its thirteen files. "The
 *    album's genre" is a fact about the album; a batch that resolved over its own four tracks
 *    would answer differently on every batch and never settle.
 *  - **the raw values, not the stored ones.** `rebuild` replays the sources offline, so the
 *    input is what MusicBrainz and the descriptions actually said — which does not change
 *    when a previous batch stored the unified value. Resolving over the stored documents
 *    would feed the resolver its own output, and a capped union would drift.
 *
 * `persist: false` matters: the rebuild is a *reading*, and writing the per-track genre back
 * would be the very regression this module exists to remove.
 */
export async function resolveLibraryAlbum(
  albumId: string,
  options: { db?: Database; settings: Settings; signal?: AbortSignal },
): Promise<AlbumScopeResolution> {
  const db = options.db ?? defaultDb();

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);

  const tracks = await db
    .select({ id: libraryTracks.id, importTrackId: libraryTracks.importTrackId })
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId))
    .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);

  const documents: TrackDocument[] = [];
  for (const track of tracks) {
    if (track.importTrackId === null) continue;
    try {
      const built = await rebuildDocument(track.importTrackId, {
        db,
        settings: options.settings,
        offline: true,
        persist: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      documents.push(built.document);
    } catch {
      // A file whose sources are not in the cache cannot vote. It is still re-tagged; its own
      // rebuild will fail on its own terms, with its own diff row.
    }
  }
  if (documents.length === 0) return { choices: [], divergentFields: [] };

  return await resolveOver(documents, {
    ...options,
    ...(album === undefined ? {} : { releaseMbid: album.releaseMbid }),
  });
}

/**
 * One resolution per album, computed once and reused for every file of a batch.
 *
 * Rebuilding thirteen documents for each of thirteen files would be quadratic; the cache makes
 * it linear and, because the input is the raw cache, every call in the run gets the same
 * answer.
 */
export function albumScopeResolver(options: {
  db?: Database;
  settings: Settings;
  signal?: AbortSignal;
}): (albumId: string | null) => Promise<AlbumScopeResolution> {
  const cache = new Map<string, Promise<AlbumScopeResolution>>();
  const none: AlbumScopeResolution = { choices: [], divergentFields: [] };
  return async (albumId) => {
    if (albumId === null) return none;
    const held = cache.get(albumId);
    if (held !== undefined) return await held;
    const pending = resolveLibraryAlbum(albumId, options);
    cache.set(albumId, pending);
    return await pending;
  };
}

export { applyAlbumScopeTo, changedChoices };

/** One line per rewritten field, for a journal entry or a step message. */
export function describeChoices(choices: readonly AlbumScopeChoice[]): string {
  if (choices.length === 0) return "album-scope fields already agree";
  return choices
    .map((choice) => `${choice.field} (${String(choice.changes.length)} track(s))`)
    .join(", ");
}
