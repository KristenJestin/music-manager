/**
 * What a release's tracklist looks like next to the files we actually hold — the pure half.
 *
 * It lives in `lib/` rather than beside `server/services/album-missing.ts` for one concrete
 * reason: the album page renders the missing tracks *interleaved with the present ones*, so it
 * needs `interleaveSlots` as a **value** in the browser. A value import of `#/server/**` from a
 * route drags Drizzle, `postgres` and the toolbox client into the client bundle, and
 * `client-boundary.guard.test.ts` is what refuses it. This module imports nothing impure, so
 * the page, the server service and the tests all read one implementation.
 *
 * `server/services/album-missing.ts` is the other half: the database reads, the raw-cache
 * lookup and the adoption. It imports these and re-exports the types, so a server caller never
 * has to know the split exists.
 *
 * ## The key is the couple, never the position alone
 *
 * A release is a list of *media*, each with its own tracklist restarting at 1. Flattening the
 * two into one running index and comparing that is how this repository has already invented
 * false holes: disc 2 track 1 and disc 1 track 1 are not the same slot, and an album holding
 * all of disc 1 and none of disc 2 reports every position from 1 to n as both present and
 * missing at once. The identity of a slot is `(mediumPosition, trackPosition)`, everywhere,
 * and `slotKey` is the only thing allowed to build it.
 */
import { creditName } from "@mm/domain";
import type { MbRelease } from "@mm/domain";

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

/** What a held track knows about where it sits and what it is. */
export interface HeldTrack {
  /** `null` reads as disc 1: a single-disc rip very often leaves the tag off entirely. */
  readonly discNumber: number | null;
  readonly trackNumber: number | null;
  readonly trackMbid: string | null;
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

/**
 * The identity of a slot, as a string a `Set` can hold.
 *
 * The only place the couple is flattened, and it flattens it *reversibly* — `2:7` is disc 2
 * track 7 and can never collide with disc 1 track 27. A running index would.
 */
export function slotKey(mediumPosition: number, trackPosition: number): string {
  return `${String(mediumPosition)}:${String(trackPosition)}`;
}

/**
 * The release's tracks that nothing in `held` accounts for, in release order.
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
 * Reporting a track as missing that is sitting on the disk is the one outcome that makes this
 * feature worse than the counter it replaces: it invites the owner to re-download a file he
 * already has, over the top of itself.
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
 * The Console's half of this feature is *the missing lines, greyed, at their own positions*,
 * and a page that appended the four missing rows under the sixteen present ones would have
 * answered a different question — "which are missing" rather than "what does this record look
 * like". Interleaving is what turns the list back into the record.
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
