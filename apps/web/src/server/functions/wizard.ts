/**
 * The four steps of `/import/new`, as four server functions.
 *
 * The shape of the whole thing follows one decision: **nothing is committed until you press
 * Start.** Step 1 creates the import row, because `resolve` needs somewhere to put fifteen
 * videos and because whoever pasted the URL is watching; steps 2 and 3 compute against those
 * rows and write nothing at all; step 4 writes the answer as a *supplied mapping* — the escape
 * hatch `docs/04` already defines and P03 already tests — and hands the job to the worker.
 *
 * That is why the wizard does not simply run the `match` step and read its output: the step
 * decides, persists and raises Inbox items, and a wizard that did those things before you had
 * chosen anything would be asking you to confirm work it had already done.
 *
 * The one subtlety worth spelling out is `extra_videos`. `match` raises it for videos outside
 * the tracklist; step 3 shows those videos, in a table, before you press Start. Once you have
 * pressed Start, the question has been asked and answered, so the item is resolved here with
 * `decidedBy: "console"` rather than left in the Inbox for you to answer a second time.
 * `uncovered_tracks` is deliberately *not* treated that way: "this release has two tracks your
 * source does not" is a question about the album's completeness, and it belongs in Review.
 */
import { z } from "zod";
import { MMError } from "@mm/contracts";
import {
  albumHints,
  type MappingLine,
  type MatchTrack,
  type RecordingCandidate,
  type ReleaseCandidate,
  type UncoveredTrack,
  type ExtraVideo,
} from "@mm/domain";
import { db } from "#/server/db/client.ts";
import type { Import, ImportKind, ImportTrack } from "#/server/db/schema/index.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { enqueue } from "#/server/services/queue.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { pauseImport, runStep } from "#/server/services/jobs/index.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { duplicatesOf, setImportOptions } from "#/server/services/console.queries.ts";
import { youtubeThumbnail } from "#/server/services/documents.ts";
import {
  hintsFor,
  mappingFor,
  parseMbid,
  pinnedRelease,
  rankFor,
  searchReleases,
  videosOf,
} from "#/server/services/matching.queries.ts";
import { loadSettings } from "#/server/services/settings.ts";

/* ------------------------------------------------------------------ */
/* step 1 — the source                                                 */
/* ------------------------------------------------------------------ */

/** One row of "what yt-dlp sees". */
export interface SourceVideo {
  readonly id: string;
  readonly videoId: string;
  readonly index: number;
  readonly title: string;
  readonly durationSeconds: number | null;
  readonly uploader: string | null;
  readonly ytTrack: string | null;
  /** The best thumbnail yt-dlp reported for this video, or `null` when it kept none. */
  readonly thumbnail: string | null;
}

export interface SourceView {
  readonly importId: string;
  readonly url: string;
  readonly kind: ImportKind;
  readonly title: string | null;
  readonly uploader: string | null;
  readonly videos: readonly SourceVideo[];
  readonly totalSeconds: number;
  /**
   * What the source looks like: the first video's thumbnail.
   *
   * A YouTube-generated release playlist has no picture of its own — every entry carries the
   * same square cover as its frame — so the first one is the album's, and step 1 can show the
   * record rather than a letter on a gradient.
   */
  readonly thumbnail: string | null;
  /** What the YouTube tags and the description agree the album is. */
  readonly hints: {
    readonly album: string | null;
    readonly artist: string | null;
    readonly year: number | null;
    readonly label: string | null;
    readonly releasedOn: string | null;
  };
  /** The first video's auto-generated description, verbatim, for the highlighted panel. */
  readonly description: string | null;
  /** Imports of the same URL that already exist, newest first. */
  readonly duplicates: readonly { id: string; status: string; createdAt: string }[];
}

