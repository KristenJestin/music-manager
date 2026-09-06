/**
 * `discover.service` — the orchestration, the memory, and the page's payload.
 *
 * `signals`, `discography` and `recommendations` each answer one question and know nothing
 * about the database. This module is what turns their three answers into rows, and rows into
 * the three blocks of `/discover`.
 *
 * ## What a sync does to the table
 *
 * Upsert what is proposed, then delete what this run did *not* propose — except anything the
 * user has acted on. That is the whole reconciliation, and the two exceptions are the
 * interesting part:
 *
 *  - an item marked **`imported`** is kept, so the page can still say "you queued this" instead
 *    of quietly forgetting;
 *  - an item's **status is never overwritten** by an upsert. A sync refreshes the score, the
 *    reason and the `inLibrary` flag; it does not undo a decision.
 *
 * "Not interested" is not a status at all: it lives in `discover_dismissals`, is read *before*
 * the services run, and is passed down to them so a dismissed subject is never even computed.
 * That is what makes the acceptance criterion — "it does not come back after `sync`" — a
 * property of the data rather than of the order two functions happen to run in.
 *
 * ## Why `album_incomplete` is raised here
 *
 * The Inbox type has existed since P03 and nothing ever opened one. It belongs to this phase:
 * an album whose `present_count` is below its `track_count` is a discography gap of the most
 * literal kind — a record you own *part* of — and Discover is the page whose job is to turn
 * that into an import. The item is keyed on the album, so a scan that later completes the
 * album closes it.
 */
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  discoverDismissals,
  discoverItems,
  discoverSyncs,
  libraryAlbums,
  type DiscoverItem,
  type DiscoverKind,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { serverEnv } from "#/server/env.ts";
import type { SourceContext } from "#/server/integrations/config.ts";
import type { NavidromeClient } from "#/server/integrations/navidrome/client.ts";
import { sourceContextFor } from "#/server/services/matching.context.ts";
import {
  closeLibraryItem,
  openLibraryItem,
  openLibraryItems,
} from "#/server/services/library-inbox.ts";
import { navidromeConfig, navidromeClient } from "#/server/services/navidrome.ts";
import { discographyGaps, gapReason, type DiscographyGap } from "#/server/services/discography.ts";
import { collectRecommendations } from "#/server/services/recommendations.ts";
import { collectSignals, sourceStrip, type ListeningSignals } from "#/server/services/signals.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* the view                                                            */
/* ------------------------------------------------------------------ */

/** One row of the "Complete your discography" block: an artist and their holes. */
export interface DiscographyCard {
  readonly artist: string;
  readonly artistMbid: string | null;
  readonly have: number;
  readonly total: number;
  readonly plays: number;
  readonly missing: readonly DiscoverItemView[];
}

export interface DiscoverItemView {
  readonly id: string;
  readonly kind: DiscoverKind;
  readonly status: DiscoverItem["status"];
  readonly subject: string;
  readonly title: string;
  readonly artist: string;
  readonly albumTitle: string | null;
  readonly artistMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly recordingMbid: string | null;
  readonly year: number | null;
  readonly primaryType: string | null;
  readonly secondaryTypes: readonly string[];
  readonly score: number;
  readonly reason: string;
  readonly source: string;
  readonly inLibrary: boolean;
  /** `similarTo`, `have`/`total`, the score factors — whatever the block needs. */
  readonly payload: Record<string, unknown>;
}

export interface DiscoverLinkedInboxItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string | null;
  readonly albumId: string | null;
}

export interface DiscoverView {
  readonly signals: ListeningSignals;
  readonly lastSync: {
    readonly id: string;
    readonly at: string;
    readonly status: string;
    readonly durationMs: number | null;
    readonly error: string | null;
  } | null;
  readonly discography: readonly DiscographyCard[];
  readonly recommendations: readonly DiscoverItemView[];
  readonly similarArtists: readonly DiscoverItemView[];
  readonly inbox: readonly DiscoverLinkedInboxItem[];
  readonly dismissedCount: number;
  readonly enabled: boolean;
}

