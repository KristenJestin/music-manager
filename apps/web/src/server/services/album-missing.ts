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
import { and, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { creditName, type MbRelease } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { importTracks, libraryAlbums, libraryTracks } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import { adoptTrackFile, type AdoptResult, type AdoptSource } from "#/server/services/adopt.ts";
import { countersFor, type AlbumCounters } from "#/server/services/album-counters.ts";
import { importBehindAlbum } from "#/server/services/library.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import type { ToolboxClient } from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

/**
 * One track the retained release has and the album does not.
 *
 * Everything a person or an agent needs in order to recognise it and go and find it: where it
 * sits, what it is called, who plays it, and the MusicBrainz ids that let a caller look it up
 * without guessing from the title.
 */
export interface MissingTrack {
  /** 1-based, and 1 on a single-disc release. Half of the identity of the slot. */
  readonly mediumPosition: number;
  /** 1-based **within its medium**, which is why it is never used on its own. */
  readonly trackPosition: number;
  /** What MusicBrainz prints for the position — `7` on a CD, `A2` on a vinyl. */
  readonly number: string;
  readonly title: string;
  /** The track's own credit, which on a compilation is not the album artist. */
  readonly artist: string | null;
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
  readonly lengthSeconds: number | null;
  /** `Disc 2` and friends, when the medium has a name of its own. */
  readonly mediumTitle: string | null;
}

/** One slot of the retained release's tracklist, present or not, in release order. */
export type AlbumSlot<T> =
  | {
      readonly kind: "present";
      readonly mediumPosition: number;
      readonly trackPosition: number;
      readonly track: T;
    }
  | {
      readonly kind: "missing";
      readonly mediumPosition: number;
      readonly trackPosition: number;
      readonly track: MissingTrack;
    };

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
/* the pure comparison                                                 */
/* ------------------------------------------------------------------ */

/**
 * The identity of a slot, as a string a `Set` can hold.
 *
 * The only place the couple is flattened, and it flattens it *reversibly* — `2:7` is disc 2
 * track 7 and can never collide with disc 1 track 27. A running index would.
 */
export function slotKey(mediumPosition: number, trackPosition: number): string {
  return `${String(mediumPosition)}:${String(trackPosition)}`;
}

/** What a held track knows about where it sits and what it is. */
export interface HeldTrack {
  /** `null` reads as disc 1: a single-disc rip very often leaves the tag off entirely. */
  readonly discNumber: number | null;
  readonly trackNumber: number | null;
  readonly trackMbid: string | null;
}

/**
 * The release's tracks that nothing in `held` accounts for, in release order.
 *
 * Pure, so the multi-disc rule is testable without a database or a network — which matters,
 * because the multi-disc rule is the one this repository has already got wrong once.
 */
export function missingTracksOf(
  release: MbRelease,
  held: readonly HeldTrack[],
): readonly MissingTrack[] {
  const heldSlots = new Set<string>();
  const heldMbids = new Set<string>();
  for (const track of held) {
    if (track.trackMbid !== null && track.trackMbid !== "") heldMbids.add(track.trackMbid);
    // A row with no track number cannot claim a slot; it can still claim an id above.
    if (track.trackNumber === null) continue;
    heldSlots.add(slotKey(track.discNumber ?? 1, track.trackNumber));
  }

  const out: MissingTrack[] = [];
  for (const [mediumIndex, medium] of (release.media ?? []).entries()) {
    // MusicBrainz numbers its media from 1 and always sends `position`; the index is the
    // fallback for a payload pruned by `scripts/prune-musicbrainz.ts`.
    const mediumPosition = medium.position ?? mediumIndex + 1;
    for (const [trackIndex, track] of (medium.tracks ?? []).entries()) {
      const trackPosition = track.position ?? trackIndex + 1;
      const mbid = track.id ?? null;
      if (mbid !== null && heldMbids.has(mbid)) continue;
      if (heldSlots.has(slotKey(mediumPosition, trackPosition))) continue;
      out.push({
        mediumPosition,
        trackPosition,
        number: track.number ?? String(trackPosition),
        title: track.title ?? track.recording?.title ?? "(untitled)",
        artist: creditName(track["artist-credit"] ?? track.recording?.["artist-credit"]),
        trackMbid: mbid,
        recordingMbid: track.recording?.id ?? null,
        lengthSeconds:
          track.length === undefined || track.length === null ? null : track.length / 1000,
        mediumTitle: medium.title ?? null,
      });
    }
  }
  return out;
}

/**
 * The tracks we hold and the ones we do not, woven into one list in release order.
 *
 * The Console's half of the feature is *"grisées et à leur position"*, and a page that appended
 * the four missing lines under the sixteen present ones would have answered a different
 * question — "which are missing" rather than "what does this record look like". Interleaving is
 * what turns the list back into the record.
 *
 * Present tracks the release does not mention keep their place at the end of their own medium
 * rather than being dropped: a bonus track, or a row whose numbering is wrong, is still a file
 * on the disk and hiding it would be a lie of a different kind.
 */
export function interleaveSlots<T extends HeldTrack>(
  present: readonly T[],
  missing: readonly MissingTrack[],
): readonly AlbumSlot<T>[] {
  const slots: AlbumSlot<T>[] = [
    ...present.map((track): AlbumSlot<T> => ({
      kind: "present",
      mediumPosition: track.discNumber ?? 1,
      // A row with no track number sorts to the end of its disc rather than to the front:
      // `null` is "we never knew", and the front is where track 1 lives.
      trackPosition: track.trackNumber ?? Number.MAX_SAFE_INTEGER,
      track,
    })),
    ...missing.map((track): AlbumSlot<T> => ({
      kind: "missing",
      mediumPosition: track.mediumPosition,
      trackPosition: track.trackPosition,
      track,
    })),
  ];
  return slots.sort(
    (one, other) =>
      one.mediumPosition - other.mediumPosition || one.trackPosition - other.trackPosition,
  );
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
 * then `place`, on the per-track queue. The album's other fifteen files are not touched, not
 * re-tagged and not re-placed.
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

  const existing = await importTrackForSlot(db, importId, wanted);
  const track =
    existing ??
    (await createSourcelessImportTrack({
      db,
      importId,
      trackMbid: wanted.trackMbid,
      recordingMbid: wanted.recordingMbid,
      trackTitle: wanted.title,
      trackPosition: wanted.trackPosition,
      mediumPosition: wanted.mediumPosition,
    }));

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

/* ================================================================== */
/* MERGE — symbols owned by `adopt-url-sourceless`, declared here so   */
/* this branch compiles before that one lands. See the report.         */
/* ================================================================== */

/**
 * Create an `import_tracks` row bound to a MusicBrainz track and to **no source**.
 *
 * `refuseAdoption` answers `ADOPT_NOT_READY` — *"this video is not bound to a track"* — for
 * anything whose `role` is not `mapped`, and every mapped row until now came from a listing
 * entry. A track the playlist never published has no entry and never will, so the row has to
 * be made: same mapping columns, same `role`, an empty `video_id` and an empty `url`.
 *
 * `video_id` is `not null` in the schema, so "no source" is the empty string and not `NULL` —
 * a distinction worth stating because `documents.ts` keys the YouTube resolvers off it.
 *
 * **Owned by the `adopt-url-sourceless` branch.** Declared here, with this name and this
 * shape, so that the merge is a deletion of one of the two copies rather than a reconciliation
 * of two different designs.
 */
export interface SourcelessTrackInput {
  readonly importId: string;
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
  readonly trackTitle: string;
  readonly trackPosition: number;
  readonly mediumPosition: number;
  readonly db?: Database;
}

export async function createSourcelessImportTrack(
  input: SourcelessTrackInput,
): Promise<typeof importTracks.$inferSelect> {
  const db = input.db ?? defaultDb();

  /*
   * `position` is the listing index, and `(import_id, position)` is unique. A sourceless row
   * was never in the listing, so it takes the next free index rather than the track's own
   * position — which on a two-disc release would collide with disc 1's row at the same number.
   */
  const siblings = await db
    .select({ position: importTracks.position })
    .from(importTracks)
    .where(eq(importTracks.importId, input.importId));
  const position = siblings.reduce((top, row) => Math.max(top, row.position), 0) + 1;

  const [created] = await db
    .insert(importTracks)
    .values({
      id: newId("importTrack"),
      importId: input.importId,
      position,
      // Not `NULL`: the column is `not null`, and an empty string is the honest spelling of
      // "there is no video", which is exactly what the document resolvers have to see.
      videoId: "",
      url: "",
      sourceTitle: input.trackTitle,
      raw: {},
      role: "mapped",
      state: "pending",
      trackMbid: input.trackMbid,
      recordingMbid: input.recordingMbid,
      trackTitle: input.trackTitle,
      trackPosition: input.trackPosition,
      mediumPosition: input.mediumPosition,
      note: "no source: this track was never published by the album's playlist",
    })
    .returning();

  if (created === undefined) {
    throw new MMError("UNKNOWN", "The sourceless track row could not be created.", {
      status: 500,
    });
  }
  return created;
}

/** Rows this import holds for a slot, exported for the tests that check the materialisation. */
export async function sourcelessTracksOf(
  importId: string,
  db: Database = defaultDb(),
): Promise<readonly (typeof importTracks.$inferSelect)[]> {
  return await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), eq(importTracks.videoId, "")));
}
