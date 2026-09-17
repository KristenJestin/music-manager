/**
 * `watched-sources.service` — a playlist or a channel, watched over time.
 *
 * A scan is three things and nothing else: **list** the source flatly, **diff** it by video id
 * against what this source has already seen, and **open one import per genuinely new video**.
 * Everything difficult about doing that safely is pushed into the database: the unique index
 * on `(source_id, video_id)` is what makes a scan idempotent, so two workers, a cron firing
 * during a manual "Scan now", or a process killed halfway through all converge on the same
 * rows rather than on duplicate imports.
 *
 * ## One import per video, and why not one per album
 *
 * A source that publishes a whole record drops twelve videos at once, and twelve imports of
 * one track each is measurably worse than one import of twelve: twelve release choices, twelve
 * folders' worth of album-scope guessing, twelve Inbox items. Grouping them would mean reading
 * each new video's YouTube Music `album` tag — which a flat listing does not carry, so it
 * costs a full extraction per new video — and then creating **an import whose source is a
 * subset of a listing**. That last part is the blocker: `createImport` and `resolveStep` are
 * built on "one URL is one listing", and an import over three videos of a playlist has no URL
 * to be created from. Inventing one (a synthetic `mm://group/…`, or a set of video ids on the
 * import row) is a change to the import model, not to this service.
 *
 * So this ships **one import per new video**, deliberately, and the grouping is written down
 * as the next thing rather than half-built. The cost is visible and bounded; the alternative
 * would have touched `resolve` for every import in the system.
 *
 * ## What the scan is allowed to decide
 *
 * Only what to *skip*. `docs/04-pipeline-et-matching.md` § Ce que l'algo ne fait jamais is
 * unambiguous — the algorithm never chooses the release for you — and nothing here does. The
 * one exception in the whole feature is `autoAccept`, which is per source, off by default, and
 * enforced in `confirmStep` against the match result rather than here.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  imports,
  watchedSourceItems,
  watchedSources,
  type ImportStatus,
  type StoredError,
  type WatchedItemStatus,
  type WatchedSource,
  type WatchedSourceItem,
  type WatchedSourceKind,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import type { ExtractEntry } from "#/server/toolbox/client.ts";
import { cookieJar } from "#/server/services/cookies.ts";
import { createImport } from "#/server/services/imports.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  admit,
  sourceRulesOf,
  type AdmissionVerdict,
  type SourceRules,
} from "#/server/services/source-rules.ts";

/* ------------------------------------------------------------------ */
/* the shape of a source                                               */
/* ------------------------------------------------------------------ */

/** A URL that points at a channel rather than at a playlist. Same shapes `resolve` knows. */
const CHANNEL = /youtube\.com\/(?:channel\/|c\/|user\/|@)/i;
const URL_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

/**
 * Priority of an import a scan opened.
 *
 * Negative, so a scan that woke up at four in the morning with forty new videos is still
 * behind the album you pasted at four o'clock in the afternoon. It is not a queue of its own:
 * one queue with an honest ordering is easier to reason about than two.
 */
export const WATCHED_IMPORT_PRIORITY = -10;

/** What the URL looks like it points at. The operator may override it. */
export function classifyWatchedUrl(url: string): WatchedSourceKind {
  return CHANNEL.test(url) ? "channel" : "playlist";
}

const urlSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => URL_SHAPE.test(value), {
    message: "A watched source is a YouTube playlist or channel URL (or a `fixture://` one).",
  });

export const watchedSourceInputSchema = z.object({
  url: urlSchema,
  kind: z.enum(["playlist", "channel"]).optional(),
  label: z.string().trim().max(200).optional(),
  enabled: z.boolean().optional(),
  autoAccept: z.boolean().optional(),
  autoAcceptThreshold: z.number().min(0).max(1).nullable().optional(),
  minDuration: z.number().int().min(0).max(86_400).nullable().optional(),
  maxDuration: z.number().int().min(0).max(86_400).nullable().optional(),
  requireProvidedToYouTube: z.boolean().optional(),
});

export type WatchedSourceInput = z.infer<typeof watchedSourceInputSchema>;

export const watchedSourcePatchSchema = watchedSourceInputSchema.partial().omit({ url: true });
export type WatchedSourcePatch = z.infer<typeof watchedSourcePatchSchema>;

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export interface WatchedSourceSummary {
  readonly source: WatchedSource;
  readonly total: number;
  readonly imported: number;
  readonly pending: number;
  readonly skipped: number;
}

