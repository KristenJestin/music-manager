/**
 * "Is this installation working, and if not, which half of it is broken?"
 *
 * This exists because of one debugging session recorded in
 * `orchestration/feedback/2026-09-06-mcp-test-report.md` §3 and §9: every import was failing at
 * `resolve` with `UNKNOWN — POST /extract failed.`, and nothing an agent could call over MCP
 * distinguished "the toolbox is not running" from "the toolbox refused the request" from "the
 * URL points at the wrong container". The answer was in a `docker exec`, which is exactly the
 * place an agent cannot look.
 *
 * Four questions, four answers, and **it never throws** — the same rule `tools.ts` keeps. A
 * status endpoint that fails when the thing it reports on fails is not a status endpoint.
 */
import { desc, eq } from "drizzle-orm";
import { MMError, type MMErrorBody } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { APP_VERSION } from "#/server/version.ts";
import { appMeta, imports } from "#/server/db/schema/index.ts";
import { navidromeStatus } from "#/server/services/navidrome.ts";
import { downloaderHealth, toolboxTarget } from "#/server/services/tools.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { serverEnv } from "#/server/env.ts";
import type { ToolboxClient } from "#/server/toolbox/client.ts";

/**
 * Where the worker says it is alive.
 *
 * `app_meta` is the typed KV table P00 shipped and it is the right home: a heartbeat is one
 * string that is overwritten for ever, it must survive a restart, and it must not need a
 * migration to exist. The alternative — reading pg-boss's own `pgboss.*` tables — would tie a
 * public answer to a library's private schema.
 */
export const WORKER_HEARTBEAT_KEY = "worker.heartbeat";

/** How long a heartbeat stays believable. Three missed beats at the worker's 30 s interval. */
export const WORKER_STALE_MS = 90_000;

/** Called by the worker on a timer. Cheap, idempotent, and never a reason to crash. */
export async function beatWorker(
  db: Database = defaultDb(),
  now: Date = new Date(),
): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: WORKER_HEARTBEAT_KEY, value: now.toISOString(), updatedAt: now })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: now.toISOString(), updatedAt: now },
    });
}

export interface WorkerStatus {
  /** A heartbeat inside `WORKER_STALE_MS`. False also means "never started". */
  readonly alive: boolean;
  readonly lastBeatAt: string | null;
  readonly secondsSinceBeat: number | null;
  /** Said in words, because "alive: false" alone does not tell you which false it is. */
  readonly note: string;
}

export async function workerStatus(
  db: Database = defaultDb(),
  now: Date = new Date(),
): Promise<WorkerStatus> {
  const [row] = await db
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, WORKER_HEARTBEAT_KEY))
    .limit(1);

  if (row === undefined) {
    return {
      alive: false,
      lastBeatAt: null,
      secondsSinceBeat: null,
      note: "No worker has ever reported in on this database. Start one with `bun run worker`.",
    };
  }

  const beat = new Date(row.value);
  const ageMs = now.getTime() - beat.getTime();
  const alive = Number.isFinite(ageMs) && ageMs < WORKER_STALE_MS;
  return {
    alive,
    lastBeatAt: row.value,
    secondsSinceBeat: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
    note: alive
      ? "A worker is running: jobs queued now will be picked up."
      : `The last heartbeat was ${String(Math.round(ageMs / 1000))} s ago. Nothing is draining the queues; start one with \`bun run worker\`.`,
  };
}

/* ------------------------------------------------------------------ */
/* the last thing that went wrong                                      */
/* ------------------------------------------------------------------ */

export interface LastFailure {
  readonly importId: string;
  readonly url: string;
  readonly step: string;
  readonly at: string | null;
  readonly error: MMErrorBody | null;
}

/**
 * The most recent failed import, with its error **in full**.
 *
 * Deliberately the import rather than the journal: `job_events` is chatty and a status answer
 * that dumped the last twenty lines would be another thing to read rather than an answer. One
 * failure, with its code, its status and its details, is the shortest thing that says why.
 */