function toView(row: DiscoverItem): DiscoverItemView {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    subject: row.subject,
    title: row.title,
    artist: row.artist,
    albumTitle: row.albumTitle,
    artistMbid: row.artistMbid,
    releaseGroupMbid: row.releaseGroupMbid,
    recordingMbid: row.recordingMbid,
    year: row.year,
    primaryType: row.primaryType,
    secondaryTypes: row.secondaryTypes,
    score: row.score,
    reason: row.reason,
    source: row.source,
    inLibrary: row.inLibrary,
    payload: row.payload,
  };
}

/**
 * Everything `/discover` renders, in one read.
 *
 * The signals come out of the **last sync's snapshot** rather than being recomputed: they are
 * an observation of a moment, the page says which moment, and re-reading Navidrome on every
 * page load would make "last sync 4 minutes ago" a lie.
 */
export async function discoverView(
  options: { db?: Database; settings?: Settings } = {},
): Promise<DiscoverView> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));

  const [last] = await db
    .select()
    .from(discoverSyncs)
    .orderBy(desc(discoverSyncs.startedAt))
    .limit(1);
  const rows = await db.select().from(discoverItems).orderBy(desc(discoverItems.score));

  const gaps = rows.filter((row) => row.kind === "discography");
  const byArtist = new Map<string, DiscographyCard & { missing: DiscoverItemView[] }>();
  for (const row of gaps) {
    const key = row.artistMbid ?? row.artist.toLowerCase();
    const card = byArtist.get(key) ?? {
      artist: row.artist,
      artistMbid: row.artistMbid,
      have: Number(row.payload["have"] ?? 0),
      total: Number(row.payload["total"] ?? 0),
      plays: Number(row.payload["plays"] ?? 0),
      missing: [] as DiscoverItemView[],
    };
    card.missing.push(toView(row));
    byArtist.set(key, card);
  }

  const inbox = await openLibraryItems("album_incomplete", db);
  const dismissed = await db.select({ count: sql<number>`count(*)::int` }).from(discoverDismissals);

  const signals: ListeningSignals =
    (last?.signals as ListeningSignals | null | undefined) ??
    ({
      observedAt: new Date(0).toISOString(),
      windowDays: settings.discoverWindowDays,
      totalPlays: 0,
      sources: sourceStrip(settings, { navidrome: "off", metric: "never synced" }),
      topArtists: [],
      topGenres: [],
      error: null,
    } satisfies ListeningSignals);

  return {
    signals,
    lastSync:
      last === undefined
        ? null
        : {
            id: last.id,
            at: (last.finishedAt ?? last.startedAt).toISOString(),
            status: last.status,
            durationMs: last.durationMs,
            error: last.error,
          },
    discography: [...byArtist.values()].sort((a, b) => b.plays - a.plays),
    recommendations: rows.filter((row) => row.kind === "recommendation").map(toView),
    similarArtists: rows.filter((row) => row.kind === "similar_artist").map(toView),
    inbox: inbox.map((item) => ({
      id: item.id,
      title: item.title,
      summary: item.summary,
      albumId: typeof item.payload["albumId"] === "string" ? item.payload["albumId"] : null,
    })),
    dismissedCount: dismissed[0]?.count ?? 0,
    enabled: settings.discoverEnabled,
  };
}

/* ------------------------------------------------------------------ */
/* the memory                                                          */
/* ------------------------------------------------------------------ */

export async function dismissedSubjects(db: Database = defaultDb()): Promise<ReadonlySet<string>> {
  const rows = await db.select({ subject: discoverDismissals.subject }).from(discoverDismissals);
  return new Set(rows.map((row) => row.subject));
}

/**
 * "Not interested": remember it, and drop the row.
 *
 * Both, in that order. Remembering alone would leave it on screen until the next sync;
 * deleting alone would bring it back on the next one.
 */
