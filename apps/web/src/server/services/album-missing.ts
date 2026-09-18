/**
 * The holes in an album, named — and the door that fills one of them.
 *
 * `library_albums` has carried `track_count` and `present_count` since `album-counters.ts`
 * made them one rule, so the Console, the CLI and the API have all been able to say *16/20*
 * for a while. None of them could say **which four**, and that is the whole difference between
 * a number and a remedy: the owner reading *16/20* on `Cars` has to open MusicBrainz in
 * another tab, copy the release's tracklist out by hand and diff it against the album page by
 * eye before he knows that what is missing is Chuck Berry's *Route 66* at 2, *Sh-Boom* at 6,
 * John Mayer's *Route 66* at 7 and *My Heart Would Know* at 11.
 *
 * Every byte of that answer is already in the database. The release retained for the album is
 * in `source_cache` — `documents.build` put it there, and `album-counters.ts` already reads it
 * back to compute the denominator — and the tracks we hold are `library_tracks`. So this
 * module is a comparison and nothing more: **offline, no request, no new column**.
 *
 * The comparison itself — the couple `(mediumPosition, trackPosition)`, and why "present" is
 * the union of a matching track id and a matching couple — is `#/lib/album-slots.ts`, which
 * the album page reads too. This module is the database around it.
 *
 * ## The key is the couple, never the position alone
 *
 * A release is a list of *media*, each with its own tracklist restarting at 1. Flattening the
 * two into one running index and comparing that is how this repository has already invented
 * false holes: disc 2 track 1 and disc 1 track 1 are not the same slot, and an album holding
 * all of disc 1 and none of disc 2 reports every position from 1 to n as both present and
 * missing at once. So the identity of a slot here is `(mediumPosition, trackPosition)`,
 * everywhere, and `slotKey` is the only thing allowed to build it.
 *
 * ## Present means one of two things, and both count
 *
 * A held track matches a release track when their MusicBrainz **track ids** are equal, *or*
 * when their `(medium, position)` couples are. The union rather than either alone, because the
 * two fail in opposite directions and a false hole is much worse than a missed one:
 *
 *  - an album imported without MusicBrainz, or migrated from v1, has no `track_mbid` at all —
 *    on ids alone every one of its tracks would be reported missing;
 *  - an album whose disc numbers were never written, or were written wrong by whatever ripped
 *    it, has honest ids and useless positions — on positions alone the same thing happens.
 *
 * Reporting a track as missing that is sitting on the disk is the one outcome that makes the
 * feature worse than the counter it replaces: it invites the owner to re-download a file he
 * already has, over the top of itself.
 */
import { eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import type { MbRelease } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, libraryAlbums, libraryTracks } from "#/server/db/schema/index.ts";
import { missingTracksOf, slotKey, type MissingTrack } from "#/lib/album-slots.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import { adoptTrackFile, type AdoptResult, type AdoptSource } from "#/server/services/adopt.ts";
import { countersFor, type AlbumCounters } from "#/server/services/album-counters.ts";
import { materialiseSourcelessTracks } from "#/server/services/sourceless.ts";
import { importBehindAlbum } from "#/server/services/library.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import type { ToolboxClient } from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

/*
 * The comparison itself is `#/lib/album-slots.ts`, and deliberately not here.
 *
 * The album page renders the missing tracks interleaved with the present ones, so it needs
 * `interleaveSlots` as a *value* in the browser — and a value import of `#/server/**` from a
 * route drags Drizzle and `postgres` into the client bundle (`client-boundary.guard.test.ts`).
 * Keeping the pure half in `lib/` is what lets the page, this service, the API, the MCP tools
 * and the CLI all read one implementation of "which tracks are missing" instead of two.
 *
 * Re-exported so a server caller never has to know the split exists.
 */
export {
  interleaveSlots,
  missingTracksOf,
  slotKey,
  type AlbumSlot,
  type HeldTrack,
  type MissingTrack,
} from "#/lib/album-slots.ts";