function toSourceView(
  job: Import,
  rows: readonly ImportTrack[],
  duplicates: readonly Import[],
): SourceView {
  const videos = rows.map((row) => {
    const raw = row.raw;
    const track = raw["track"];
    return {
      id: row.id,
      videoId: row.videoId,
      index: row.position,
      title: row.sourceTitle,
      durationSeconds: row.sourceDuration,
      uploader: row.uploader,
      ytTrack: typeof track === "string" ? track : null,
      thumbnail: youtubeThumbnail(raw as never),
    };
  });
  const matchVideos = rows.map((row) => ({
    id: row.videoId,
    index: row.position,
    title: row.sourceTitle,
    durationSeconds: row.sourceDuration,
    uploader: row.uploader,
    ytTrack: typeof row.raw["track"] === "string" ? (row.raw["track"] as string) : null,
    ytArtist: typeof row.raw["artist"] === "string" ? (row.raw["artist"] as string) : null,
    ytAlbum: typeof row.raw["album"] === "string" ? (row.raw["album"] as string) : null,
    ytReleaseYear:
      typeof row.raw["release_year"] === "number" ? (row.raw["release_year"] as number) : null,
    description:
      typeof row.raw["description"] === "string" ? (row.raw["description"] as string) : null,
  }));
  const hints = albumHints(matchVideos, {
    album: job.title,
    artist: job.artist,
    year: job.year,
  });
  const description = matchVideos.find((video) => video.description !== null)?.description ?? null;

  return {
    importId: job.id,
    url: job.url,
    kind: job.kind,
    title: job.title,
    uploader: job.artist,
    videos,
    totalSeconds: rows.reduce((sum, row) => sum + (row.sourceDuration ?? 0), 0),
    thumbnail: videos.find((video) => video.thumbnail !== null)?.thumbnail ?? null,
    hints: {
      album: hints.album ?? null,
      artist: hints.artist ?? null,
      year: hints.year ?? null,
      label: hints.label ?? null,
      releasedOn: hints.releasedOn ?? null,
    },
    description,
    duplicates: duplicates.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Paste a URL, get a source.
 *
 * `createFromUrl` runs `resolve` in this process — that is P03's deliberate choice and the
 * reason the paste box answers in a second rather than after a worker poll.
 *
 * It then **parks the job**, and that is not optional. `createFromUrl` leaves the import in
 * `pending`/`running` at `match`, and a running worker's `resumableImports()` picks up exactly
 * those: without this, opening the wizard would start the import the wizard exists to let you
 * configure — the worker would match, auto-confirm and download while you were still looking
 * at step 1. `paused` is not resumable, so nothing touches the job until step 4 says so, and
 * a job abandoned half-way through the wizard stays abandoned instead of quietly importing
 * whatever the algorithm preferred.
 */
export const resolveSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ url: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const created = await createFromUrl(data.url, { db: db() });
      await pauseImport(created.job.id, "Waiting for the import wizard.", db());
      const { rows } = await videosOf(created.job.id, db());
      return toSourceView({ ...created.job, status: "paused" }, rows, created.duplicates);
    } catch (error) {
      return toFailure(error);
    }
  });

/** Re-read a source the wizard already resolved — a reload, or a step walked back to. */
export const fetchSource = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1) }))
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const { rows } = await videosOf(job.id, db());
      // Asked again on every visit: the wizard redirects away from the URL it resolved, so the
      // answer `createFromUrl` gave is long gone by the time step 1 renders.
      const duplicates = await duplicatesOf(job.url, job.id, db());
      return toSourceView(job, rows, duplicates);
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* step 2 — the candidates                                             */
/* ------------------------------------------------------------------ */

export interface CandidatesView {
  readonly kind: "album" | "single";
  readonly releases: readonly ReleaseCandidate[];
  readonly recordings: readonly RecordingCandidate[];
  readonly preselectedId: string | null;
  readonly safe: boolean;
  readonly ambiguous: boolean;
  readonly margin: number | null;
  readonly budget: { readonly searches: number; readonly lookups: number };
  readonly queries: readonly string[];
  /** What the source thinks it is — shown above the list so the query is never a mystery. */
  readonly hints: { readonly album: string | null; readonly artist: string | null };
}

/** How many candidates the wizard shows. More is noise; the search box is for the rest. */
const SHOWN = 12;