export async function notInterested(itemId: string, db: Database = defaultDb()): Promise<void> {
  const [row] = await db.select().from(discoverItems).where(eq(discoverItems.id, itemId)).limit(1);
  if (row === undefined)
    throw new MMError("NOT_FOUND", `No Discover item with id ${itemId}.`, { status: 404 });
  await db
    .insert(discoverDismissals)
    .values({
      subject: row.subject,
      kind: row.kind,
      label: `${row.artist} — ${row.title}`,
    })
    .onConflictDoNothing();
  await db.delete(discoverItems).where(eq(discoverItems.id, itemId));
}

/** "Later": keep proposing it, at the bottom. A status, not a memory — see the module note. */
export async function later(itemId: string, db: Database = defaultDb()): Promise<void> {
  const updated = await db
    .update(discoverItems)
    .set({ status: "later", updatedAt: new Date() })
    .where(eq(discoverItems.id, itemId))
    .returning({ id: discoverItems.id });
  if (updated.length === 0) {
    throw new MMError("NOT_FOUND", `No Discover item with id ${itemId}.`, { status: 404 });
  }
}

/** Undo every "not interested". The only way back, and it is one button in the UI. */
export async function forgetDismissals(db: Database = defaultDb()): Promise<number> {
  const removed = await db
    .delete(discoverDismissals)
    .returning({ subject: discoverDismissals.subject });
  return removed.length;
}

export async function markImported(
  itemId: string,
  importId: string,
  db: Database = defaultDb(),
): Promise<void> {
  await db
    .update(discoverItems)
    .set({
      status: "imported",
      payload: sql`${discoverItems.payload} || ${JSON.stringify({ importId })}::jsonb`,
      updatedAt: new Date(),
    })
    .where(eq(discoverItems.id, itemId));
}

export async function getItem(
  itemId: string,
  db: Database = defaultDb(),
): Promise<DiscoverItem | null> {
  const [row] = await db.select().from(discoverItems).where(eq(discoverItems.id, itemId)).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* the sync                                                            */
/* ------------------------------------------------------------------ */

export interface SyncOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly ctx?: SourceContext;
  readonly trigger?: string;
  readonly signal?: AbortSignal;
  readonly navidrome?: NavidromeClient;
  readonly now?: Date;
}

export interface SyncReport {
  readonly id: string;
  readonly status: "done" | "failed" | "skipped";
  readonly durationMs: number;
  readonly discography: number;
  readonly recommendations: number;
  readonly similarArtists: number;
  readonly incompleteAlbums: number;
  readonly playlist: { pushed: number; skipped: number; error: string | null } | null;
  readonly error: string | null;
  /**
   * Why the numbers above are what they are, when they are zero.
   *
   * A sync that answers `{status: "done", discography: 0, recommendations: 0, error: null}` is
   * indistinguishable from a broken Discover, and the second MCP test report reached exactly
   * that conclusion. Every reason is knowable — no ListenBrainz user, no Navidrome, nothing
   * played in the window — and each one is a sentence here rather than a silence.
   */
  readonly notes: readonly string[];
}

/**
 * Say why a Discover pass found nothing.
 *
 * Pure and exported: the same sentences answer "why is this sync empty?" (`discover_sync`) and
 * "why is this list empty?" (`list_discover`), and two explanations that could disagree would
 * be worse than one.
 */
export function explainDiscover(input: {
  readonly settings: Pick<
    Settings,
    "discoverEnabled" | "navidromeUrl" | "listenbrainzUser" | "lastfmKey" | "discoverWindowDays"
  >;
  readonly totalPlays: number;
  readonly topArtists: number;
  readonly signalsError: string | null;
  readonly found: number;
}): string[] {
  const notes: string[] = [];
  if (!input.settings.discoverEnabled) {
    notes.push("Discover is switched off (`discoverEnabled`). Nothing is computed.");
    return notes;
  }
  if (input.signalsError !== null) {
    notes.push(`Listening signals could not be read: ${input.signalsError}`);
  }
  if (input.settings.navidromeUrl.trim() === "") {
    notes.push(
      "No Navidrome server is configured (`navidromeUrl`), so there is no play history to " +
        "learn from — discography gaps are ranked by what you actually listen to.",
    );
  } else if (input.totalPlays === 0) {
    notes.push(
      `Navidrome reported no plays in the last ${String(input.settings.discoverWindowDays)} day(s), ` +
        "so there are no top artists to look for gaps around.",
    );
  } else if (input.topArtists === 0) {
    notes.push("No artist cleared the play threshold in the window.");
  }
  if (input.settings.listenbrainzUser.trim() === "") {
    notes.push(
      "No ListenBrainz user is configured (`listenbrainzUser`), so the recommendation block " +
        "has no source.",
    );
  }
  if (input.settings.lastfmKey.trim() === "" && process.env.MM_LASTFM_KEY === undefined) {
    notes.push(
      "No Last.fm key is configured (`lastfmKey` or `MM_LASTFM_KEY`), so similar artists " +
        "cannot be fetched.",
    );
  }
  if (notes.length === 0 && input.found === 0) {
    notes.push(
      "Every source answered and proposed nothing new — the library already covers what they " +
        "suggest, or the proposals were dismissed.",
    );
  }
  return notes;
}

