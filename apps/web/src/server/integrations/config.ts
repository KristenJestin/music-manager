/**
 * What the source clients need to know before they can call anything: the credentials, the
 * User-Agent, which sources are on, and how long an answer stays good.
 *
 * Credentials have **one canonical name each** and two places to live. The `settings` table
 * wins when it holds a non-empty value — that is what the Console will edit — and the
 * environment is the default, which is what a container gets. `MM_ACOUSTID_KEY` is the name
 * the toolbox already reads (`services/toolbox/src/toolbox/config.py`), so it is the name
 * used here too: one key, one spelling, on both sides of the bridge.
 */
import type { Database } from "#/server/db/client.ts";
import type { CacheStore } from "./cached.ts";
import { serverEnv } from "#/server/env.ts";
import { APP_VERSION } from "#/server/version.ts";
import { SOURCE_NAMES, type Settings, type SourceName } from "#/server/services/settings.ts";

export { SOURCE_NAMES, type SourceName };

const DAY_MS = 86_400_000;

export interface SourcesConfig {
  /** `MusicManager/<version> ( <contact> )` — §4 requires a contact in the User-Agent. */
  readonly userAgent: string;
  readonly contact: string;
  readonly acoustidKey: string;
  readonly lastfmKey: string;
  readonly fanartKey: string;
  readonly enabled: Readonly<Record<SourceName, boolean>>;
  /** Milliseconds, 0 = never expires. */
  readonly ttlMs: Readonly<Record<SourceName, number>>;
  readonly maxGenres: number;
  readonly genrePreference: readonly ("musicbrainz" | "lastfm" | "listenbrainz")[];
  readonly genreMinCount: number;
  readonly coverOrder: readonly ("coverartarchive" | "youtube")[];
  readonly coverMaxBytes: number;
  readonly artworkSize: number;
  readonly lyricsMaxDurationDelta: number;
  readonly writeAcoustidFingerprint: boolean;
}

/**
 * MusicBrainz refuses anonymous clients and rate-limits per client string, so a contact is
 * not decoration. Without one we still send a usable agent naming the project, which is what
 * their guidance asks for when no operator address exists.
 */
export function userAgentFor(contact: string): string {
  const trimmed = contact.trim();
  return trimmed === ""
    ? `MusicManager/${APP_VERSION} ( https://github.com/music-manager )`
    : `MusicManager/${APP_VERSION} ( ${trimmed} )`;
}

/** Settings first, environment second, for one credential. */
function credential(fromSettings: string, fromEnv: string | undefined): string {
  const chosen = fromSettings.trim() === "" ? (fromEnv ?? "") : fromSettings;
  return chosen.trim();
}

export function sourcesConfig(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): SourcesConfig {
  const contact = credential(settings.mbContact, env.MM_MB_CONTACT);
  const ttlMs = {} as Record<SourceName, number>;
  for (const name of SOURCE_NAMES) ttlMs[name] = settings.sourceTtlDays[name] * DAY_MS;

  return {
    contact,
    userAgent: userAgentFor(contact),
    acoustidKey: credential(settings.acoustidKey, env.MM_ACOUSTID_KEY),
    lastfmKey: credential(settings.lastfmKey, env.MM_LASTFM_KEY),
    fanartKey: credential(settings.fanartKey, env.MM_FANARTTV_KEY),
    enabled: settings.sourcesEnabled,
    ttlMs,
    maxGenres: settings.maxGenres,
    genrePreference: settings.genrePreference,
    genreMinCount: settings.genreMinCount,
    coverOrder: settings.coverOrder,
    coverMaxBytes: settings.coverMaxBytes,
    artworkSize: settings.artworkSize,
    lyricsMaxDurationDelta: settings.lyricsMaxDurationDelta,
    writeAcoustidFingerprint: settings.writeAcoustidFingerprint,
  };
}

/**
 * Everything a client call needs: where to write what it learns, whether it may speak, and
 * the configuration. One object rather than eight parameters, rebuilt per document build.
 */
export interface SourceContext {
  readonly db: Database;
  /**
   * Where cached bodies go. Defaults to the `source_cache` table; the cassette tests pass an
   * in-memory one so a client can be proven without a database container.
   */
  readonly store?: CacheStore;
  readonly config: SourcesConfig;
  /** No outgoing request is allowed; a cache miss is an error (see ./cached.ts). */
  readonly offline: boolean;
  /** Refetch even when the cached row is young. */
  readonly refresh: boolean;
  readonly signal?: AbortSignal;
  /** Injected by the tests so a backoff costs no real seconds. */
  readonly wait?: (ms: number) => Promise<void>;
}

/** True when `source` may be called at all. */
export function enabled(ctx: SourceContext, source: SourceName): boolean {
  return ctx.config.enabled[source];
}

/** The environment names P04 reads, for `.env.example` and for the CLI's help. */
export const SOURCE_ENV_KEYS = [
  "MM_MB_CONTACT",
  "MM_ACOUSTID_KEY",
  "MM_LASTFM_KEY",
  "MM_FANARTTV_KEY",
] as const;

/** Used by `mm doc` to say which credentials are present without ever printing one. */
export function credentialReport(config: SourcesConfig): Record<string, string> {
  const state = (value: string): string => (value === "" ? "not set" : "set");
  return {
    "musicbrainz contact": state(config.contact),
    acoustid: state(config.acoustidKey),
    lastfm: state(config.lastfmKey),
    "fanart.tv": state(config.fanartKey),
  };
}

/** The environment as `serverEnv` sees it, so callers do not import two modules for it. */
export function envDefaults(): Record<string, string | undefined> {
  serverEnv();
  return process.env;
}
