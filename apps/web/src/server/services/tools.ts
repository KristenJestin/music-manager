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
import { TOOLBOX_CONTRACT_HASH, TOOLBOX_SCHEMA_VERSION } from "@mm/contracts/toolbox/contract";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { ACOUSTID_BASE } from "#/server/integrations/acoustid.ts";
import { CAA_BASE } from "#/server/integrations/coverartarchive.ts";
import { DEEZER_BASE } from "#/server/integrations/deezer.ts";
import { LASTFM_BASE } from "#/server/integrations/lastfm.ts";
import { LISTENBRAINZ_BASE } from "#/server/integrations/listenbrainz.ts";
import { LRCLIB_BASE } from "#/server/integrations/lrclib.ts";
import { MB_MIN_INTERVAL_MS, MUSICBRAINZ_BASE } from "#/server/integrations/musicbrainz.ts";
import { gateFor } from "#/server/integrations/rate-gate.ts";
import { sourcesConfig } from "#/server/integrations/config.ts";
import {
  cookieJar,
  describe as describeCookies,
  isMisconfigured,
} from "#/server/services/cookies.ts";
import { emit, readLatestEvents } from "#/server/services/events.ts";
import { openLibraryItem, closeLibraryItem } from "#/server/services/library-inbox.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  admit,
  attachedAlbum,
  isOfficialUpload,
  sourceRulesOf,
} from "#/server/services/source-rules.ts";
import { gapsOf, listedCount } from "#/server/services/jobs/steps/resolve.ts";
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

/**
 * Whether the running image implements the contract this code was generated against.
 *
 * `matches: false` is the diagnosis for the failure that opened both MCP test reports: a
 * container older than the app sending to it, which answers `422 extra_forbidden` on a field
 * its models have never heard of. Every other signal says the toolbox is healthy, because the
 * binaries inside it are.
 */
export interface ToolboxContract {
  readonly expected: string;
  /** `null` when the image predates the contract statement — which is itself a mismatch. */
  readonly actual: string | null;
  readonly schemaVersion: number;
  readonly matches: boolean;
  /** Said in words, and empty when it matches. */
  readonly note: string;
}

export function compareContract(health: {
  contract_hash?: string | undefined;
  schema_version?: number | undefined;
}): ToolboxContract {
  const actual = health.contract_hash ?? "";
  const schemaVersion = health.schema_version ?? 0;

  if (actual === "" || schemaVersion === 0) {
    return {
      expected: TOOLBOX_CONTRACT_HASH,
      actual: null,
      schemaVersion,
      matches: false,
      note:
        "The toolbox image does not report a contract hash at all, so it was built before " +
        "this check existed and is certainly older than this code. Rebuild it: " +
        "`bun run stack:up --build`.",
    };
  }

  if (schemaVersion !== TOOLBOX_SCHEMA_VERSION) {
    return {
      expected: TOOLBOX_CONTRACT_HASH,
      actual,
      schemaVersion,
      // Two hashes computed by two different algorithms are not comparable, and reporting a
      // difference between them would send somebody to rebuild an image that is fine.
      matches: true,
      note:
        `The toolbox states contract statement v${String(schemaVersion)} and this app speaks ` +
        `v${String(TOOLBOX_SCHEMA_VERSION)}; the hashes are not comparable, so staleness cannot be judged.`,
    };
  }

  if (actual === TOOLBOX_CONTRACT_HASH) {
    return {
      expected: TOOLBOX_CONTRACT_HASH,
      actual,
      schemaVersion,
      matches: true,
      note: "",
    };
  }

  return {
    expected: TOOLBOX_CONTRACT_HASH,
    actual,
    schemaVersion,
    matches: false,
    note:
      `The toolbox image implements contract ${actual} and this app was generated against ` +
      `${TOOLBOX_CONTRACT_HASH}: the container is not the one this code was built for. Calls ` +
      "will fail with HTTP 422 `extra_forbidden` on fields its models do not know, which reads " +
      "like a bug in the app. Rebuild it: `bun run stack:up --build`.",
  };
}