/** One row to insert, built from whichever service produced it. */
type Proposal = Omit<typeof discoverItems.$inferInsert, "id" | "syncId">;

export async function syncDiscover(options: SyncOptions = {}): Promise<SyncReport> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const started = options.now ?? new Date();
  const syncId = newId("discoverSync");

  await db.insert(discoverSyncs).values({
    id: syncId,
    trigger: options.trigger ?? "manual",
    status: "running",
    startedAt: started,
  });

  const finish = async (report: Omit<SyncReport, "id">): Promise<SyncReport> => {
    await db
      .update(discoverSyncs)
      .set({
        status: report.status,
        finishedAt: new Date(),
        durationMs: report.durationMs,
        discographyCount: report.discography,
        recommendationCount: report.recommendations,
        similarArtistCount: report.similarArtists,
        error: report.error,
      })
      .where(eq(discoverSyncs.id, syncId));
    return { id: syncId, ...report };
  };

  if (!settings.discoverEnabled) {
    return await finish({
      status: "skipped",
      durationMs: 0,
      discography: 0,
      recommendations: 0,
      similarArtists: 0,
      incompleteAlbums: 0,
      playlist: null,
      error: "Discover is switched off in the settings.",
      notes: explainDiscover({
        settings,
        totalPlays: 0,
        topArtists: 0,
        signalsError: null,
        found: 0,
      }),
    });
  }

  try {
    /*
     * Fixtures mode is offline, and that is enforced here rather than hoped for.
     *
     * `sourceContextFor` is the matcher's factory and sets `offline: false`, which is right for
     * it: outside fixtures the matcher may reach MusicBrainz. Discover under `MM_FIXTURES=1`
     * must not open a socket at all — `CLAUDE.md` says fixtures mode stays fully offline
     * because it is what the E2E and the demo run on — so the flag is overridden, and a key
     * that was never seeded becomes a clean `OFFLINE_CACHE_MISS` instead of a live request.
     */
    const ctx = options.ctx ?? {
      ...(await sourceContextFor(db, options.signal)),
      offline: serverEnv().MM_FIXTURES,
    };
    const dismissed = await dismissedSubjects(db);

    const signals = await collectSignals({
      db,
      settings,
      now: started,
      ...(options.navidrome === undefined ? {} : { client: options.navidrome }),
    });

    const gaps = await discographyGaps({
      ctx,
      settings,
      db,
      artists: signals.topArtists,
      dismissed,
    });
    const recommended = await collectRecommendations({ ctx, settings, db, signals, dismissed });

    const proposals: Proposal[] = [
      ...gaps.flatMap((gap) => gapProposals(gap, signals.windowDays)),
      ...recommended.items.map<Proposal>((item) => ({
        kind: "recommendation",
        subject: item.subject,
        title: item.title,
        artist: item.artist,
        albumTitle: item.albumTitle,
        artistMbid: item.artistMbid,
        releaseGroupMbid: item.releaseGroupMbid,
        recordingMbid: item.recordingMbid,
        year: item.year,
        primaryType: item.kind === "album" ? "Album" : null,
        secondaryTypes: [],
        score: item.score,
        reason: item.reason,
        source: item.source,
        inLibrary: item.inLibrary,
        payload: { itemKind: item.kind, factors: item.factors },
      })),
      ...recommended.similar.map<Proposal>((artist) => ({
        kind: "similar_artist",
        subject: artist.subject,
        title: artist.name,
        artist: artist.name,
        albumTitle: null,
        artistMbid: artist.artistMbid,
        releaseGroupMbid: null,
        recordingMbid: null,
        year: null,
        primaryType: null,
        secondaryTypes: [],
        score: artist.score,
        reason: `similar to ${artist.similarTo}`,
        source: artist.source,
        inLibrary: artist.inLibrary,
        payload: { similarTo: artist.similarTo },
      })),
    ];

    await reconcile(proposals, syncId, db);

    const incomplete = await raiseIncompleteAlbums(db);

    // The signals snapshot carries what the two external sources actually contributed, so the
    // strip can say "62 recommendations" rather than a hopeful "ok".
    const snapshot: ListeningSignals = {
      ...signals,
      sources: sourceStrip(
        settings,
        {
          navidrome: signals.error === null ? "ok" : "error",
          metric:
            signals.error === null
              ? `${signals.totalPlays.toLocaleString("en-GB")} weighted plays`
              : "unreachable",
        },
        recommended.metrics,
      ),
    };
    // The column is a generic `jsonb`; the shape is `ListeningSignals` and `discoverView` reads
    // it back as one. Typing the column would make the schema import a service, which is a
    // cycle, so the assertion lives here — at the one place that writes it.
    await db
      .update(discoverSyncs)
      .set({ signals: snapshot as unknown as Record<string, unknown> })
      .where(eq(discoverSyncs.id, syncId));

    const playlist = settings.discoverPlaylistEnabled
      ? await pushRecommendedPlaylist({
          db,
          settings,
          ...(options.navidrome === undefined ? {} : { client: options.navidrome }),
        })
      : null;

    const discography = proposals.filter((one) => one.kind === "discography").length;
    return await finish({
      status: "done",
      durationMs: Date.now() - started.getTime(),
      discography,
      recommendations: recommended.items.length,
      similarArtists: recommended.similar.length,
      incompleteAlbums: incomplete,
      playlist,
      error: signals.error,
      notes: explainDiscover({
        settings,
        totalPlays: signals.totalPlays,
        topArtists: signals.topArtists.length,
        signalsError: signals.error,
        found: discography + recommended.items.length + recommended.similar.length,
      }),
    });
  } catch (error) {
    return await finish({
      status: "failed",
      durationMs: Date.now() - started.getTime(),
      discography: 0,
      recommendations: 0,
      similarArtists: 0,
      incompleteAlbums: 0,
      playlist: null,
      error: MMError.from(error).message,
      notes: [],
    });
  }
}

