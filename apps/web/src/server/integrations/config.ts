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
import { MMError } from "@mm/contracts";
import type { ArtistNameSource, LocalePreference } from "@mm/domain";
import type { Database } from "#/server/db/client.ts";
import type { CacheStore } from "./cached.ts";
import { serverEnv } from "#/server/env.ts";
import { APP_VERSION } from "#/server/version.ts";
import { SOURCE_NAMES, type Settings, type SourceName } from "#/server/services/settings.ts";

export { SOURCE_NAMES, type SourceName };

const DAY_MS = 86_400_000;

/**
 * Where a credential actually came from.
 *
 * The Console used to show an empty Contact field while every MusicBrainz request carried
 * `MM_MB_CONTACT`, and told you "the key was accepted" about a key it never named (owner
 * review B7 and B8). A page that shows a value must be able to say where it got it.
 */
export type CredentialOrigin = "settings" | "environment" | "none";

export type CredentialName = "contact" | "acoustidKey" | "lastfmKey" | "fanartKey";

/** How the Console names the source of a credential, in one place. */
export const CREDENTIAL_ENV_KEY: Readonly<Record<CredentialName, string>> = {
  contact: "MM_MB_CONTACT",
  acoustidKey: "MM_ACOUSTID_KEY",
  lastfmKey: "MM_LASTFM_KEY",
  fanartKey: "MM_FANARTTV_KEY",
};

export interface SourcesConfig {
  /** `MusicManager/<version> ( <contact> )` — §4 requires a contact in the User-Agent. */
  readonly userAgent: string;
  readonly contact: string;
  readonly acoustidKey: string;
  readonly lastfmKey: string;
  readonly fanartKey: string;
  /** Settings, environment, or nothing — per credential. Never the value itself. */
  readonly origin: Readonly<Record<CredentialName, CredentialOrigin>>;
  readonly enabled: Readonly<Record<SourceName, boolean>>;
  /** Milliseconds, 0 = never expires. */
  readonly ttlMs: Readonly<Record<SourceName, number>>;
  /** `credit.name` or `credit.artist.name` in ARTIST, ARTISTS and ALBUMARTIST. */
  readonly artistNameSource: ArtistNameSource;
  /**
   * Picard's “translate names to this locale”, resolved into the shape the resolvers take.
   *
   * `artists` and `albums` are separate switches on purpose — somebody wants Yuki Kajiura on
   * every track without their album folders being renamed, and `ALBUM` feeds the path
   * template. `undefined` when the locale is empty, which is the default and translates
   * nothing at all.
   */
  readonly locale: LocalePreference | undefined;
  /** `prefer` spends one extra MusicBrainz search per album to romanise track titles. */
  readonly aliasPseudoRelease: "off" | "prefer";
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
 * MusicBrainz rate-limits per client string, so a contact is not decoration.
 *
 * Without one this used to send `MusicManager/<version> ( https://github.com/music-manager )`,
 * which is the *same* string for every installation of this application on earth. MusicBrainz
 * counts a User-Agent, not an IP: an anonymous agent shared by every deployment is one bucket
 * that everyone draws from, and the ones drawing from it are throttled hardest. It is a
 * plausible contributor to the session in which forty-five albums were refused with 503 while
 * this installation's own gate was spacing its requests perfectly at one a second.
 *
 * The fallback is kept, because the string still has to exist — a `SourcesConfig` is built on
 * every offline path, every fixtures run and every settings page render, and throwing here
 * would turn a missing setting into a process that cannot start. The refusal happens one layer
 * out, at the moment a request is actually about to leave (`requireContact`), where it can say
 * something useful and where being offline costs nothing.
 */
export function userAgentFor(contact: string): string {
  const trimmed = contact.trim();
  return trimmed === ""
    ? `MusicManager/${APP_VERSION} ( https://github.com/music-manager )`
    : `MusicManager/${APP_VERSION} ( ${trimmed} )`;
}

/** True when this configuration would send the shared, anonymous User-Agent. */
export function isAnonymous(config: SourcesConfig): boolean {
  return config.contact.trim() === "";
}

/**
 * Refuse to make a MusicBrainz request with nobody's name on it.
 *
 * Called by the MusicBrainz and Cover Art Archive clients immediately before an outgoing
 * request — never before a cache read, never in fixtures mode, never while building the
 * configuration — so an offline installation with no contact goes on working exactly as it
 * did. What changes is that a *live* lookup now fails with a sentence naming the setting and
 * the environment variable, instead of leaving anonymously and being throttled for it.
 *
 * `MB_CONTACT_MISSING` is deliberately outside the upstream family: `classifyFailure` lists it
 * as a defect, so an import blocked on it fails fast and asks for a human rather than retrying
 * six times against a wall that only a settings change can move.
 */
export function requireContact(config: SourcesConfig): void {
  if (!isAnonymous(config)) return;
  throw new MMError(
    "MB_CONTACT_MISSING",
    "MusicBrainz requires a contact in the User-Agent, and none is configured.",
    {
      hint:
        "Set it in Settings › Metadata (`mbContact`), or in the environment as " +
        "`MM_MB_CONTACT` — an email address or a URL you answer at. Without one every " +
        "installation of this application shares a single anonymous User-Agent, which is the " +
        "one MusicBrainz throttles hardest.",
      action: "Set mbContact",
      details: { setting: "mbContact", env: CREDENTIAL_ENV_KEY.contact },
      // A wait will not produce a contact. Only a person will.
      retryable: false,
    },
  );
}

/** Settings first, environment second, for one credential — and which of the two won. */
function credential(
  fromSettings: string,
  fromEnv: string | undefined,
): { value: string; origin: CredentialOrigin } {
  if (fromSettings.trim() !== "") return { value: fromSettings.trim(), origin: "settings" };
  const fromEnvironment = (fromEnv ?? "").trim();
  if (fromEnvironment !== "") return { value: fromEnvironment, origin: "environment" };
  return { value: "", origin: "none" };
}

export function sourcesConfig(
  settings: Settings,
  env: Record<string, string | undefined> = process.env,
): SourcesConfig {
  const contact = credential(settings.mbContact, env.MM_MB_CONTACT);
  const acoustid = credential(settings.acoustidKey, env.MM_ACOUSTID_KEY);
  const lastfm = credential(settings.lastfmKey, env.MM_LASTFM_KEY);
  const fanart = credential(settings.fanartKey, env.MM_FANARTTV_KEY);
  const ttlMs = {} as Record<SourceName, number>;
  for (const name of SOURCE_NAMES) ttlMs[name] = settings.sourceTtlDays[name] * DAY_MS;

  return {
    contact: contact.value,
    userAgent: userAgentFor(contact.value),
    acoustidKey: acoustid.value,
    lastfmKey: lastfm.value,
    fanartKey: fanart.value,
    origin: {
      contact: contact.origin,
      acoustidKey: acoustid.origin,
      lastfmKey: lastfm.origin,
      fanartKey: fanart.origin,
    },
    enabled: settings.sourcesEnabled,
    ttlMs,
    artistNameSource: settings.artistNameSource,
    // One object rather than two settings passed around: `undefined` is the off switch, so a
    // caller that forgets to look at `preferredLocale` cannot accidentally translate anything.
    locale:
      settings.preferredLocale === ""
        ? undefined
        : {
            locale: settings.preferredLocale,
            onlyNonLatin: settings.aliasTranslateOnlyNonLatin,
            artists: settings.aliasTranslateArtists,
            albums: settings.aliasTranslateAlbums,
          },
    aliasPseudoRelease: settings.aliasPseudoRelease,
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
