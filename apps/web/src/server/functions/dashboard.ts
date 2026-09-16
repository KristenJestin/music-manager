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
import { readLatestEvents } from "#/server/services/events.ts";
import { countInbox, listInbox } from "#/server/services/inbox.ts";
import {
  dashboardStats,
  jobCounts,
  listJobs,
  recentAlbums,
  workerSnapshot,
  type DashboardStats,
  type JobSummary,
  type RecentAlbum,
  type WorkerCurrent,
} from "#/server/services/console.queries.ts";
import { serverEnv } from "#/server/env.ts";
import { toolbox } from "#/server/toolbox/client.ts";
import type { InboxItem } from "#/server/db/schema/index.ts";
import type { JobEventPayload } from "@mm/contracts";
import { APP_VERSION } from "#/server/version.ts";

/* ------------------------------------------------------------------ */
/* the shell                                                           */
/* ------------------------------------------------------------------ */

/** How many open Inbox items the dashboard's review card shows. */
const DASHBOARD_REVIEW = 5;

export interface ShellPayload {
  readonly version: string;
  readonly fixtures: boolean;
  readonly needsReview: number;
  readonly inProgress: number;
  readonly failed: number;
  /** The job the worker is on, if any — the sidebar's live card. */
  readonly current: WorkerCurrent | null;
  /** Imports waiting for the worker behind the download slot, not counting the one on it. */
  readonly queued: number;
  /** The last few journal lines, for the activity drawer. */
  readonly activity: readonly JobEventPayload[];
}

export const fetchShell = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<ShellPayload> => {
    try {
      /*
       * The worker card asks the database which import holds the download slot rather than
       * picking one out of a page of active jobs; `workerSnapshot` explains why.
       *
       * Four queries, all at once, and the Inbox one is a `count(*)`. This loader runs again
       * on every link hover — `defaultPreload: "intent"` with `defaultPreloadStaleTime: 0`,
       * `src/router.tsx` — so nothing in it may be proportional to the size of anything.
       */
      const [counts, worker, activity, needsReview] = await Promise.all([
        jobCounts(db()),
        workerSnapshot(db()),
        recentActivity(),
        countInbox({ status: "open" }, db()),
      ]);

      return {
        version: APP_VERSION,
        fixtures: serverEnv().MM_FIXTURES,
        needsReview,
        inProgress: counts.active,
        failed: counts.failed,
        current: worker.current,
        queued: worker.queued,
        activity,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** The tail of the whole journal, newest first. */
async function recentActivity(limit = 40): Promise<readonly JobEventPayload[]> {
  return await readLatestEvents({ limit }, db());
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
        // The dashboard card shows five. Ask for five rather than for every open item.
        listInbox({ status: "open", limit: DASHBOARD_REVIEW }, db()),
        systemChecks(),
        recentActivity(8),
        recentAlbums(10, db()),
      ]);
      return { stats, active, review, system, activity, recent };
    } catch (error) {
      return toFailure(error);
    }
  });
