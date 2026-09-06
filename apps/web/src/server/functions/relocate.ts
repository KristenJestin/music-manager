/**
 * The Quality page's "Re-file N file(s)" button.
 *
 * Two calls, not one: the page shows the dry run first and the apply only afterwards, because
 * Navidrome identifies a file by its path and a move costs that track its play count and its
 * favourites. That is the whole reason this is not a single button that just does it.
 *
 * Everything lives in `services/relocate.ts`; this file is the session boundary and nothing
 * more, which is the rule for `server/functions/**`.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { relocate, type RelocateReport } from "#/server/services/relocate.ts";

export const runRelocate = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      albumId: z.string().nullable().default(null),
      /** Defaults to the safe one; the page asks twice before it sends `false`. */
      dryRun: z.boolean().default(true),
    }),
  )
  .handler(async ({ data }): Promise<RelocateReport> => {
    try {
      return await relocate({
        db: db(),
        dryRun: data.dryRun,
        ...(data.albumId === null ? {} : { albumId: data.albumId }),
      });
    } catch (error) {
      return toFailure(error);
    }
  });
