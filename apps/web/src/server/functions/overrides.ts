/**
 * Manual per-field overrides, as server functions — the Console's half of `services/overrides.ts`.
 *
 * Three functions rather than one with a mode, because they are three different refusals: a
 * per-track field cannot be set album-wide, an album-scope field cannot be set on one track,
 * and releasing a field takes no value at all. Making that explicit in the name is what stops
 * the UI from having to know the rule.
 *
 * Every one carries `sessionMiddleware` (`functions.guard.test.ts` walks this file), and
 * nothing but types is exported besides the functions themselves — a non-handler runtime
 * export survives the Vite plugin's client/server split and drags Drizzle into the browser
 * bundle (see `base.ts`).
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  overrideAlbumFields,
  overrideTrackFields,
  type OverrideResult,
} from "#/server/services/overrides.ts";

/**
 * One value, as typed.
 *
 * A multi-valued field arrives as one string per line from the editor and as an array from the
 * API; both are accepted here and normalised in the service, where the tag map says whether the
 * field is `multi` at all.
 */
const value = z.union([z.string(), z.array(z.string())]);

const edit = z.object({
  field: z.string().min(1),
  value: value.nullable().optional(),
  locked: z.boolean().optional(),
});

/** Set (and lock) one or more per-track fields on a library track. */
export const setTrackField = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), edits: z.array(edit).min(1) }))
  .handler(async ({ data, context }): Promise<OverrideResult> => {
    try {
      return await overrideTrackFields(data.id, data.edits, {
        db: db(),
        setBy: context.session.email,
      });
    } catch (error) {
      return toFailure(error);
    }
  });

/** Set (and lock) one or more album-scope fields on every track of an album. */
export const setAlbumField = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ id: z.string().min(1), edits: z.array(edit).min(1) }))
  .handler(async ({ data, context }): Promise<OverrideResult> => {
    try {
      return await overrideAlbumFields(data.id, data.edits, {
        db: db(),
        setBy: context.session.email,
      });
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Hand a field back to the resolvers.
 *
 * `value: null, locked: false` in the service's vocabulary: the field is removed from the
 * document and the track is rebuilt offline, so whatever MusicBrainz says takes over again.
 */
export const unlockField = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      scope: z.enum(["track", "album"]),
      id: z.string().min(1),
      field: z.string().min(1),
    }),
  )
  .handler(async ({ data, context }): Promise<OverrideResult> => {
    try {
      const edits = [{ field: data.field, value: null, locked: false }];
      const options = { db: db(), setBy: context.session.email };
      return data.scope === "album"
        ? await overrideAlbumFields(data.id, edits, options)
        : await overrideTrackFields(data.id, edits, options);
    } catch (error) {
      return toFailure(error);
    }
  });