/** Why an album's holes cannot be named. Each one has a different remedy, so each has a code. */
export type MissingUnavailable =
  /** The album was imported without MusicBrainz, so there is no tracklist to compare against. */
  | "no-release"
  /** The release is not in the raw cache. `refresh_album` fetches it; this call stays offline. */
  | "not-cached";

export interface AlbumMissing {
  readonly albumId: string;
  readonly releaseMbid: string | null;
  /** The denominator `library_albums.track_count` carries, restated here so one read suffices. */
  readonly trackCount: number;
  readonly presentCount: number;
  readonly completeness: number | null;
  /** How many media the release has. `> 1` is what makes the disc prefix worth drawing. */
  readonly mediumCount: number;
  readonly missing: readonly MissingTrack[];
  /**
   * `null` when the comparison ran. Otherwise why it could not, and the list is empty —
   * which a caller must not read as "nothing is missing".
   */
  readonly unavailable: MissingUnavailable | null;
}

/* ------------------------------------------------------------------ */
/* reading it out of the database, offline                             */
/* ------------------------------------------------------------------ */

/**
 * One album's holes, from the release already in the raw cache.
 *
 * Offline by construction: `lookupRelease` is called with `offline: true`, so a release nobody
 * has fetched answers `not-cached` rather than reaching for the network. The album page, the
 * API route and the MCP tool all read through here, and a page load must not be able to spend
 * a MusicBrainz request — that is what `refresh_album` is for, and the answer says so.
 */