export async function lastFailure(db: Database = defaultDb()): Promise<LastFailure | null> {
  const [failure] = await db
    .select()
    .from(imports)
    .where(eq(imports.status, "failed"))
    .orderBy(desc(imports.updatedAt))
    .limit(1);
  if (failure === undefined) return null;
  return {
    importId: failure.id,
    url: failure.url,
    step: failure.step,
    at: failure.updatedAt.toISOString(),
    error: (failure.error as MMErrorBody | null) ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* the whole picture                                                   */
/* ------------------------------------------------------------------ */

export interface SystemStatus {
  /** True when nothing here needs a human. The one field a caller may branch on blindly. */
  readonly ok: boolean;
  readonly version: string;
  readonly fixtures: boolean;
  readonly database: { readonly ok: boolean; readonly error: string | null };
  readonly toolbox: {
    readonly url: string;
    readonly authenticated: boolean;
    readonly reachable: boolean;
    readonly fixtures: boolean;
    readonly downloading: boolean;
    /** yt-dlp, ffmpeg, fpcalc, rsgain. A `null` means the image is broken. */
    readonly versions: Record<string, string | null>;
    readonly error: string | null;
  };
  readonly navidrome: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly ok: boolean;
    readonly url: string;
    readonly serverVersion: string;
    readonly scanning: boolean;
    readonly lastScan: string | null;
    readonly error: string | null;
  };
  readonly worker: WorkerStatus;
  readonly lastFailure: LastFailure | null;
  /** Everything that is wrong, in the order a human would fix it. Empty when `ok`. */
  readonly problems: readonly string[];
}

export interface StatusOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly now?: Date;
}

export async function systemStatus(options: StatusOptions = {}): Promise<SystemStatus> {
  const db = options.db ?? defaultDb();
  const now = options.now ?? new Date();

  let settings: Settings | null = null;
  let databaseError: string | null = null;
  try {
    settings = options.settings ?? (await loadSettings(db));
  } catch (error) {
    databaseError = MMError.from(error).message;
  }

  const target = toolboxTarget(options.toolbox === undefined ? {} : { toolbox: options.toolbox });

  const [downloader, navidrome, worker, failure] = await Promise.all([
    settings === null
      ? null
      : downloaderHealth({
          db,
          settings,
          ...(options.toolbox === undefined ? {} : { toolbox: options.toolbox }),
        }).catch((error: unknown) => ({ error: MMError.from(error).message }) as const),
    settings === null
      ? null
      : navidromeStatus({ db, settings }).catch(
          (error: unknown) => ({ error: MMError.from(error).message }) as const,
        ),
    workerStatus(db, now).catch(
      () =>
        ({
          alive: false,
          lastBeatAt: null,
          secondsSinceBeat: null,
          note: "The heartbeat could not be read; the database is the first thing to check.",
        }) satisfies WorkerStatus,
    ),
    lastFailure(db).catch(() => null),
  ]);

  const health = downloader !== null && "reachable" in downloader ? downloader : null;
  const nav = navidrome !== null && "configured" in navidrome ? navidrome : null;

  const toolbox = {
    url: target.url,
    authenticated: target.authenticated,
    reachable: health?.reachable ?? false,
    fixtures: health?.fixtures ?? false,
    downloading: health?.downloading ?? false,
    versions: (health?.versions ?? {}) as Record<string, string | null>,
    error:
      health?.error ??
      (downloader !== null && "error" in downloader ? (downloader.error ?? null) : null),
  };

  const problems: string[] = [];
  if (databaseError !== null) problems.push(`The database is unreachable: ${databaseError}`);
  if (!toolbox.reachable) {
    problems.push(
      `The toolbox at ${toolbox.url} did not answer: ${toolbox.error ?? "no reason given"}`,
    );
  } else if (Object.values(toolbox.versions).some((version) => version === null)) {
    const broken = Object.entries(toolbox.versions)
      .filter(([, version]) => version === null)
      .map(([name]) => name);
    problems.push(
      `The toolbox image is missing ${broken.join(", ")} — rebuild it with \`bun run stack:up --build\`.`,
    );
  }
  if (!worker.alive) problems.push(worker.note);
  if (nav !== null && nav.enabled && nav.configured && !nav.ok) {
    problems.push(`Navidrome answered ${nav.error ?? "an error"}.`);
  }

  return {
    ok: problems.length === 0,
    version: APP_VERSION,
    fixtures: serverEnv().MM_FIXTURES,
    database: { ok: databaseError === null, error: databaseError },
    toolbox,
    navidrome: {
      configured: nav?.configured ?? false,
      enabled: nav?.enabled ?? false,
      ok: nav?.ok ?? false,
      url: nav?.url ?? "",
      serverVersion: nav?.serverVersion ?? "",
      scanning: nav?.scanning ?? false,
      lastScan: nav?.lastScan ?? null,
      error:
        nav?.error ?? (navidrome !== null && "error" in navidrome ? navidrome.error : null) ?? null,
    },
    worker,
    lastFailure: failure,
    problems,
  };
}
