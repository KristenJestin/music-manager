/**
 * `/library/quality` — metadata completeness, per profile, with the schema column.
 *
 * The page is a table of albums and a row of numbers above it, and both come from one call:
 * scoring the library is three queries and a lot of arithmetic, and doing it twice so the
 * tiles and the rows could be fetched separately would be slower and could disagree.
 *
 * The payload itself is built in `services/quality-page.ts` — a non-handler export here would
 * survive the client split (`server/functions/base.ts`), and a service is also something a
 * test can call without a session.
 */
import { z } from "zod";
import { PROFILE_IDS, type ProfileId } from "@mm/domain";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { QUALITY_FILTERS, type QualityFilter } from "#/server/services/quality.ts";
import { qualityPayload, type QualityPayload } from "#/server/services/quality-page.ts";

export type {
  ProfileSummary,
  QualityAlbumRow,
  QualityPayload,
  RetagProgress,
} from "#/server/services/quality-page.ts";

export const fetchQuality = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      filter: z.enum(QUALITY_FILTERS).default("all"),
      profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
      page: z.number().int().min(0).default(0),
    }),
  )
  .handler(async ({ data }): Promise<QualityPayload> => {
    try {
      return await qualityPayload(
        {
          filter: data.filter as QualityFilter,
          profile: data.profile as ProfileId | "global",
          page: data.page,
        },
        db(),
      );
    } catch (error) {
      return toFailure(error);
    }
  });