export const fetchCandidates = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1) }))
  .handler(async ({ data }): Promise<CandidatesView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const result = await rankFor({ job, settings, db: db() });
      const { videos } = await videosOf(job.id, db());
      const hints = hintsFor(job, videos);

      if (result.kind === "single") {
        const preselected = result.ranking.preselected;
        return {
          kind: "single",
          releases: [],
          recordings: result.ranking.candidates.slice(0, SHOWN),
          preselectedId: preselected?.id ?? null,
          safe: preselected?.safe ?? false,
          ambiguous: result.ranking.ambiguous,
          margin: result.ranking.margin,
          budget: result.budget,
          queries: result.queries,
          hints: { album: hints.album ?? null, artist: hints.artist ?? null },
        };
      }
      const preselected = result.ranking.preselected;
      return {
        kind: "album",
        releases: result.ranking.candidates.slice(0, SHOWN),
        recordings: [],
        preselectedId: preselected?.id ?? null,
        safe: preselected?.safe ?? false,
        ambiguous: result.ranking.ambiguous,
        margin: result.ranking.margin,
        budget: result.budget,
        queries: result.queries,
        hints: { album: hints.album ?? null, artist: hints.artist ?? null },
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Search MusicBrainz in words, or paste an MBID.
 *
 * One function for both because they are the same act — "the list is wrong, here is what I
 * mean" — and because an MBID pasted into the search box should just work rather than being a
 * different field you have to notice.
 */
export const searchCandidates = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), query: z.string().trim().min(1) }))
  .handler(
    async ({ data }): Promise<{ candidates: readonly ReleaseCandidate[]; query: string }> => {
      try {
        const job = await getImport(data.importId, db());
        if (job === null) {
          throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
        }
        const settings = await loadSettings(db());
        const mbid = parseMbid(data.query);
        if (mbid !== null) {
          const { candidate } = await pinnedRelease({
            job,
            settings,
            db: db(),
            releaseMbid: mbid,
          });
          return { candidates: [candidate], query: mbid };
        }
        return await searchReleases({ job, settings, db: db(), query: data.query });
      } catch (error) {
        return toFailure(error);
      }
    },
  );

/* ------------------------------------------------------------------ */
/* step 3 — the mapping                                                */
/* ------------------------------------------------------------------ */

export interface MappingCandidateTrack {
  readonly absoluteIndex: number;
  readonly position: number;
  readonly mediumPosition: number;
  readonly title: string;
  readonly lengthSeconds: number | null;
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
}

export interface MappingViewPayload {
  readonly releaseMbid: string;
  readonly releaseTitle: string;
  readonly releaseArtist: string;
  readonly releaseYear: number | null;
  readonly releaseGroupMbid: string | null;
  readonly tracks: readonly MappingCandidateTrack[];
  readonly lines: readonly MappingLine[];
  readonly extraVideos: readonly ExtraVideo[];
  readonly uncoveredTracks: readonly UncoveredTrack[];
  readonly bound: number;
  readonly fit: number;
  readonly fitOf: number;
  readonly meanAbsDelta: number | null;
  /** The videos, so the left column of the mapping table needs no second call. */
  readonly videos: readonly SourceVideo[];
}

function toCandidateTrack(track: MatchTrack): MappingCandidateTrack {
  return {
    absoluteIndex: track.absoluteIndex,
    position: track.position,
    mediumPosition: track.mediumPosition,
    title: track.title,
    lengthSeconds: track.lengthSeconds,
    trackMbid: track.trackMbid,
    recordingMbid: track.recordingMbid,
  };
}