function gapProposals(gap: DiscographyGap, windowDays: number): Proposal[] {
  const reason = gapReason(gap, windowDays);
  return gap.missing.map<Proposal>((missing) => ({
    kind: "discography",
    subject: `release-group:${missing.rgMbid}`,
    title: missing.title,
    artist: gap.artist,
    albumTitle: missing.title,
    artistMbid: gap.artistMbid,
    releaseGroupMbid: missing.rgMbid,
    recordingMbid: null,
    year: missing.year,
    primaryType: missing.primaryType,
    secondaryTypes: [...missing.secondaryTypes],
    // The shelf's own completeness, so the fullest shelves float to the top of the block.
    score: gap.total === 0 ? 0 : gap.have / gap.total,
    reason,
    source: "Your library vs MusicBrainz",
    inLibrary: false,
    payload: { have: gap.have, total: gap.total, plays: gap.plays },
  }));
}

/**
 * Write what this run proposes and forget what it does not — without touching decisions.
 *
 * `onConflictDoUpdate` on `(kind, subject)` deliberately omits `status`: a sync refreshes
 * facts, never verdicts.
 */
async function reconcile(
  proposals: readonly Proposal[],
  syncId: string,
  db: Database,
): Promise<void> {
  for (const proposal of proposals) {
    await db
      .insert(discoverItems)
      .values({ ...proposal, id: newId("discoverItem"), syncId })
      .onConflictDoUpdate({
        target: [discoverItems.kind, discoverItems.subject],
        set: {
          title: proposal.title,
          artist: proposal.artist,
          albumTitle: proposal.albumTitle ?? null,
          artistMbid: proposal.artistMbid ?? null,
          releaseGroupMbid: proposal.releaseGroupMbid ?? null,
          recordingMbid: proposal.recordingMbid ?? null,
          year: proposal.year ?? null,
          primaryType: proposal.primaryType ?? null,
          secondaryTypes: proposal.secondaryTypes ?? [],
          score: proposal.score ?? 0,
          reason: proposal.reason,
          source: proposal.source,
          inLibrary: proposal.inLibrary ?? false,
          payload: proposal.payload ?? {},
          syncId,
          updatedAt: new Date(),
        },
      });
  }

  /*
   * Anything this run did not propose is gone — with two deliberate exceptions.
   *
   * `status <> 'imported'` keeps what you have already acted on, so the page can still say
   * "you queued this" instead of quietly forgetting.
   *
   * `sync_id is not null` keeps what a *person* asked for: "Add discography" on a similar
   * artist inserts rows no sync produced, and they are meant to survive until they are
   * imported or dismissed. Spelling it out matters — `ne(sync_id, …)` is already false for a
   * NULL in SQL, so the rows would survive either way, but by accident rather than on purpose,
   * and the next reader would have to rediscover three-valued logic to know which it was.
   */
  await db
    .delete(discoverItems)
    .where(
      and(
        isNotNull(discoverItems.syncId),
        ne(discoverItems.syncId, syncId),
        ne(discoverItems.status, "imported"),
      ),
    );
}

