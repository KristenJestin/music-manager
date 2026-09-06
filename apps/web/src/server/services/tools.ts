/**
 * `tools.service` — the diagnostics behind `/tools`.
 *
 * `docs/02-lecons-v1.md` says the first pain of v1 was "it breaks at every YouTube change",
 * and the second was "when it breaks you cannot tell why". This file is the answer to the
 * second one: everything that goes wrong in practice, asked directly, with the answer in the
 * shape the Console can act on.
 *
 * Four rules run through all of it:
 *
 *  - **Nothing here throws.** A diagnostic that fails is a diagnostic *result* — "MusicBrainz
 *    did not answer in 5 s" is exactly the thing the page exists to display, and an exception
 *    would replace the whole page with it.
 *  - **The taxonomy is not duplicated.** The error decoder comes from the toolbox's own
 *    `GET /errors`, so a pattern added in `errors.py` shows up here without a second edit.
 *  - **A latency probe is the cheapest call that proves the service answers**, never a real
 *    query: this page must not consume anybody's rate limit.
 *  - **No credential is ever returned**, only whether one is set.
 */
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { ACOUSTID_BASE } from "#/server/integrations/acoustid.ts";
import { CAA_BASE } from "#/server/integrations/coverartarchive.ts";
import { DEEZER_BASE } from "#/server/integrations/deezer.ts";
import { LASTFM_BASE } from "#/server/integrations/lastfm.ts";
import { LISTENBRAINZ_BASE } from "#/server/integrations/listenbrainz.ts";
import { LRCLIB_BASE } from "#/server/integrations/lrclib.ts";
import { MUSICBRAINZ_BASE } from "#/server/integrations/musicbrainz.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import { emit, readEvents } from "#/server/services/events.ts";
import { openLibraryItem, closeLibraryItem } from "#/server/services/library-inbox.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  toolbox as defaultToolbox,
  type CookiesTestResult,
  type ErrorCatalogEntry,
  type SelfTestResult,
  type ToolboxClient,
  type ToolVersions,
} from "#/server/toolbox/client.ts";
import type { JobEventPayload } from "@mm/contracts";