export interface DownloaderHealth {
  readonly reachable: boolean;
  readonly fixtures: boolean;
  readonly downloading: boolean;
  readonly versions: ToolVersions;
  /** Absent when the toolbox could not be reached at all. */
  readonly contract: ToolboxContract | null;
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
    contract: null,
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
      contract: compareContract(health),
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
  /** One safe line about where the jar came from. Never a cookie. */
  readonly source: string;
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
 * Why a jar that parsed is still not a session, with the numbers the toolbox already computed.
 *
 * "The jar was read but is not a usable session" is true and useless: the owner reading it on
 * `mm tools status` cannot tell a jar that expired this morning from one that never carried a
 * `SAPISID` at all, and the two need different fixes (export a fresh jar / log in before
 * exporting). The toolbox answers both — `cookies`, `domains`, `expired`, `problems` — and
 * nothing was reading them out.
 *
 * Every figure here is one the toolbox returned; nothing is computed twice and no cookie value
 * is ever named.
 */
export function unusableJarSentence(result: {
  readonly cookies: number;
  readonly domains: readonly string[];
  readonly authenticated: boolean;
  readonly expired: number;
  readonly expires_at?: string | null;
  readonly problems?: readonly string[];
}): string {
  const counts =
    `${String(result.cookies)} cookie(s) · ${String(result.domains.length)} domain(s)` +
    ` · ${result.authenticated ? "a session yt-dlp accepts" : "no session yt-dlp accepts"}` +
    ` · ${String(result.expired)} expired`;
  const problems = result.problems ?? [];
  const why = problems.length === 0 ? "" : ` — ${problems.join("; ")}`;
  return `The jar was read but is not a usable session (${counts})${why}.`;
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
    source: describeCookies(settings),
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
  const jar = cookieJar(settings);
  if (isMisconfigured(settings)) {
    return {
      ...empty,
      ok: false,
      problems: [
        settings.cookiesMode === "file"
          ? "No cookies.txt path is set."
          : "The pasted cookie jar is empty.",
      ],
      note: `Cookie mode is "${settings.cookiesMode}" but nothing is configured.`,
    };
  }

  try {
    // The same jar the pipeline sends, tested the same way — that is what makes the button
    // worth pressing. A pasted jar is parsed inline; a path is read inside the container.
    const result: CookiesTestResult = await box().testCookies({
      ...(jar.path === undefined ? {} : { path: jar.path }),
      ...(jar.content === undefined ? {} : { content: jar.content }),
    });
    return {
      ...empty,
      ok: result.ok,
      cookies: result.cookies,
      domains: result.domains,
      authenticated: result.authenticated,
      expiresAt: result.expires_at ?? null,
      expired: result.expired,
      problems: result.problems ?? [],
      note: result.ok
        ? `A usable YouTube session (${String(result.cookies)} cookie(s), ${String(result.domains.length)} domain(s)${result.expires_at === null ? "" : `, lapses ${result.expires_at}`}).`
        : unusableJarSentence(result),
    };
  } catch (error) {
    return {
      ...empty,
      ok: false,
      problems: [MMError.from(error).message],
      note:
        settings.cookiesMode === "file"
          ? "The toolbox could not read the cookie file."
          : "The toolbox could not parse the pasted jar.",
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
 *
 * **These calls do not go through `getJson`**, on purpose: a probe wants the raw status, not a
 * retry ladder and not an `MMError`. What they must not skip is the *budget*. Both MusicBrainz
 * probes are served by MusicBrainz, and `Promise.all` fired them in the same instant from the
 * shared User-Agent — two requests in one second, every time somebody opened the Tools page,
 * invisible to the installation-wide gate of decision 164. `gated` puts them back inside it.
 */
export async function serviceLatencies(deps: ToolsDeps = {}): Promise<ServiceLatency[]> {
  const { settings } = await resolve(deps);
  const config = sourcesConfig(settings);
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  // One gate for both MusicBrainz probes, and it is the same row every other caller reserves
  // from — so opening this page while an import is matching costs the import one second, which
  // is the honest price rather than a hidden 503.
  const mb = gateFor(deps.db, "musicbrainz", MB_MIN_INTERVAL_MS);

  const probes: {
    name: string;
    label: string;
    url: string;
    note: string;
    /** A 4xx that still proves the service answered — an unauthenticated ping, typically. */
    acceptClientError?: boolean;
    /** Reserve a departure slot before measuring. MusicBrainz's two probes share one. */
    gated?: boolean;
  }[] = [
    {
      name: "musicbrainz",
      label: "MusicBrainz",
      url: `${MUSICBRAINZ_BASE}/release?query=%2A&limit=1&fmt=json`,
      note: "1 req/s, User-Agent required",
      gated: true,
    },
    {
      name: "coverartarchive",
      label: "Cover Art Archive",
      url: `${CAA_BASE}/release/00000000-0000-0000-0000-000000000000`,
      note:
        "404 on a bogus MBID means the index answered — MusicBrainz serves it, so it " +
        "shares the same 1 req/s budget",
      acceptClientError: true,
      gated: true,
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
      if (enabled && probe.gated === true) await mb.acquire();
      // After the gate, never before: a latency that included a second of waiting for our own
      // budget would say the service is slow when it is us being polite.
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
  /**
   * What the source listed and could not be read. Empty for a healthy URL.
   *
   * This box is where the owner's twenty playlists were first misread: it answered
   * `entries: 0` and "This video is not available" for an album that was perfectly alive and
   * had merely lost one of its twenty videos. `entries` alone cannot tell "an empty playlist"
   * from "a playlist we only half read", so the pair is reported.
   */
  readonly unreadable: readonly {
    readonly position: number | null;
    readonly id: string | null;
    readonly reason: string | null;
    readonly code: string;
  }[];
  /** `entries + unreadable.length` — the "of 20" in "19 of 20 entries". */
  readonly listed: number;
  readonly durationMs: number;
  readonly sample: readonly {
    readonly title: string;
    readonly duration: number | null;
    /** This entry's description carries the "Provided to YouTube by" line. */
    readonly official: boolean;
    /** The album this entry says it belongs to — the YT Music tag, else the description. */
    readonly album: string | null;
  }[];
  /**
   * Is this source an official, distributor-uploaded one?
   *
   * True when **every** entry carries the "Provided to YouTube by" line, which is the question
   * `officialUploadsOnly` asks — a playlist with one rip in it is not a source that rule would
   * let through whole. `officialEntries` is the count behind it, so a caller can tell "none of
   * them" from "eleven of twelve" without reading the sample.
   */
  readonly official: boolean;
  readonly officialEntries: number;
  /**
   * Would the rules currently switched on let this URL in?
   *
   * Evaluated against the installation's own settings, so a client can ask **before** importing
   * and get the same answer `resolve` would give it. `reason` is empty when nothing refuses it.
   */
  readonly admissible: boolean;
  readonly refusedReason: string;
  readonly rules: { readonly officialUploadsOnly: boolean; readonly requireAlbum: boolean };
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
 *
 * It is also where "is this source official?" is answered **before** anything is imported.
 * That question goes here rather than on a new endpoint of its own for one reason: this route
 * already makes the only call that can answer it. `/extract` is what reads the descriptions,
 * it is already a dry run, it already authenticates with the installation's session, and it is
 * already the thing a client calls to ask "what would this URL import?". A second endpoint
 * would be the same round-trip under a second name, and the first caller to use both would pay
 * for two extractions to learn one thing.
 */
export async function testUrl(url: string, deps: ToolsDeps = {}): Promise<UrlTest> {
  const { box, settings } = await resolve(deps);
  const started = Date.now();
  const rules = sourceRulesOf(settings);
  try {
    // With the installation's own session: a dry run that authenticates differently from
    // the pipeline would answer a question nobody asked.
    const result = await box().extract(url, cookieJar(settings));
    const entries = result.entries;
    const unreadable = gapsOf(result);
    const officialEntries = entries.filter((entry) => isOfficialUpload(entry)).length;
    // The same "isolated" the `resolve` step decides, from the same fact — and counted the same
    // way, gaps included, so the dry run cannot disagree with the import it is predicting.
    const isolated = result.kind === "video" || listedCount(result) <= 1;
    const refused = entries
      .map((entry) => admit(entry, rules, { isolated }))
      .find((verdict) => !verdict.accept);
    return {
      url,
      ok: true,
      kind: result.kind,
      title: result.title ?? "",
      entries: entries.length,
      unreadable,
      listed: listedCount(result),
      durationMs: Date.now() - started,
      sample: entries.slice(0, 5).map((entry) => ({
        title: entry.title,
        duration: entry.duration ?? null,
        official: isOfficialUpload(entry),
        album: attachedAlbum(entry),
      })),
      official: entries.length > 0 && officialEntries === entries.length,
      officialEntries,
      admissible: refused === undefined,
      refusedReason: refused?.reason ?? "",
      rules,
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
      unreadable: [],
      listed: 0,
      durationMs: Date.now() - started,
      sample: [],
      official: false,
      officialEntries: 0,
      admissible: false,
      refusedReason: "",
      rules,
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
  // Newest rows first off the primary key, then back to chronological order: `LogViewer` is a
  // terminal that auto-scrolls to the bottom, so it wants oldest-first, but the *window* must
  // be the most recent `limit` lines — `readEvents({ limit })` used to hand back the oldest
  // ones instead, because it has no `since` and orders ascending from the very first row.
  const latest = await readLatestEvents({ limit: options.limit ?? 200 }, db());
  const tail = [...latest].reverse();
  return options.level === "error" ? tail.filter((row) => row.level !== "info") : tail;
}

/** Where the toolbox is, for the "connected to" line. Never a token. */
export function toolboxTarget(deps: ToolsDeps = {}): { url: string; authenticated: boolean } {
  const box = deps.toolbox ?? defaultToolbox();
  return { url: box.baseUrl, authenticated: serverEnv().MM_TOOLBOX_TOKEN !== "" };
}
