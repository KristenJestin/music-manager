/**
 * ⌘K's four reads, as server functions.
 *
 * They are four rather than one because the palette has to be able to *not* ask the expensive
 * ones. One function taking a query and answering everything would put MusicBrainz on the
 * keystroke path, which is the thing the shared one-per-second gate cannot survive.
 *
 * Every one carries `sessionMiddleware` — `functions.guard.test.ts` walks this file. Nothing
 * but types is exported besides the functions themselves (see `base.ts`).
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  paletteRef,
  pinnableReleaseOfGroup,
  searchLibrary,
  searchMusicBrainz,
  tracksMatchingRecording,
  type LibraryHits,
  type MbHits,
  type PaletteRef,
  type RecordingTracks,
} from "#/server/services/palette.ts";

/** Long enough for a pasted URL, short enough that nobody is searching with a novel. */
const term = z.string().trim().min(1).max(500);

/**
 * The library, locally — the only one of the four that runs from a keystroke.
 *
 * A `GET`, because it is a read with no consequence and a browser may cache it between two
 * identical queries; the other three are reads too, but two of them spend the MusicBrainz
 * budget and one of them is a decision, so they say `POST` to stay out of a prefetch.
 */
export const paletteLibrary = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ query: term }))
  .handler(async ({ data }): Promise<LibraryHits> => {
    try {
      return await searchLibrary(data.query, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * What is this id? — asked once the typing has settled, not once per keystroke.
 *
 * The one MusicBrainz call the palette makes unasked, and the wizard already makes the same
 * bet for the same reason (`resolvePastedRef`): looking an id up *before* refusing is what
 * turns "no recording with id X" — for a perfectly good release — into a row that names what
 * the thing is and offers what it affords. `null` means the string holds no reference at all,
 * which is the palette's signal to leave it to the searches.
 */
export const paletteIdentify = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ input: term }))
  .handler(async ({ data }): Promise<PaletteRef | null> => {
    try {
      return await paletteRef(data.input, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * MusicBrainz in words — two searches, two seconds, and only when a row is pressed.
 *
 * The palette shows it as an offer ("Ask MusicBrainz for …") rather than running it, and this
 * is what that offer calls. Debouncing would not be enough here: the gate is installation-wide
 * and shared with the worker, so a search fired on a settled query is still a search the
 * import running in the background has to wait behind.
 */
export const paletteMusicBrainz = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ query: term }))
  .handler(async ({ data }): Promise<MbHits> => {
    try {
      return await searchMusicBrainz(data.query, { db: db() });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Where a MusicBrainz hit actually goes, resolved at the moment it is chosen.
 *
 * Two things a row cannot know until it is pressed, and neither is worth a request while
 * somebody is still typing: which edition of a release group to pin (`release-group`), and
 * which of your tracks a recording is (`recording`). One shape, because the palette does the
 * same thing with both answers — navigate.
 */
export const paletteFollow = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      kind: z.enum(["release-group", "recording"]),
      mbid: z.string().min(1).max(64),
      /** A recording's title, so the library can be searched for it when the id is unknown. */
      title: z.string().max(500).nullable().default(null),
    }),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      readonly releaseMbid: string | null;
      readonly tracks: RecordingTracks | null;
    }> => {
      try {
        if (data.kind === "release-group") {
          const found = await pinnableReleaseOfGroup(data.mbid, { db: db() });
          return { releaseMbid: found?.releaseMbid ?? null, tracks: null };
        }
        return {
          releaseMbid: null,
          tracks: await tracksMatchingRecording(data.mbid, data.title, { db: db() }),
        };
      } catch (error) {
        return toFailure(error);
      }
    },
  );