export interface ToolsDeps {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  /** Injected by the tests: no unit test of this file may touch the network. */
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

/**
 * The three things a diagnostic needs, resolved **lazily**.
 *
 * `db` and `box` are functions rather than values because opening either one parses the
 * environment, and a unit test that injects both settings and a fake toolbox must be able to
 * run without a `DATABASE_URL` — which is the whole point of injecting them.
 */
async function resolve(deps: ToolsDeps): Promise<{
  db: () => Database;
  settings: Settings;
  box: () => ToolboxClient;
}> {
  const settings = deps.settings ?? (await loadSettings(deps.db));
  return {
    db: () => deps.db ?? defaultDb(),
    settings,
    box: () => deps.toolbox ?? defaultToolbox(),
  };
}

/* ------------------------------------------------------------------ */
/* the downloader                                                      */
/* ------------------------------------------------------------------ */

export interface DownloaderHealth {
  readonly reachable: boolean;
  readonly fixtures: boolean;
  readonly downloading: boolean;
  readonly versions: ToolVersions;
  readonly channel: Settings["ytdlpChannel"];
  readonly pin: string;
  readonly autoUpdate: boolean;
  readonly updateCron: string;
  readonly onUpdateFailure: Settings["ytdlpOnUpdateFailure"];
  readonly error: string | null;
}

/** `GET /health`, plus the settings that steer the binary it reports. */
export async function downloaderHealth(deps: ToolsDeps = {}): Promise<DownloaderHealth> {
  const { settings, box } = await resolve(deps);
  const base = {
    fixtures: false,
    downloading: false,
    versions: { "yt-dlp": null, ffmpeg: null, fpcalc: null, rsgain: null } as ToolVersions,
    channel: settings.ytdlpChannel,
    pin: settings.ytdlpPin,
    autoUpdate: settings.ytdlpAutoUpdate,
    updateCron: settings.ytdlpUpdateCron,
    onUpdateFailure: settings.ytdlpOnUpdateFailure,
  };
  try {
    const health = await box().health();
    return {
      ...base,
      reachable: true,
      fixtures: health.fixtures,
      downloading: health.downloading,
      versions: health.versions,
      error: null,
    };
  } catch (error) {
    return { ...base, reachable: false, error: MMError.from(error).message };
  }
}

export interface YtdlpUpdateOutcome {
  readonly ok: boolean;
  readonly updated: boolean;
  readonly from: string | null;
  readonly to: string | null;
  readonly method: string;
  readonly output: string;
  readonly error: string | null;
}

/**
 * Refresh yt-dlp and record what happened.
 *
 * The `ytdlpOnUpdateFailure` policy is applied here rather than in the cron, because the
 * button in Settings must behave the same way the schedule does. `warn` is the default and
 * simply opens an Inbox item; `pause_downloads` is the honest option when a broken downloader
 * would otherwise burn through a queue producing failures.
 */
export async function updateYtdlp(deps: ToolsDeps = {}): Promise<YtdlpUpdateOutcome> {
  const { db, settings, box } = await resolve(deps);
  try {
    const result = await box().updateYtdlp();
    const outcome: YtdlpUpdateOutcome = {
      ok: result.ok,
      updated: result.changed,
      from: result.previous ?? null,
      to: result.current ?? null,
      method: result.method,
      output: result.output,
      error: null,
    };
    await emit(
      {
        type: "ytdlp.update",
        level: result.ok ? "info" : "warn",
        message: result.changed
          ? `yt-dlp updated from ${result.previous ?? "?"} to ${result.current ?? "?"}.`
          : `yt-dlp is unchanged (${result.current ?? "?"}, via ${result.method}).`,
        data: { ...outcome },
      },
      db(),
    );
    if (result.ok) {
      await closeLibraryItem("ytdlp_update", "ytdlp", db());
    } else {
      await raiseUpdateFailure(db(), settings, result.output);
    }
    return outcome;
  } catch (error) {
    const failure = MMError.from(error);
    await raiseUpdateFailure(db(), settings, failure.message);
    return {
      ok: false,
      updated: false,
      from: null,
      to: null,
      method: "none",
      output: "",
      error: failure.message,
    };
  }
}

async function raiseUpdateFailure(db: Database, settings: Settings, detail: string): Promise<void> {
  const consequence =
    settings.ytdlpOnUpdateFailure === "pause_downloads"
      ? "Downloads are configured to stop until this is fixed."
      : settings.ytdlpOnUpdateFailure === "rollback"
        ? "The previous build is being kept."
        : "Downloads continue with the version already installed.";
  await openLibraryItem(
    {
      type: "ytdlp_update",
      subject: "ytdlp",
      title: "yt-dlp could not be updated",
      summary: `${detail.slice(0, 400)} ${consequence}`,
      payload: { detail: detail.slice(0, 4000), policy: settings.ytdlpOnUpdateFailure },
      preselected: { action: "retry" },
    },
    db,
  );
}

/** `POST /ytdlp/selftest`. `network` is opt-in and never on in fixtures mode. */
export async function selftest(
  options: { network?: boolean; url?: string } = {},
  deps: ToolsDeps = {},
): Promise<SelfTestResult & { error: string | null }> {
  const { box } = await resolve(deps);
  try {
    const result = await box().selftestYtdlp(options);
    return { ...result, error: null };
  } catch (error) {
    return {
      ok: false,
      version: null,
      checks: [],
      error: MMError.from(error).message,
    };
  }
}

export interface CookiesStatus {
  readonly mode: Settings["cookiesMode"];
  readonly path: string;
  readonly ok: boolean;
  readonly cookies: number;
  readonly domains: readonly string[];
  readonly authenticated: boolean;
  readonly expiresAt: string | null;
  readonly expired: number;
  readonly problems: readonly string[];
  readonly note: string;
}

/**
 * Test the cookie jar, or explain that there is not one.
 *
 * Anonymous is a legitimate, and the default, way to run: most of YouTube needs no session.
 * So "no cookies" is reported as a *mode*, not as a problem — the page says what it is doing,
 * and only flags a jar that was configured and does not work.
 */
export async function cookiesStatus(deps: ToolsDeps = {}): Promise<CookiesStatus> {
  const { settings, box } = await resolve(deps);
  const empty = {
    mode: settings.cookiesMode,
    path: settings.cookiesFile,
    ok: true,
    cookies: 0,
    domains: [] as string[],
    authenticated: false,
    expiresAt: null,
    expired: 0,
    problems: [] as string[],
  };

  if (settings.cookiesMode === "anonymous") {
    return {
      ...empty,
      note: "Anonymous mode: yt-dlp uses no session. Age-gated videos and bot checks will fail, which is the trade.",
    };
  }
  if (settings.cookiesFile.trim() === "") {
    return {
      ...empty,
      ok: false,
      problems: ["No cookies.txt path is set."],
      note: "Cookie mode is on but no file is configured.",
    };
  }

  try {
    const result: CookiesTestResult = await box().testCookies({ path: settings.cookiesFile });
    return {
      mode: settings.cookiesMode,
      path: settings.cookiesFile,
      ok: result.ok,
      cookies: result.cookies,
      domains: result.domains,
      authenticated: result.authenticated,
      expiresAt: result.expires_at ?? null,
      expired: result.expired,
      problems: result.problems ?? [],
      note: result.ok
        ? "A usable YouTube session."
        : "The jar was read but is not a usable session.",
    };
  } catch (error) {
    return {
      ...empty,
      ok: false,
      problems: [MMError.from(error).message],
      note: "The toolbox could not read the cookie file.",
    };
  }
}

/* ------------------------------------------------------------------ */
/* the sources                                                         */
/* ------------------------------------------------------------------ */

export interface ServiceLatency {
  readonly name: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly ok: boolean;
  readonly status: number | null;
  readonly latencyMs: number;
  readonly note: string;
  readonly error: string | null;
}

/**
 * The cheapest call per source that proves it answers.
 *
 * MusicBrainz gets a `?fmt=json&limit=1` search rather than a lookup, LRCLIB a search for
 * nothing, Last.fm and AcoustID a request their API answers even without a key — the point is
 * "is the host up and are we allowed to speak to it", not "does this data exist". Nothing here
 * is cached, because a cached latency is not a latency.
 */
export async function serviceLatencies(deps: ToolsDeps = {}): Promise<ServiceLatency[]> {
  const { settings } = await resolve(deps);
  const config = sourcesConfig(settings);
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));

  const probes: {
    name: string;
    label: string;
    url: string;
    note: string;
    /** A 4xx that still proves the service answered — an unauthenticated ping, typically. */
    acceptClientError?: boolean;
  }[] = [
    {
      name: "musicbrainz",
      label: "MusicBrainz",
      url: `${MUSICBRAINZ_BASE}/release?query=%2A&limit=1&fmt=json`,
      note: "1 req/s, User-Agent required",
    },
    {
      name: "coverartarchive",
      label: "Cover Art Archive",
      url: `${CAA_BASE}/release/00000000-0000-0000-0000-000000000000`,
      note: "404 on a bogus MBID means the index answered",
      acceptClientError: true,
    },
    {
      name: "acoustid",
      label: "AcoustID",
      url: `${ACOUSTID_BASE}/lookup?format=json&client=${config.acoustidKey === "" ? "test" : config.acoustidKey}&meta=recordings&duration=1&fingerprint=x`,
      note: config.acoustidKey === "" ? "no key set" : "key set",
      acceptClientError: true,
    },
    {
      name: "lrclib",
      label: "LRCLIB",
      url: `${LRCLIB_BASE}/search?q=a`,
      note: "no key needed",
    },
    { name: "deezer", label: "Deezer", url: `${DEEZER_BASE}/search?q=a&limit=1`, note: "public" },
    {
      name: "lastfm",
      label: "Last.fm",
      url: `${LASTFM_BASE}?method=chart.gettoptags&format=json&api_key=${config.lastfmKey === "" ? "none" : config.lastfmKey}`,
      note: config.lastfmKey === "" ? "no key set" : "key set",
      acceptClientError: true,
    },
    {
      name: "listenbrainz",
      label: "ListenBrainz",
      url: `${LISTENBRAINZ_BASE}/validate-token`,
      note: "public endpoint",
      acceptClientError: true,
    },
  ];

  return await Promise.all(
    probes.map(async (probe) => {
      const enabled = config.enabled[probe.name as keyof typeof config.enabled] ?? true;
      const started = Date.now();
      if (!enabled) {
        return {
          name: probe.name,
          label: probe.label,
          enabled,
          ok: false,
          status: null,
          latencyMs: 0,
          note: "disabled in settings",
          error: null,
        };
      }
      try {
        const response = await doFetch(probe.url, {
          headers: { "user-agent": config.userAgent, accept: "application/json" },
          signal: AbortSignal.timeout(8_000),
        });
        const latencyMs = Date.now() - started;
        const ok =
          response.ok ||
          (probe.acceptClientError === true && response.status >= 400 && response.status < 500);
        return {
          name: probe.name,
          label: probe.label,
          enabled,
          ok,
          status: response.status,
          latencyMs,
          note: probe.note,
          error: ok ? null : `HTTP ${String(response.status)}`,
        };
      } catch (error) {
        return {
          name: probe.name,
          label: probe.label,
          enabled,
          ok: false,
          status: null,
          latencyMs: Date.now() - started,
          note: probe.note,
          error: error instanceof Error ? error.message : "unreachable",
        };
      }
    }),
  );
}