/**
 * Open an `album_incomplete` Inbox item per album that is missing files, close the ones that
 * are now whole. The first code in the repository to raise this type; see the module note.
 */
export async function raiseIncompleteAlbums(db: Database = defaultDb()): Promise<number> {
  const albums = await db
    .select({
      id: libraryAlbums.id,
      title: libraryAlbums.title,
      artist: libraryAlbums.albumArtist,
      trackCount: libraryAlbums.trackCount,
      presentCount: libraryAlbums.presentCount,
    })
    .from(libraryAlbums)
    .where(
      and(
        lt(libraryAlbums.presentCount, libraryAlbums.trackCount),
        ne(libraryAlbums.trackCount, 0),
      ),
    );

  const wanted = new Set<string>();
  for (const album of albums) {
    const subject = `album:${album.id}`;
    wanted.add(subject);
    const missing = album.trackCount - album.presentCount;
    await openLibraryItem(
      {
        type: "album_incomplete",
        subject,
        title: `${album.artist} — ${album.title} is missing ${String(missing)} track(s)`,
        summary: `${String(album.presentCount)} of ${String(album.trackCount)} tracks are on disk. Discover can re-import the rest.`,
        payload: {
          albumId: album.id,
          present: album.presentCount,
          total: album.trackCount,
          missing,
        },
      },
      db,
    );
  }

  // Close the ones that have since been completed — an Inbox that never empties is noise.
  for (const open of await openLibraryItems("album_incomplete", db)) {
    const subject = typeof open.payload["subject"] === "string" ? open.payload["subject"] : "";
    if (subject !== "" && !wanted.has(subject))
      await closeLibraryItem("album_incomplete", subject, db);
  }
  return albums.length;
}

/* ------------------------------------------------------------------ */
/* the optional playlist                                               */
/* ------------------------------------------------------------------ */

export interface PlaylistPush {
  readonly pushed: number;
  readonly skipped: number;
  readonly error: string | null;
}

/**
 * Push a "Recommended" playlist to Navidrome — off by default.
 *
 * The honest limitation, stated here because the setting's description cannot be long enough:
 * **Navidrome can only play what Navidrome has.** A recommendation you do not own is not a
 * song on that server, so it cannot be in a playlist there. What this pushes is therefore the
 * *intersection*: recommended tracks that are already in the library, which is what makes the
 * list useful in Feishin ("play me more of what Discover likes") rather than a list of
 * missing files. Everything else is counted as skipped and reported.
 *
 * The list is replaced wholesale rather than appended to, so running the sync twice does not
 * produce a playlist of duplicates.
 */
