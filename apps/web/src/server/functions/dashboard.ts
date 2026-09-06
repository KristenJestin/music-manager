/**
 * The dashboard, and the two live readouts the shell shows on every page.
 *
 * `fetchShell` is deliberately separate from `fetchDashboard`: the sidebar's counters and the
 * worker card are on *every* page, so they must be cheap and must not drag six library
 * aggregates along with them.
 */
import { z } from "zod";
import { db } from "#/server/db/client.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { readEvents } from "#/server/services/events.ts";
import { listInbox } from "#/server/services/inbox.ts";
import {
  dashboardStats,
  jobCounts,
  listJobs,
  recentAlbums,
  type DashboardStats,
  type JobSummary,
  type RecentAlbum,
} from "#/server/services/console.queries.ts";
import { serverEnv } from "#/server/env.ts";
import { toolbox } from "#/server/toolbox/client.ts";
import type { InboxItem } from "#/server/db/schema/index.ts";
import type { JobEventPayload } from "@mm/contracts";
import { APP_VERSION } from "#/server/version.ts";

/* ------------------------------------------------------------------ */
/* the shell                                                           */
/* ------------------------------------------------------------------ */

export interface ShellPayload {
  readonly version: string;
  readonly fixtures: boolean;
  readonly needsReview: number;
  readonly inProgress: number;
  readonly failed: number;
  /** The job the worker is on, if any — the sidebar's live card. */
  readonly current: {
    readonly importId: string;
    readonly title: string;
    readonly artist: string | null;
    readonly step: string;
    readonly tracksDone: number;
    readonly tracksTotal: number;
  } | null;
  readonly queued: number;
  /** The last few journal lines, for the activity drawer. */
  readonly activity: readonly JobEventPayload[];
}

export const fetchShell = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<ShellPayload> => {
    try {
      const [counts, running, activity] = await Promise.all([
        jobCounts(db()),
        listJobs({ status: "active", limit: 20 }, db()),
        recentActivity(),
      ]);
      const open = await listInbox({ status: "open" }, db());
      const current = running.find((entry) => entry.job.status === "running") ?? null;

      return {
        version: APP_VERSION,
        fixtures: serverEnv().MM_FIXTURES,
        needsReview: open.length,
        inProgress: counts.active,
        failed: counts.failed,
        current:
          current === null
            ? null
            : {
                importId: current.job.id,
                title: current.job.title ?? current.job.url,
                artist: current.job.artist,
                step: current.job.step,
                tracksDone: current.tracksDone,
                tracksTotal: current.tracksTotal,
              },
        queued: counts.pending,
        activity,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * The tail of the whole journal.
 *
 * `readEvents` returns oldest-first from a cursor, and there is no "last N" query on the
 * service. Rather than add one to a P03 file, the tail is taken here: the journal of a
 * self-hosted instance is small, and this is one indexed scan.
 */
async function recentActivity(limit = 40): Promise<readonly JobEventPayload[]> {
  const all = await readEvents({ since: 0, limit: 500 }, db());
  return all.slice(-limit).reverse();
}

/* ------------------------------------------------------------------ */
/* the dashboard                                                       */
/* ------------------------------------------------------------------ */

export interface SystemCheck {
  readonly name: string;
  readonly detail: string;
  readonly tone: "ok" | "warn" | "danger";
}

export interface DashboardPayload {
  readonly stats: DashboardStats;
  readonly active: readonly JobSummary[];
  readonly review: readonly InboxItem[];
  readonly system: readonly SystemCheck[];
  readonly activity: readonly JobEventPayload[];
  /** The last albums that landed in the library, newest first (owner review C8). */
  readonly recent: readonly RecentAlbum[];
}

/**
 * The toolbox's own health, turned into rows.
 *
 * A `null` version means the image is broken (`CLAUDE.md`), which is worth a red dot rather
 * than a missing line — a diagnostic that disappears when it fails is not a diagnostic.
 */
async function systemChecks(): Promise<SystemCheck[]> {
  const env = serverEnv();
  const rows: SystemCheck[] = [
    {
      name: "Music Manager",
      detail: `v${APP_VERSION}${env.MM_FIXTURES ? " · fixtures mode" : ""}`,
      tone: "ok",
    },
  ];
  try {
    const health = await toolbox().health();
    const versions: [string, string | null][] = [
      ["yt-dlp", health.versions["yt-dlp"]],
      ["ffmpeg", health.versions.ffmpeg],
      ["fpcalc", health.versions.fpcalc],
      ["rsgain", health.versions.rsgain],
    ];
    for (const [name, version] of versions) {
      rows.push({
        name,
        detail: version ?? "not available in the toolbox image",
        tone: version === null ? "danger" : "ok",
      });
    }
    rows.push({
      name: "Toolbox",
      detail: `${env.MM_TOOLBOX_URL}${health.fixtures ? " · fixtures" : ""}${health.downloading ? " · downloading" : " · idle"}`,
      tone: "ok",
    });
  } catch (error) {
    rows.push({
      name: "Toolbox",
      detail: error instanceof Error ? error.message : "unreachable",
      tone: "danger",
    });
  }
  return rows;
}

export const fetchDashboard = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({}).default({}))
  .handler(async (): Promise<DashboardPayload> => {
    try {
      // One loader, one round trip: the recent albums ride with the tiles rather than costing
      // the dashboard a second request of its own.
      const [stats, active, review, system, activity, recent] = await Promise.all([
        dashboardStats(db()),
        listJobs({ status: "active", limit: 6 }, db()),
        listInbox({ status: "open" }, db()),
        systemChecks(),
        recentActivity(8),
        recentAlbums(10, db()),
      ]);
      return { stats, active, review: review.slice(0, 5), system, activity, recent };
    } catch (error) {
      return toFailure(error);
    }
  });