/* ------------------------------------------------------------------ */
/* test a URL                                                          */
/* ------------------------------------------------------------------ */

export interface UrlTest {
  readonly url: string;
  readonly ok: boolean;
  readonly kind: string;
  readonly title: string;
  readonly entries: number;
  readonly durationMs: number;
  readonly sample: readonly { readonly title: string; readonly duration: number | null }[];
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint: string;
    readonly action: string;
  } | null;
}

/**
 * `POST /extract` with no download — the "Test a URL" box.
 *
 * A failure comes back **decoded**: the toolbox's own `{code, hint, action}`, which is the
 * same shape the error decoder table below renders. That is the whole point of the box: not
 * "it failed", but "it failed because YouTube wants a session, and here is the button".
 */
export async function testUrl(url: string, deps: ToolsDeps = {}): Promise<UrlTest> {
  const { box } = await resolve(deps);
  const started = Date.now();
  try {
    const result = await box().extract(url);
    const entries = result.entries;
    return {
      url,
      ok: true,
      kind: result.kind,
      title: result.title ?? "",
      entries: entries.length,
      durationMs: Date.now() - started,
      sample: entries.slice(0, 5).map((entry) => ({
        title: entry.title,
        duration: entry.duration ?? null,
      })),
      error: null,
    };
  } catch (error) {
    const failure = MMError.from(error);
    return {
      url,
      ok: false,
      kind: "",
      title: "",
      entries: 0,
      durationMs: Date.now() - started,
      sample: [],
      error: {
        code: failure.code,
        message: failure.message,
        hint: failure.hint ?? "",
        action: failure.action ?? "",
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* the error decoder and the worker log                                */
/* ------------------------------------------------------------------ */

/** The taxonomy, straight from `services/toolbox/src/toolbox/errors.py`. */
export async function errorCatalog(deps: ToolsDeps = {}): Promise<{
  readonly entries: readonly ErrorCatalogEntry[];
  readonly error: string | null;
}> {
  const { box } = await resolve(deps);
  try {
    const catalog = await box().errorCatalog();
    return { entries: catalog.entries, error: null };
  } catch (error) {
    return { entries: [], error: MMError.from(error).message };
  }
}

/** The tail of `job_events`. The SSE stream at `/api/events` carries the rest live. */
export async function workerLog(
  options: { limit?: number; level?: "all" | "error" } = {},
  deps: ToolsDeps = {},
): Promise<readonly JobEventPayload[]> {
  const { db } = await resolve(deps);
  const rows = await readEvents({ limit: options.limit ?? 200 }, db());
  const tail = rows.slice(-(options.limit ?? 200));
  return options.level === "error" ? tail.filter((row) => row.level !== "info") : tail;
}

/** Where the toolbox is, for the "connected to" line. Never a token. */
export function toolboxTarget(deps: ToolsDeps = {}): { url: string; authenticated: boolean } {
  const box = deps.toolbox ?? defaultToolbox();
  return { url: box.baseUrl, authenticated: serverEnv().MM_TOOLBOX_TOKEN !== "" };
}