export async function pushRecommendedPlaylist(options: {
  db?: Database;
  settings?: Settings;
  client?: NavidromeClient;
}): Promise<PlaylistPush> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const config = navidromeConfig(settings);
  if (!config.enabled && options.client === undefined) {
    return { pushed: 0, skipped: 0, error: "No Navidrome server is configured." };
  }
  const client = options.client ?? navidromeClient(settings);

  try {
    const rows = await db
      .select()
      .from(discoverItems)
      .where(and(eq(discoverItems.kind, "recommendation"), eq(discoverItems.inLibrary, true)))
      .orderBy(desc(discoverItems.score));

    const songIds: string[] = [];
    let skipped = 0;
    for (const row of rows) {
      const found = await client.search3(`${row.artist} ${row.title}`, {
        songCount: 1,
        albumCount: 0,
        artistCount: 0,
      });
      const song = found.song?.[0];
      if (song === undefined) {
        skipped += 1;
        continue;
      }
      songIds.push(song.id);
    }

    const name = settings.discoverPlaylistName;
    const existing = (await client.getPlaylists()).find((playlist) => playlist.name === name);
    if (existing === undefined) {
      await client.createPlaylist(name, songIds);
    } else {
      await client.replacePlaylist(existing.id, songIds, existing.songCount ?? 0);
    }
    return { pushed: songIds.length, skipped, error: null };
  } catch (error) {
    return { pushed: 0, skipped: 0, error: MMError.from(error).message };
  }
}

/* ------------------------------------------------------------------ */
/* listing, for the CLI and the API                                    */
/* ------------------------------------------------------------------ */

export interface DiscoverList {
  readonly lastSync: DiscoverView["lastSync"];
  readonly signals: {
    readonly windowDays: number;
    /** Weighted plays observed in the window. Zero is a reason, not a coincidence. */
    readonly totalPlays: number;
    /** Why the signals are empty, when the source could not be read at all. */
    readonly error: string | null;
    readonly topArtists: readonly { name: string; plays: number; mbid: string | null }[];
    readonly topGenres: readonly { name: string; plays: number }[];
  };
  readonly discography: readonly DiscoverItemView[];
  readonly recommendations: readonly DiscoverItemView[];
  readonly similarArtists: readonly DiscoverItemView[];
}

/** The flat shape `mm discover list --json` and `GET /api/v1/discover` both answer. */
export async function discoverList(
  options: { db?: Database; kind?: DiscoverKind; limit?: number } = {},
): Promise<DiscoverList> {
  const db = options.db ?? defaultDb();
  const view = await discoverView({ db });
  const all = await db
    .select()
    .from(discoverItems)
    .where(options.kind === undefined ? sql`true` : eq(discoverItems.kind, options.kind))
    .orderBy(desc(discoverItems.score))
    .limit(options.limit ?? 500);

  return {
    lastSync: view.lastSync,
    signals: {
      windowDays: view.signals.windowDays,
      totalPlays: view.signals.totalPlays,
      error: view.signals.error,
      topArtists: view.signals.topArtists.map((artist) => ({
        name: artist.name,
        plays: artist.plays,
        mbid: artist.mbid,
      })),
      topGenres: view.signals.topGenres.map((genre) => ({ name: genre.name, plays: genre.plays })),
    },
    discography: all.filter((row) => row.kind === "discography").map(toView),
    recommendations: all.filter((row) => row.kind === "recommendation").map(toView),
    similarArtists: all.filter((row) => row.kind === "similar_artist").map(toView),
  };
}

/** Used by the API's `POST /discover/:id/import`; kept here so both callers agree. */
export async function itemsByIds(
  ids: readonly string[],
  db: Database = defaultDb(),
): Promise<DiscoverItem[]> {
  if (ids.length === 0) return [];
  return await db.select().from(discoverItems).where(inArray(discoverItems.id, ids));
}