export async function albumMissingTracks(
  albumId: string,
  options: { db?: Database; settings?: Settings; signal?: AbortSignal } = {},
): Promise<AlbumMissing> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));

  const [album] = await db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  if (album === undefined) {
    throw new MMError("NOT_FOUND", `No album with id ${albumId}.`, { status: 404 });
  }

  const base = {
    albumId,
    releaseMbid: album.releaseMbid,
    trackCount: album.trackCount,
    presentCount: album.presentCount,
    completeness: album.completeness,
  } as const;

  if (album.releaseMbid === null || album.releaseMbid === "") {
    return { ...base, mediumCount: 0, missing: [], unavailable: "no-release" };
  }

  const release = await cachedRelease(album.releaseMbid, {
    db,
    settings,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (release === null) {
    return { ...base, mediumCount: 0, missing: [], unavailable: "not-cached" };
  }

  const held = await db
    .select({
      discNumber: libraryTracks.discNumber,
      trackNumber: libraryTracks.trackNumber,
      trackMbid: libraryTracks.trackMbid,
    })
    .from(libraryTracks)
    .where(eq(libraryTracks.albumId, albumId));

  return {
    ...base,
    mediumCount: (release.media ?? []).length,
    missing: missingTracksOf(release, held),
    unavailable: null,
  };
}

/** The retained release, from `source_cache` alone. `null` on a miss — never a request. */
async function cachedRelease(
  mbid: string,
  options: { db: Database; settings: Settings; signal?: AbortSignal },
): Promise<MbRelease | null> {
  try {
    const answer = await musicbrainz.lookupRelease(
      {
        db: options.db,
        config: sourcesConfig(options.settings),
        offline: true,
        refresh: false,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      mbid,
    );
    return answer.data;
  } catch (error) {
    // The documented shape of "we have never fetched this". Anything else is a real fault.
    if (MMError.from(error).code === "OFFLINE_CACHE_MISS") return null;
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* filling one hole                                                    */
/* ------------------------------------------------------------------ */

export interface AdoptLibraryTrackOptions {
  readonly albumId: string;
  /** Half of the slot's identity. 1 on a single-disc release. */
  readonly mediumPosition: number;
  readonly trackPosition: number;
  readonly source: AdoptSource;
  /** Who asked. `console`, `api`, `cli library adopt`, `mcp` — the `adoptedBy` vocabulary. */
  readonly adoptedBy: string;
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly queue?: boolean;
}

export interface AdoptLibraryTrackResult extends AdoptResult {
  readonly albumId: string;
  readonly mediumPosition: number;
  readonly trackPosition: number;
  /** What the release calls the track this file was adopted for. */
  readonly trackTitle: string;
  /**
   * True when no `import_tracks` row existed for this slot and one was created with no source.
   *
   * The ordinary case for a playlist that never published the video: there is nothing to
   * "re-download", because there was never a listing entry to begin with.
   */
  readonly materialised: boolean;
  /**
   * The album's counters **as they are now** — before the queued steps have run.
   *
   * `present_count` only moves when `place` puts the file in the library, and `place` is what
   * calls `recountAlbum`. Reporting a number that has not happened yet would be the `1/1` bug
   * this repository already fixed once, in the other direction.
   */
  readonly counters: AlbumCounters;
}

/**
 * Give one of an album's missing tracks a file, or an address, and let the pipeline finish it.
 *
 * The seam, and the reason this is a separate function rather than an argument to
 * `adoptTrackFile`: adoption speaks `import_tracks`, and a hole in an album is a fact about a
 * *release*. Something has to translate `(album, disc 2, track 7)` into "this row", and on an
 * album whose playlist never published the video there is no row to find — it has to be made.
 * That translation is all this does. The bytes, the allow-list, the probe, the provenance
 * record and the re-opening of a finished import stay in `adoptTrackFile`, which is called
 * with exactly the options any other caller would pass it.
 *
 * What comes back is one track resuming the pipeline **on its own**: `fingerprint`, then `tag`,
 * then `place`, on the per-track queue. The album's other files are not touched, not re-tagged
 * and not re-placed — `download` recognises each of them where `place` left it and counts it as
 * present, which is what makes "for this track alone" true rather than merely intended.
 */
export async function adoptLibraryTrack(
  options: AdoptLibraryTrackOptions,
): Promise<AdoptLibraryTrackResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));

  const state = await albumMissingTracks(options.albumId, { db, settings });
  if (state.unavailable !== null) {
    throw new MMError(
      "ALBUM_NO_TRACKLIST",
      state.unavailable === "no-release"
        ? "This album has no MusicBrainz release, so nothing can say which tracks it is missing."
        : `The release ${state.releaseMbid ?? ""} is not in the local cache, so its tracklist cannot be read offline.`,
      {
        hint:
          state.unavailable === "no-release"
            ? "Re-import the album against a release to give it a tracklist."
            : "Run `refresh_album` (or `POST /library/albums/{id}/refresh`) once; it fetches the release and everything after it is offline.",
        action:
          state.unavailable === "no-release"
            ? "Re-import against a release"
            : "Refetch from MusicBrainz",
        status: 409,
      },
    );
  }

  const wanted = state.missing.find(
    (track) =>
      track.mediumPosition === options.mediumPosition &&
      track.trackPosition === options.trackPosition,
  );
  if (wanted === undefined) {
    throw new MMError(
      "ADOPT_CONFLICT",
      `Disc ${String(options.mediumPosition)} track ${String(options.trackPosition)} is not missing from this album.`,
      {
        hint:
          state.missing.length === 0
            ? "Every track of the retained release is accounted for."
            : `Missing right now: ${state.missing.map((track) => `${slotKey(track.mediumPosition, track.trackPosition)} ${track.title}`).join(", ")}.`,
        details: {
          missing: state.missing.map((track) => slotKey(track.mediumPosition, track.trackPosition)),
        },
        status: 409,
      },
    );
  }

  /*
   * Which import this track joins.
   *
   * The newest import that produced a file on this album — the same one `albumDetail` describes
   * the rest of the page from, and the one whose confirmed release is the tracklist we have
   * just compared against. An album with no import behind it at all (scanned off disk, migrated
   * from v1) has nothing to hang a pipeline run on, and says so rather than inventing one.
   */
  const importId = await importBehindAlbum(options.albumId, db);
  if (importId === null) {
    throw new MMError(
      "ADOPT_NOT_READY",
      "No import produced this album, so there is no pipeline run to add a track to.",
      {
        hint: "This album was scanned off disk or migrated from v1. Import it against its release first.",
        action: "Import against a release",
        status: 409,
      },
    );
  }

  /*
   * The row this file will hang on, made if the playlist never published the track.
   *
   * `materialiseSourcelessTracks` is `confirm`'s own helper, called here with a single cell: it
   * keys on `(mediumPosition, trackPosition)` exactly as this module does, it is idempotent, and
   * reusing it is what stops "a track with no video" meaning two different rows depending on
   * which door made it. It answers `existing` rather than a row when something already sits at
   * that slot — which `importTrackForSlot` has already looked for, so an empty `created` here
   * means a video's row is parked there and the album is not missing this track after all.
   */
  const existing = await importTrackForSlot(db, importId, wanted);
  let track = existing;
  if (track === null) {
    const made = await materialiseSourcelessTracks({
      db,
      importId,
      by: options.adoptedBy,
      cells: [
        {
          position: wanted.trackPosition,
          mediumPosition: wanted.mediumPosition,
          title: wanted.title,
          recordingMbid: wanted.recordingMbid,
          trackMbid: wanted.trackMbid,
          lengthSeconds: wanted.lengthSeconds,
        },
      ],
    });
    track = made.created[0] ?? null;
    if (track === null) {
      /*
       * The album is short of this track and the import is not: a row sits at the slot and has
       * already been filed, but no `library_tracks` row points at it.
       *
       * Adoption is the wrong tool for that. Nothing has been lost — the file is where `place`
       * left it — and giving the slot a *second* row would turn a bookkeeping gap into two
       * tracks claiming one position. `repair-orphans` is the door for it, because the repair
       * needed is to re-attach the row rather than to fetch audio.
       */
      throw new MMError(
        "ADOPT_CONFLICT",
        `Disc ${String(wanted.mediumPosition)} track ${String(wanted.trackPosition)} already has a row on import ${importId}, so the album is missing it only as far as the library is concerned.`,
        {
          hint: "The audio is already imported; what is missing is the `library_tracks` row that points at it. Run `mm library repair-orphans --apply`, which re-attaches a filed track from its own tags, rather than adopting a second copy.",
          action: "Repair the orphaned row",
          details: {
            importId,
            mediumPosition: wanted.mediumPosition,
            trackPosition: wanted.trackPosition,
          },
          status: 409,
        },
      );
    }
  }

  const result = await adoptTrackFile({
    importId,
    trackId: track.id,
    source: options.source,
    adoptedBy: options.adoptedBy,
    db,
    settings,
    ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
    ...(options.queue === undefined ? {} : { queue: options.queue }),
  });

  return {
    ...result,
    albumId: options.albumId,
    mediumPosition: wanted.mediumPosition,
    trackPosition: wanted.trackPosition,
    trackTitle: wanted.title,
    materialised: existing === null,
    counters: await countersFor(options.albumId, db),
  };
}

/**
 * An `import_tracks` row already bound to this slot and still without a file, or `null`.
 *
 * The case it catches is the one the owner actually has the other way round: a video that *was*
 * in the listing, was mapped to this track and then failed to download. Making a second,
 * sourceless row for it would leave the album with two rows claiming track 7 and the wrong one
 * winning at `place`. Matching on the MusicBrainz track id first and on the couple second, for
 * the same reason `missingTracksOf` does.
 */
async function importTrackForSlot(
  db: Database,
  importId: string,
  wanted: MissingTrack,
): Promise<typeof importTracks.$inferSelect | null> {
  const rows = await db.select().from(importTracks).where(eq(importTracks.importId, importId));
  const bound = rows.filter((row) => row.libraryPath === null);
  return (
    bound.find(
      (row) =>
        wanted.trackMbid !== null && row.trackMbid !== null && row.trackMbid === wanted.trackMbid,
    ) ??
    bound.find(
      (row) =>
        row.trackPosition === wanted.trackPosition &&
        (row.mediumPosition ?? 1) === wanted.mediumPosition,
    ) ??
    null
  );
}