/**
 * How many sources are watched. One `count(*)`.
 *
 * Settings' "watched sources" line was `(await listWatchedSources()).length`, which is two
 * queries — every source row, and a grouped tally of every item of every source — thrown away
 * except for the array's length.
 */
export async function countWatchedSources(db: Database = defaultDb()): Promise<number> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(watchedSources);
  return row?.total ?? 0;
}

export async function listWatchedSources(
  db: Database = defaultDb(),
): Promise<WatchedSourceSummary[]> {
  const rows = await db.select().from(watchedSources).orderBy(desc(watchedSources.createdAt));
  if (rows.length === 0) return [];

  const counts = await db
    .select({
      sourceId: watchedSourceItems.sourceId,
      status: watchedSourceItems.status,
      count: sql<number>`count(*)::int`,
    })
    .from(watchedSourceItems)
    .where(
      inArray(
        watchedSourceItems.sourceId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(watchedSourceItems.sourceId, watchedSourceItems.status);

  return rows.map((source) => {
    const mine = counts.filter((row) => row.sourceId === source.id);
    const of = (status: WatchedItemStatus): number =>
      mine.find((row) => row.status === status)?.count ?? 0;
    return {
      source,
      total: mine.reduce((sum, row) => sum + row.count, 0),
      imported: of("imported"),
      pending: of("new"),
      skipped: of("skipped") + of("ignored"),
    };
  });
}

/**
 * The import a reported video turned into, as the two things anyone reads off it.
 *
 * The join used to drag the whole `imports` row per item — `options` and `error` jsonb
 * included — and the page, `/api/v1` and MCP between them read `id` and `status`.
 */
export interface WatchedItemJob {
  readonly id: string;
  readonly status: ImportStatus;
}

export interface WatchedSourceDetail extends WatchedSourceSummary {
  /** One page of what this source has reported, newest first. */
  readonly items: readonly (WatchedSourceItem & { readonly job: WatchedItemJob | null })[];
}

export interface WatchedSourcePage {
  /** Cap the items. Omitted means every one of them — `/api/v1` and MCP are not paged. */
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * One watched source, with a page of its history.
 *
 * `total`, `imported`, `pending` and `skipped` describe the **whole** history and come out of
 * one grouped aggregate, so they stay right whatever page is asked for. They used to be
 * `items.filter(...).length` over every row the source had ever reported — a channel watched
 * for a year is thousands of rows read to print one sentence, and the page rendered all of
 * them into a table nobody scrolls to the end of.
 */
export async function getWatchedSource(
  id: string,
  db: Database = defaultDb(),
  page: WatchedSourcePage = {},
): Promise<WatchedSourceDetail | null> {
  const [source] = await db.select().from(watchedSources).where(eq(watchedSources.id, id)).limit(1);
  if (source === undefined) return null;

  const rowsQuery = db
    .select({
      item: watchedSourceItems,
      job: { id: imports.id, status: imports.status },
    })
    .from(watchedSourceItems)
    .leftJoin(imports, eq(watchedSourceItems.importId, imports.id))
    .where(eq(watchedSourceItems.sourceId, id))
    .orderBy(desc(watchedSourceItems.firstSeenAt));

  const [rows, counts] = await Promise.all([
    page.limit === undefined ? rowsQuery : rowsQuery.limit(page.limit).offset(page.offset ?? 0),
    db
      .select({ status: watchedSourceItems.status, count: sql<number>`count(*)::int` })
      .from(watchedSourceItems)
      .where(eq(watchedSourceItems.sourceId, id))
      .groupBy(watchedSourceItems.status),
  ]);

  const of = (status: WatchedItemStatus): number =>
    counts.find((row) => row.status === status)?.count ?? 0;

  return {
    source,
    items: rows.map((row) => ({ ...row.item, job: row.job })),
    total: counts.reduce((sum, row) => sum + row.count, 0),
    imported: of("imported"),
    pending: of("new"),
    skipped: of("skipped") + of("ignored"),
  };
}

/** Read one source, or say so in the shape every other failure in this app has. */
export async function requireWatchedSource(
  id: string,
  db: Database = defaultDb(),
): Promise<WatchedSource> {
  const [row] = await db.select().from(watchedSources).where(eq(watchedSources.id, id)).limit(1);
  if (row === undefined) {
    throw new MMError("NOT_FOUND", `No watched source with id ${id}.`, {
      hint: "`mm watch list` shows them.",
      action: "List sources",
    });
  }
  return row;
}

export async function createWatchedSource(
  input: WatchedSourceInput,
  options: { db?: Database; settings?: Settings } = {},
): Promise<WatchedSource> {
  const db = options.db ?? defaultDb();
  const parsed = watchedSourceInputSchema.parse(input);
  const settings = options.settings ?? (await loadSettings(db));

  const [existing] = await db
    .select()
    .from(watchedSources)
    .where(eq(watchedSources.url, parsed.url))
    .limit(1);
  if (existing !== undefined) {
    throw new MMError("INVALID_INPUT", "That URL is already watched.", {
      hint: "One source per URL — open the existing one instead of adding a second.",
      action: "Open it",
      details: { sourceId: existing.id },
      status: 400,
    });
  }

  if (
    parsed.minDuration != null &&
    parsed.maxDuration != null &&
    parsed.minDuration > parsed.maxDuration
  ) {
    throw new MMError("INVALID_INPUT", "The minimum duration is longer than the maximum.");
  }

  const [created] = await db
    .insert(watchedSources)
    .values({
      id: newId("watchedSource"),
      url: parsed.url,
      kind: parsed.kind ?? classifyWatchedUrl(parsed.url),
      label: parsed.label ?? "",
      enabled: parsed.enabled ?? true,
      autoAccept: parsed.autoAccept ?? settings.watchedSourcesAutoAcceptDefault,
      autoAcceptThreshold: parsed.autoAcceptThreshold ?? null,
      minDuration: parsed.minDuration ?? null,
      maxDuration: parsed.maxDuration ?? null,
      requireProvidedToYouTube: parsed.requireProvidedToYouTube ?? false,
    })
    .returning();
  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the watched source.");
  return created;
}

export async function updateWatchedSource(
  id: string,
  patch: WatchedSourcePatch,
  db: Database = defaultDb(),
): Promise<WatchedSource> {
  const parsed = watchedSourcePatchSchema.parse(patch);
  await requireWatchedSource(id, db);
  const [updated] = await db
    .update(watchedSources)
    .set({
      ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
      ...(parsed.label === undefined ? {} : { label: parsed.label }),
      ...(parsed.enabled === undefined ? {} : { enabled: parsed.enabled }),
      ...(parsed.autoAccept === undefined ? {} : { autoAccept: parsed.autoAccept }),
      ...(parsed.autoAcceptThreshold === undefined
        ? {}
        : { autoAcceptThreshold: parsed.autoAcceptThreshold }),
      ...(parsed.minDuration === undefined ? {} : { minDuration: parsed.minDuration }),
      ...(parsed.maxDuration === undefined ? {} : { maxDuration: parsed.maxDuration }),
      ...(parsed.requireProvidedToYouTube === undefined
        ? {}
        : { requireProvidedToYouTube: parsed.requireProvidedToYouTube }),
      updatedAt: new Date(),
    })
    .where(eq(watchedSources.id, id))
    .returning();
  if (updated === undefined) throw new MMError("UNKNOWN", "Could not update the watched source.");
  return updated;
}

/**
 * Forget a source.
 *
 * Its items go with it (`on delete cascade`) and the imports it opened **stay**: they are
 * ordinary imports, half of them are already in the library, and deleting somebody's music
 * because they stopped watching a channel would be an astonishing thing to do.
 */
export async function deleteWatchedSource(id: string, db: Database = defaultDb()): Promise<void> {
  await requireWatchedSource(id, db);
  await db.delete(watchedSources).where(eq(watchedSources.id, id));
}

/* ------------------------------------------------------------------ */
/* the filters                                                         */
/* ------------------------------------------------------------------ */

/**
 * Words that name something other than a record.
 *
 * A channel is not a discography: it carries interviews, trailers, live streams and tour
 * announcements alongside the music. This list is deliberately short and deliberately about
 * the *form* — "live" is absent, because a live album is a record and the list must not decide
 * what kind of music you are allowed to keep.
 */
const NOT_MUSIC = [
  "interview",
  "podcast",
  "trailer",
  "teaser",
  "behind the scenes",
  "making of",
  "reaction",
  "tutorial",
  "vlog",
  "livestream",
  "live stream",
  "announcement",
  "#shorts",
  "q&a",
] as const;

export interface FilterVerdict {
  readonly accept: boolean;
  readonly reason: string;
}

/**
 * Should this video become an import?
 *
 * Pure, and exported, because "why was this skipped?" is a question the Console asks of a row
 * that was written days ago — the answer has to be a sentence stored next to it, not a branch
 * somebody re-reads.
 */
export function verdictFor(entry: ExtractEntry, source: WatchedSource): FilterVerdict {
  if (entry.unavailable === true) {
    return { accept: false, reason: `Unavailable on YouTube (${entry.availability ?? "private"})` };
  }
  const title = entry.title.toLowerCase();
  const word = NOT_MUSIC.find((needle) => title.includes(needle));
  if (word !== undefined) {
    return { accept: false, reason: `The title says “${word}”, which is not a record` };
  }
  const duration = entry.duration;
  if (duration !== null && duration !== undefined) {
    if (source.minDuration !== null && duration < source.minDuration) {
      return {
        accept: false,
        reason: `${String(Math.round(duration))}s, under the ${String(source.minDuration)}s floor`,
      };
    }
    if (source.maxDuration !== null && duration > source.maxDuration) {
      return {
        accept: false,
        reason: `${String(Math.round(duration))}s, over the ${String(source.maxDuration)}s ceiling`,
      };
    }
  }
  return { accept: true, reason: "" };
}

/** The URL one entry of a listing is imported from. Mirrors `resolve`'s `entryUrl`. */
export function entryImportUrl(entry: ExtractEntry): string | null {
  const url = entry.webpage_url;
  if (typeof url === "string" && url.trim() !== "") return url;
  return entry.id === "" ? null : `https://www.youtube.com/watch?v=${entry.id}`;
}

/* ------------------------------------------------------------------ */
/* the scan                                                            */
/* ------------------------------------------------------------------ */

export interface ScanReport {
  readonly sourceId: string;
  readonly status: "ok" | "partial" | "failed";
  /** Entries the listing came back with, unavailable ones included. */
  readonly listed: number;
  /** Entries this source had never seen before. */
  readonly discovered: number;
  readonly imported: number;
  readonly skipped: number;
  readonly importIds: readonly string[];
  readonly error: StoredError | null;
  readonly durationMs: number;
}

export interface ScanOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly signal?: AbortSignal;
  /**
   * Put each new import on the queue. Absent means "do not" — which is what the unit tests
   * and a dry `mm watch scan` want, and what stops this module importing pg-boss.
   */
  readonly enqueue?: (importId: string) => Promise<void>;
}

/**
 * The admission rules, asked of one new video before an import is opened for it.
 *
 * It costs **one full extraction** — a flat listing carries no description and no album tag —
 * which is why it only runs when a rule actually needs it, and why the per-source switch
 * exists at all. `null` means "no rule applies here", and no extraction was made.
 *
 * The scan asks this itself rather than letting `resolve` refuse the import a moment later,
 * even though `resolve` would refuse it correctly: a scan that found forty videos it is not
 * allowed to import would leave forty failed jobs in the list. One skipped row with a sentence
 * on it is the answer the Console already knows how to show.
 *
 * The detection underneath is `isOfficialUpload`, shared with the `officialUploadsOnly`
 * setting and with the description parser under both. It used to be a second, case-*sensitive*
 * `.includes` written here — the same question asked twice, with one of the two answers wrong
 * the day YouTube changed its capitalisation.
 */
async function admitVideo(
  toolbox: ToolboxClient,
  url: string,
  settings: Settings,
  source: WatchedSource,
): Promise<AdmissionVerdict | null> {
  const global = sourceRulesOf(settings);
  const rules: SourceRules = {
    // The per-source switch is an *addition* to the installation-wide one, never a way out of
    // it: a source may demand more than the settings do, not less.
    officialUploadsOnly: global.officialUploadsOnly || source.requireProvidedToYouTube,
    requireAlbum: global.requireAlbum,
  };
  if (!rules.officialUploadsOnly && !rules.requireAlbum) return null;

  const full = await toolbox.extract(url, cookieJar(settings));
  const entry = full.entries[0];
  if (entry === undefined) return null;
  // A watched source opens one import per video (see the header), so every one of them is the
  // isolated video `requireAlbum` is about.
  return admit(entry, rules, { isolated: true });
}

/**
 * Scan one source: list it, diff it, import what is new.
 *
 * Never throws for a reason the operator can read off the row instead. A source whose URL has
 * gone 404 records `failed` with the error and lets the run carry on to the next source — one
 * dead playlist must not be the reason the other nine stop being watched.
 */
export async function scanSource(id: string, options: ScanOptions = {}): Promise<ScanReport> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const toolbox = options.toolbox ?? defaultToolbox();
  const started = Date.now();
  const source = await requireWatchedSource(id, db);

  const fail = async (error: unknown): Promise<ScanReport> => {
    const body = MMError.from(error).toBody();
    await db
      .update(watchedSources)
      .set({
        lastScanAt: new Date(),
        lastScanStatus: "failed",
        lastError: body,
        updatedAt: new Date(),
      })
      .where(eq(watchedSources.id, id));
    return {
      sourceId: id,
      status: "failed",
      listed: 0,
      discovered: 0,
      imported: 0,
      skipped: 0,
      importIds: [],
      error: body,
      durationMs: Date.now() - started,
    };
  };

  let listing;
  try {
    listing = await toolbox.extract(source.url, cookieJar(settings), { flat: true });
  } catch (error) {
    return await fail(error);
  }

  const seen = await db
    .select({ videoId: watchedSourceItems.videoId })
    .from(watchedSourceItems)
    .where(eq(watchedSourceItems.sourceId, id));
  const known = new Set(seen.map((row) => row.videoId));

  const importIds: string[] = [];
  let discovered = 0;
  let imported = 0;
  let skipped = 0;
  let partial = false;

  for (const entry of listing.entries) {
    if (options.signal?.aborted === true) {
      partial = true;
      break;
    }
    if (entry.id === "" || known.has(entry.id)) continue;

    /*
     * The row is written **before** the import, and the unique index is what makes that safe.
     * `onConflictDoNothing` returning nothing means another scan got here first, so this one
     * walks away rather than opening a second import of the same video — which is the exact
     * failure a `select` followed by an `insert` cannot rule out.
     */
    const [claimed] = await db
      .insert(watchedSourceItems)
      .values({
        id: newId("watchedSourceItem"),
        sourceId: id,
        videoId: entry.id,
        title: entry.title,
        status: "new",
      })
      .onConflictDoNothing({
        target: [watchedSourceItems.sourceId, watchedSourceItems.videoId],
      })
      .returning();
    if (claimed === undefined) continue;

    known.add(entry.id);
    discovered += 1;

    const verdict = verdictFor(entry, source);
    const url = entryImportUrl(entry);
    if (!verdict.accept || url === null) {
      await db
        .update(watchedSourceItems)
        .set({
          status: "skipped",
          reason: url === null ? "No URL to import it from" : verdict.reason,
          updatedAt: new Date(),
        })
        .where(eq(watchedSourceItems.id, claimed.id));
      skipped += 1;
      continue;
    }

    try {
      const admission = await admitVideo(toolbox, url, settings, source);
      if (admission !== null && !admission.accept) {
        await db
          .update(watchedSourceItems)
          .set({ status: "skipped", reason: admission.reason, updatedAt: new Date() })
          .where(eq(watchedSourceItems.id, claimed.id));
        skipped += 1;
        continue;
      }

      const created = await createImport(url, {
        db,
        priority: WATCHED_IMPORT_PRIORITY,
        watchedSourceId: id,
        sourceAutoAccept: source.autoAccept,
        ...(source.autoAcceptThreshold === null
          ? {}
          : { sourceAutoAcceptThreshold: source.autoAcceptThreshold }),
        // Named here rather than inferred in `confirm`: whatever the gate decides, the
        // `decisions` row it writes has to say who opened it (`assertSigned`'s rule).
        confirmedBy: "watched-source",
      });

      await db
        .update(watchedSourceItems)
        .set({ status: "imported", importId: created.job.id, reason: null, updatedAt: new Date() })
        .where(eq(watchedSourceItems.id, claimed.id));
      importIds.push(created.job.id);
      imported += 1;
      if (options.enqueue !== undefined) await options.enqueue(created.job.id);
    } catch (error) {
      // One video that cannot be resolved is one row with a reason on it, not a failed scan.
      partial = true;
      await db
        .update(watchedSourceItems)
        .set({ status: "skipped", reason: MMError.from(error).message, updatedAt: new Date() })
        .where(eq(watchedSourceItems.id, claimed.id));
      skipped += 1;
    }
  }

  const label =
    source.label === "" && typeof listing.title === "string" && listing.title.trim() !== ""
      ? listing.title.trim()
      : source.label;

  await db
    .update(watchedSources)
    .set({
      label,
      lastScanAt: new Date(),
      lastScanStatus: partial ? "partial" : "ok",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(watchedSources.id, id));

  return {
    sourceId: id,
    status: partial ? "partial" : "ok",
    listed: listing.entries.length,
    discovered,
    imported,
    skipped,
    importIds,
    error: null,
    durationMs: Date.now() - started,
  };
}

/** Every source a scheduled run should visit, in a stable order. */
export async function enabledSources(db: Database = defaultDb()): Promise<WatchedSource[]> {
  return await db
    .select()
    .from(watchedSources)
    .where(eq(watchedSources.enabled, true))
    .orderBy(watchedSources.createdAt);
}
