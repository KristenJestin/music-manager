/**
 * What the mini-player asks the server for.
 *
 * Exactly one thing: "given this Discover subject, what can I play?". A library track needs no
 * server call at all — the page already holds its id and `/api/stream` takes it from there —
 * so this module is only about the half that has to be *found*.
 *
 * The order of preference is the point. If we own the recording, we play **our own file**,
 * full length, rather than somebody else's thirty-second clip; the preview exists for what is
 * not in the library, and using it for what is would be a worse experience dressed up as a
 * feature. `inLibrary` on the row is only a hint here — it is computed by the sync and can be
 * a few hours old — so the library is asked directly, by recording MBID, every time.
 *
 * Nothing matching is `{ tracks: [] }` with a reason, never a thrown error: Deezer's catalogue
 * is not MusicBrainz's, and the Console renders "No preview" as a disabled button.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { libraryCover, SLOT_SIZES } from "#/lib/cover-sources.ts";
import { previewExpired } from "#/lib/playback.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { getItemBySubject } from "#/server/services/discover.ts";
import { trackByRecordingMbid } from "#/server/services/library.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import {
  parseSubject,
  resolvePreview as resolvePreviewTracks,
  type PlayableTrack,
} from "#/server/services/preview.ts";

export interface PreviewAnswer {
  readonly tracks: readonly PlayableTrack[];
  /** Where they came from. `none` is a normal answer and carries `reason`. */
  readonly source: "library" | "deezer" | "none";
  /** Shown in the tooltip of a disabled play button. Null when there is something to play. */
  readonly reason: string | null;
}

const NOTHING: PreviewAnswer = {
  tracks: [],
  source: "none",
  reason: "Deezer has no preview for this one.",
};

export const resolvePreview = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      subject: z.string().min(1),
      /**
       * Skip the one-hour preview cache and ask Deezer again.
       *
       * The player sets it after a clip has failed to load, which is the only moment where
       * paying a second search is obviously worth it. It is not a "give me a better answer"
       * flag: the search and the scoring are identical, only the cached *ticket* is discarded.
       */
      refresh: z.boolean().default(false),
    }),
  )
  .handler(async ({ data }): Promise<PreviewAnswer> => {
    try {
      const parsed = parseSubject(data.subject);
      if (parsed === null) {
        return { tracks: [], source: "none", reason: "Nothing playable for this item." };
      }

      // Ours first, always.
      if (parsed.kind === "recording") {
        const owned = await trackByRecordingMbid(parsed.mbid, db());
        if (owned !== null) {
          return {
            source: "library",
            reason: null,
            tracks: [
              {
                id: `library:${owned.id}`,
                title: owned.title,
                artist: owned.artist,
                album: owned.albumTitle,
                src: `/api/stream?track=${encodeURIComponent(owned.id)}`,
                source: "library",
                subject: data.subject,
                // The player bar draws its tile at `sm`, so ask for that variant and not the
                // 1200 px file on disk.
                coverUrl: libraryCover(owned.albumId, SLOT_SIZES.sm.local),
                durationSeconds: owned.durationSeconds,
              },
            ],
          };
        }
      }

      const item = await getItemBySubject(data.subject, db());
      if (item === null) {
        return { tracks: [], source: "none", reason: "That suggestion is no longer listed." };
      }

      const request = {
        subject: item.subject,
        title: item.title,
        artist: item.artist,
        albumTitle: item.albumTitle,
      };
      const ctx = await sourceContextFor(db());
      let tracks = await resolvePreviewTracks({ ...ctx, refresh: data.refresh }, request);

      /*
       * A cached ticket that has already lapsed is worse than no cache at all.
       *
       * The preview rows live for an hour and the signature for about four, so most of the
       * time these agree. They stop agreeing whenever Deezer issues a shorter one, and the
       * result is a button that looks fine and produces silence. Checking the `exp` we were
       * about to hand out costs a regular expression, and re-asking once costs a search.
       */
      if (!data.refresh && tracks !== null && tracks.some((track) => previewExpired(track.src))) {
        tracks = await resolvePreviewTracks({ ...ctx, refresh: true }, request);
      }

      if (tracks === null || tracks.length === 0) return NOTHING;
      return { tracks, source: "deezer", reason: null };
    } catch (error) {
      return toFailure(error);
    }
  });
