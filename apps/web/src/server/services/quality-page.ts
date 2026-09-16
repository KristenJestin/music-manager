/**
 * `/library/quality`, as one payload.
 *
 * It lives in a service and not in `server/functions/quality.ts` for the reason named at the
 * top of `server/functions/base.ts`: a **non-handler export** from a server-function module
 * survives the client split, and everything below touches Drizzle. The handler is a wrapper.
 *
 * ## What is paged and what is not
 *
 * The rows are paged, and nothing else is. The chips, the seven tiles and the sort are all
 * library-wide statements — "there are nine untagged albums", "metadata is 94 % on average",
 * "worst first" — so they are computed over every album and only the page travels. That is
 * also why this page still reads every document once, and the decision is deliberate rather
 * than an oversight:
 *
 *  - the order is the **penalised** score (`albumCompleteness`: the mean of the tracks minus
 *    the album-scope divergence penalty). `metadata_documents.completeness` holds the mean;
 *    no column holds the penalty, and ordering by an SQL approximation would put the rows in
 *    an order the badges on them contradict;
 *  - the profile picker re-scores every album through one consumer's field set, and no column
 *    holds a per-profile score either;
 *  - `drift` — the stored projection no longer hashing to what was written into the file — is
 *    a function of the document's *values*, and the only stored hash is the one that was
 *    written. Three of the ten chips (`drift`, `lyrics`, `replaygain`) and one tile are
 *    counted from it.
 *
 * Paging the *read* therefore needs a stored, maintained column (the document's own current
 * projection hash, and the six profile scores) rather than a rearrangement of this file. What
 * this file does remove is the **second** full pass: `countOffTemplate` used to run here, and
 * it read every document again and made up to two synchronous `existsSync` calls per track —
 * ten thousand blocking stats on the SSR event loop to put an integer on a button. It is the
 * relocate dry run's job now (`services/relocate.ts`).
 */
import { PROFILES, unreadCount, type ProfileId } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { pageInfo } from "#/server/api/paging.ts";
import {
  QUALITY_FILTERS,
  matchesFilter,
  scoreLibrary,
  summarise,
  tagMapRows,
  listQuality,
  type AlbumListQuality,
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

/** How many albums one page of the quality table draws. */
export const QUALITY_PAGE_SIZE = 50;

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
  readonly quality: AlbumListQuality;
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
  /** One page of albums, worst first. `total` says how many the filter matched. */
  readonly rows: readonly QualityAlbumRow[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly page: number;
  readonly pageSize: number;
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
  readonly pathTemplate: string;
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

export async function qualityPayload(
  options: { filter: QualityFilter; profile: ProfileId | "global"; page?: number },
  db: Database = defaultDb(),
): Promise<QualityPayload> {
  const settings = await loadSettings(db);
  const { rows, currentSchema } = await scoreLibrary({ db, settings });
  const profile = options.profile;
  const page = options.page ?? 0;
  const offset = page * QUALITY_PAGE_SIZE;

  const shown = rows
    .filter((row) => matchesFilter(row, options.filter, profile))
    .sort((a, b) => {
      const left = profile === "global" ? a.quality.score : a.quality.byProfile[profile];
      const right = profile === "global" ? b.quality.score : b.quality.byProfile[profile];
      // Worst first: the page exists to be worked down, not admired.
      return (left ?? 1) - (right ?? 1);
    });

  const [running, recent] = await Promise.all([activeRun(db), listRuns({ limit: 8 }, db)]);

  return {
    rows: shown.slice(offset, offset + QUALITY_PAGE_SIZE).map(({ album, quality }) => ({
      albumId: album.id,
      title: album.title,
      albumArtist: album.albumArtist,
      year: album.year,
      folder: album.folder,
      releaseMbid: album.releaseMbid,
      quality: listQuality(quality),
    })),
    ...pageInfo(shown.length, offset, QUALITY_PAGE_SIZE),
    page,
    pageSize: QUALITY_PAGE_SIZE,
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
    pathTemplate: settings.pathTemplate,
  };
}