export const fetchMapping = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), releaseMbid: z.string().min(1) }))
  .handler(async ({ data }): Promise<MappingViewPayload> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const view = await mappingFor({
        job,
        settings,
        db: db(),
        releaseMbid: data.releaseMbid,
      });
      const { rows } = await videosOf(job.id, db());
      return {
        releaseMbid: view.releaseMbid,
        releaseTitle: view.releaseTitle,
        releaseArtist: view.releaseArtist,
        releaseYear: view.releaseYear,
        releaseGroupMbid: view.releaseGroupMbid,
        tracks: view.tracks.map(toCandidateTrack),
        lines: view.proposal.lines,
        extraVideos: view.proposal.extraVideos,
        uncoveredTracks: view.proposal.uncoveredTracks,
        bound: view.proposal.bound,
        fit: view.proposal.fit,
        fitOf: view.proposal.fitOf,
        meanAbsDelta: view.proposal.meanAbsDelta,
        videos: toSourceView(job, rows, []).videos,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* step 4 — start                                                      */
/* ------------------------------------------------------------------ */

const startInput = z.object({
  importId: z.string().min(1),
  /**
   * `null` is **import without MusicBrainz** (P07a).
   *
   * P06 deferred this because an album with no release needed the library screens to be
   * findable and finishable; they exist now, so step 2 offers it for a source MusicBrainz
   * genuinely does not have. The document is then built from the YouTube tags alone and the
   * album carries an `untagged` badge with its own filter on `/library` and `/library/quality`.
   */
  releaseMbid: z.string().min(1).nullable(),
  releaseGroupMbid: z.string().nullable().default(null),
  album: z.string().default(""),
  albumArtist: z.string().default(""),
  year: z.number().int().nullable().default(null),
  trackTotal: z.number().int().min(0).default(0),
  /** One entry per bound video. A video absent from this list becomes an extra. */
  bindings: z
    .array(
      z.object({
        /** The video's index in the source listing. */
        position: z.number().int().min(0),
        trackPosition: z.number().int().min(1),
        mediumPosition: z.number().int().min(1).default(1),
        trackMbid: z.string().nullable().default(null),
        recordingMbid: z.string().min(1).nullable(),
        trackTitle: z.string().default(""),
        confidence: z.number().min(0).max(1).default(1),
      }),
    )
    .min(1),
  options: z
    .object({
      fingerprint: z.boolean().default(true),
      lyrics: z.boolean().default(true),
      replaygain: z.boolean().default(true),
      force: z.boolean().default(false),
    })
    .default({ fingerprint: true, lyrics: true, replaygain: true, force: false }),
  /** `low` | `normal` | `next` — the three chips of step 4. */
  priority: z.enum(["low", "normal", "next"]).default("normal"),
});

const PRIORITY: Record<"low" | "normal" | "next", number> = { low: -10, normal: 0, next: 100 };

export interface StartResult {
  readonly importId: string;
  readonly mapped: number;
  readonly extras: number;
  readonly uncovered: number;
  readonly status: string;
}

/**
 * Commit the wizard and hand the job to the worker.
 *
 * `match` is run here, synchronously, rather than left to the worker: it is the step that
 * applies the supplied mapping, it costs nothing (there is no MusicBrainz call left to make),
 * and running it now is what lets this function report "14 mapped, 1 extra" back to the page
 * that asked — and lets it resolve the `extra_videos` notice, which only exists once the step
 * has run. Everything after `match` is queued, as it must be: a download inside an HTTP
 * request dies with the request.
 */
export const startImport = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(startInput)
  .handler(async ({ data }): Promise<StartResult> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }

      const mapping: SuppliedMapping = {
        releaseMbid: data.releaseMbid,
        releaseGroupMbid: data.releaseGroupMbid,
        ...(data.album === "" ? {} : { album: data.album }),
        ...(data.albumArtist === "" ? {} : { albumArtist: data.albumArtist }),
        year: data.year,
        trackTotal: data.trackTotal,
        // `SuppliedMapping` says "absent", the wire says "null"; they mean the same thing and
        // only one of them survives `exactOptionalPropertyTypes`.
        tracks: data.bindings.map((binding) => ({
          position: binding.position,
          trackPosition: binding.trackPosition,
          mediumPosition: binding.mediumPosition,
          recordingMbid: binding.recordingMbid,
          trackTitle: binding.trackTitle,
          confidence: binding.confidence,
          ...(binding.trackMbid === null ? {} : { trackMbid: binding.trackMbid }),
        })),
      };

      await setImportOptions(
        data.importId,
        {
          mapping,
          releaseMbid: data.releaseMbid,
          fingerprint: data.options.fingerprint,
          lyrics: data.options.lyrics,
          replaygain: data.options.replaygain,
          force: data.options.force,
          // The wizard *is* the confirmation gate of `docs/04`: you have just seen the
          // release, the mapping and the options and pressed Start. Blocking on `confirm`
          // afterwards would be asking the same question twice.
          autoConfirm: true,
        },
        { priority: PRIORITY[data.priority], releaseMbid: data.releaseMbid },
        db(),
      );

      const settings = await loadSettings(db());
      const result = await runStep(data.importId, "match", { db: db(), settings });

      // Videos outside the tracklist were shown in step 3 and accepted by pressing Start.
      await acknowledgeExtras(data.importId);

      const after = await getImport(data.importId, db());
      await enqueue(data.importId, "console wizard");

      const info = (result.data ?? {}) as { mapped?: number; extras?: number };
      const uncovered = (await listInbox({ importId: data.importId, status: "open" }, db())).filter(
        (item) => item.type === "uncovered_tracks",
      ).length;

      return {
        importId: data.importId,
        mapped: info.mapped ?? data.bindings.length,
        extras: info.extras ?? 0,
        uncovered,
        status: after?.status ?? "pending",
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** Close the `extra_videos` notices of an import, recording who answered and how. */
async function acknowledgeExtras(importId: string): Promise<void> {
  const open = await listInbox({ importId, status: "open" }, db());
  for (const item of open) {
    if (item.type !== "extra_videos") continue;
    await resolveInboxItem(
      item.id,
      {
        resolution: { action: "ignore", acknowledgedIn: "import wizard" },
        decidedBy: "console",
      },
      db(),
    );
  }
}
