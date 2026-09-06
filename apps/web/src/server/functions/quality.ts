/**
 * `/library/quality` — metadata completeness, per profile, with the schema column.
 *
 * The page is a table of albums and a row of numbers above it, and both come from one call:
 * scoring the library is three queries and a lot of arithmetic, and doing it twice so the
 * tiles and the rows could be fetched separately would be slower and could disagree.
 */
import { z } from "zod";
import { PROFILE_IDS, PROFILES, unreadCount, type ProfileId } from "@mm/domain";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  QUALITY_FILTERS,
  matchesFilter,
  scoreLibrary,
  summarise,
  tagMapRows,
  type AlbumQuality,
  type LibraryQualityStats,
  type QualityFilter,
  type TagMapRow,
} from "#/server/services/quality.ts";
import {
  effectiveChangelog,
  effectiveSchemaVersion,
  isSchemaOverridden,
} from "#/server/services/schema-version.ts";
import { loadSettings } from "#/server/services/settings.ts";
import { activeRun, listRuns } from "#/server/services/retag.ts";

/** One profile, as the picker shows it. Derived from `@mm/domain`, never restated. */
export interface ProfileSummary {
  readonly id: ProfileId;
  readonly name: string;
  readonly kind: "server" | "player";
  readonly status: "verified" | "unconfirmed";
  readonly via: string;
  readonly note: string;
  readonly reads: number;
  readonly unread: number;
  readonly sidecars: readonly string[];
  readonly lyrics: readonly string[];
}

export interface QualityAlbumRow {
  readonly albumId: string;
  readonly title: string;
  readonly albumArtist: string;
  readonly year: number | null;
  readonly folder: string;
  readonly releaseMbid: string | null;
  readonly quality: AlbumQuality;
}

export interface RetagProgress {
  readonly runId: string;
  readonly status: string;
  readonly dryRun: boolean;
  readonly total: number;
  readonly done: number;
  readonly changed: number;
  readonly failed: number;
  readonly schemaVersion: number;
  readonly scope: string;
}

export interface QualityPayload {
  readonly rows: readonly QualityAlbumRow[];
  readonly counts: Readonly<Record<QualityFilter, number>>;
  readonly stats: LibraryQualityStats;
  readonly profiles: readonly ProfileSummary[];
  readonly tagMap: readonly TagMapRow[];
  readonly changelog: readonly {
    version: number;
    at: string;
    added: readonly string[];
    changed: readonly string[];
    removed: readonly string[];
    note: string;
  }[];
  readonly currentSchema: number;
  readonly schemaOverridden: boolean;
  readonly active: RetagProgress | null;
  readonly recent: readonly RetagProgress[];
}

function toProgress(run: {
  id: string;
  status: string;
  dryRun: boolean;
  total: number;
  done: number;
  changed: number;
  failed: number;
  schemaVersion: number;
  scope: string;
}): RetagProgress {
  return {
    runId: run.id,
    status: run.status,
    dryRun: run.dryRun,
    total: run.total,
    done: run.done,
    changed: run.changed,
    failed: run.failed,
    schemaVersion: run.schemaVersion,
    scope: run.scope,
  };
}

export const fetchQuality = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      filter: z.enum(QUALITY_FILTERS).default("all"),
      profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
    }),
  )
  .handler(async ({ data }): Promise<QualityPayload> => {
    try {
      const settings = await loadSettings(db());
      const { rows, currentSchema } = await scoreLibrary({ db: db(), settings });
      const profile = data.profile as ProfileId | "global";

      const shown = rows
        .filter((row) => matchesFilter(row, data.filter, profile))
        .sort((a, b) => {
          const left = profile === "global" ? a.quality.score : a.quality.byProfile[profile];
          const right = profile === "global" ? b.quality.score : b.quality.byProfile[profile];
          // Worst first: the page exists to be worked down, not admired.
          return (left ?? 1) - (right ?? 1);
        });

      const [running, recent] = await Promise.all([activeRun(db()), listRuns({ limit: 8 }, db())]);

      return {
        rows: shown.map(({ album, quality }) => ({
          albumId: album.id,
          title: album.title,
          albumArtist: album.albumArtist,
          year: album.year,
          folder: album.folder,
          releaseMbid: album.releaseMbid,
          quality,
        })),
        counts: Object.fromEntries(
          QUALITY_FILTERS.map((filter) => [
            filter,
            rows.filter((row) => matchesFilter(row, filter, profile)).length,
          ]),
        ) as Record<QualityFilter, number>,
        stats: summarise(rows, currentSchema, isSchemaOverridden(settings)),
        profiles: PROFILES.map((entry) => ({
          id: entry.id,
          name: entry.name,
          kind: entry.kind,
          status: entry.status,
          via: entry.via,
          note: entry.note,
          reads: entry.reads.length,
          unread: unreadCount(entry),
          sidecars: entry.sidecars,
          lyrics: entry.lyrics,
        })),
        tagMap: tagMapRows(),
        changelog: effectiveChangelog(settings).map((entry) => ({ ...entry })),
        currentSchema: effectiveSchemaVersion(settings),
        schemaOverridden: isSchemaOverridden(settings),
        active: running === null ? null : toProgress(running),
        recent: recent.map(toProgress),
      };
    } catch (error) {
      return toFailure(error);
    }
  });
