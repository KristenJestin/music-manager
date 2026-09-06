/**
 * The typed settings store.
 *
 * One registry, one entry per key: a zod schema, a default taken from the specification, and
 * a sentence saying what it is for. Reading an unknown key is a programming error; reading a
 * key whose stored row no longer parses falls back to the default and says so in the log
 * rather than letting a hand-edited row crash the worker three steps later.
 *
 * Defaults are *not* written to the database on read. A row exists only once someone has
 * chosen a value, so raising a default in a later version applies to everyone who never
 * overrode it — which is what a default is for.
 */
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { notifiableEventSchema, type NotifiableEvent } from "@mm/contracts";
import {
  DEFAULT_PATH_TEMPLATE,
  DEFAULT_WEIGHTS,
  DISC_MODES,
  validatePathTemplate,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { settings as settingsTable } from "#/server/db/schema/index.ts";

/** One knob: how to parse it, what it is worth when nobody said, and why it exists. */
interface SettingDefinition<T> {
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly doc: string;
  /** A credential. Never shown in full by the CLI, the API or a log (P04). */
  readonly secret?: boolean;
}

function define<T>(
  schema: z.ZodType<T>,
  value: T,
  doc: string,
  options: { secret?: boolean } = {},
): SettingDefinition<T> {
  return { schema, default: value, doc, ...(options.secret === true ? { secret: true } : {}) };
}

const sanitizeMode = z.enum(["unicode", "windows", "strict"]);
const onExists = z.enum(["skip", "overwrite", "keep_both"]);

/** The eight external sources of `docs/03-metadonnees.md` §4 that P04 speaks to. */
export const SOURCE_NAMES = [
  "musicbrainz",
  "coverartarchive",
  "acoustid",
  "lrclib",
  "deezer",
  "lastfm",
  "listenbrainz",
  "wikimedia",
] as const;

export type SourceName = (typeof SOURCE_NAMES)[number];

const sourceFlags = z.object({
  musicbrainz: z.boolean(),
  coverartarchive: z.boolean(),
  acoustid: z.boolean(),
  lrclib: z.boolean(),
  deezer: z.boolean(),
  lastfm: z.boolean(),
  listenbrainz: z.boolean(),
  wikimedia: z.boolean(),
});

const sourceDays = z.object({
  musicbrainz: z.number().min(0),
  coverartarchive: z.number().min(0),
  acoustid: z.number().min(0),
  lrclib: z.number().min(0),
  deezer: z.number().min(0),
  lastfm: z.number().min(0),
  listenbrainz: z.number().min(0),
  wikimedia: z.number().min(0),
});

/**
 * The registry. Grouped by the part of the pipeline they steer; the names are the ones the
 * Console will show, so they are `camelCase` and speak of behaviour, not of implementation.
 */
export const SETTING_DEFINITIONS = {
  /* ---- download pacing (docs/04 § Étapes, `download`) ---- */
  downloadJitterMinMs: define(
    z.number().int().min(0),
    5_000,
    "Lower bound of the pause between two downloads. YouTube dislikes a metronome.",
  ),
  downloadJitterMaxMs: define(
    z.number().int().min(0),
    15_000,
    "Upper bound of the pause between two downloads.",
  ),
  downloadMaxAttempts: define(
    z.number().int().min(1).max(10),
    3,
    "How many times one track is retried before the step gives up on it.",
  ),
  downloadBackoffBaseMs: define(
    z.number().int().min(0),
    5_000,
    "First backoff after a failed download; doubles on each further attempt.",
  ),
  downloadBackoffMaxMs: define(
    z.number().int().min(0),
    300_000,
    "Ceiling of the exponential backoff.",
  ),
  downloadFormat: define(
    z.string().min(1),
    "bestaudio",
    "yt-dlp format selector. Never re-encode.",
  ),

  /* ---- matching and confirmation (docs/04 § Algorithme) ---- */
  safeThreshold: define(
    z.number().min(0).max(1),
    0.95,
    "Score above which a candidate is marked safe. It never skips the confirmation.",
  ),
  titleMatchThreshold: define(
    z.number().min(0).max(1),
    0.87,
    "Normalised title similarity above which two titles are considered the same work.",
  ),
  preferredCountries: define(
    z.array(z.string().length(2).or(z.literal("XW"))),
    ["XW", "FR", "GB", "US"],
    "Release-country preference order, best first.",
  ),
  preferredFormat: define(
    z.string(),
    "Digital Media",
    "Preferred medium format for a YouTube source.",
  ),
  explicitPreference: define(
    z.enum(["either", "explicit", "clean"]),
    "either",
    "Which of an explicit/clean pair to prefer.",
  ),
  matchAmbiguityMargin: define(
    z.number().min(0).max(1),
    0.04,
    "Two candidates closer than this are ambiguous: the Inbox asks instead of the engine guessing.",
  ),
  matchBindingFloor: define(
    z.number().min(0).max(1),
    0.35,
    "A video/track pair below this is not bound at all; the video becomes an extra.",
  ),
  matchDurationTolerance: define(
    z.number().min(0).max(60),
    2,
    "Seconds a video and a track may differ by and still count as the same length.",
  ),
  matchLookupLimit: define(
    z.number().int().min(1).max(25),
    6,
    "How many release candidates get a tracklist lookup, which is what the fit needs.",
  ),
  matchSearchLimit: define(
    z.number().int().min(1).max(100),
    25,
    "How many results one MusicBrainz search asks for. A match makes at most two of them.",
  ),
  matchReleaseWeights: define(
    z.object({
      title: z.number().min(0),
      artist: z.number().min(0),
      trackCount: z.number().min(0),
      durations: z.number().min(0),
      year: z.number().min(0),
      label: z.number().min(0),
      format: z.number().min(0),
      status: z.number().min(0),
      country: z.number().min(0),
    }),
    DEFAULT_WEIGHTS.release,
    "Weight of each release signal. The tracklist fit (`durations`) is the decisive one.",
  ),
  matchRecordingWeights: define(
    z.object({
      title: z.number().min(0),
      artist: z.number().min(0),
      duration: z.number().min(0),
      ytTags: z.number().min(0),
      isrc: z.number().min(0),
    }),
    DEFAULT_WEIGHTS.recording,
    "Weight of each recording signal, for a lone video.",
  ),
  matchMappingWeights: define(
    z.object({
      title: z.number().min(0),
      duration: z.number().min(0),
      position: z.number().min(0),
      ytTrackTag: z.number().min(0),
      acoustid: z.number().min(0),
    }),
    DEFAULT_WEIGHTS.mapping,
    "Weight of each signal when binding one video to one track.",
  ),

  /* ---- learned preferences (docs/04 § decisions) ---- */
  learnPreferences: define(
    z.boolean(),
    true,
    "Let confirmed releases nudge the country and format preferences. Never silently: what was learned is listed here.",
  ),
  learnedFrom: define(
    z.number().int().min(0),
    0,
    "How many confirmed releases the current preferences were learned from. Read-only.",
  ),

  /* ---- fingerprint (decision 011) ---- */
  verifyFingerprint: define(
    z.boolean(),
    true,
    "Run the fingerprint safety net and pause the job when it disagrees with the mapping.",
  ),
  fingerprintMinScore: define(
    z.number().min(0).max(1),
    0.5,
    "Ignore AcoustID candidates below this score; they are noise, not a disagreement.",
  ),

  /* ---- tagging and sidecars (docs/03 §3) ---- */
  writeLyricsSidecar: define(z.boolean(), true, "Write `<track>.lrc` next to the file."),
  writeCover: define(z.boolean(), true, "Write `cover.jpg` in the album folder."),
  embedArtwork: define(z.boolean(), true, "Embed the front cover in the audio file itself."),
  artworkSize: define(z.number().int().min(16).max(4000), 1200, "Longest side of `cover.jpg`."),
  replayGain: define(z.boolean(), true, "Run rsgain per album once every track is present."),
  replayGainReferenceLoudness: define(z.number(), -18, "rsgain's reference loudness, in LUFS."),

  /* ---- placement (docs/04 § Étapes, `place`) ---- */
  pathTemplate: define(
    z.string().refine((value) => validatePathTemplate(value).ok, {
      message:
        "unusable template — every token must exist and {title} must appear, or two tracks of an album would share a file name",
    }),
    DEFAULT_PATH_TEMPLATE,
    "Where a track is filed, as a template. The default is the layout `packages/domain/paths` ships, byte for byte. Tokens: {albumArtist} {album} {year} {disc} {disc-} {track} {track:02} {title} {artist} {ext} {mbid}.",
  ),
  discMode: define(
    z.enum(DISC_MODES),
    "prefix",
    "How a multi-disc release is numbered: `prefix` (1-01), `folder` (Disc 1/01) or `continuous` (numbered straight through).",
  ),
  sanitizeMode: define(
    sanitizeMode,
    "windows",
    "How aggressively file names are sanitised. `windows` also serves SMB shares safely.",
  ),
  onExists: define(
    onExists,
    "skip",
    "What `place` does when the destination is already taken. `--force` overrides it.",
  ),
  maxSegmentLength: define(
    z.number().int().min(32).max(255),
    200,
    "Longest single path segment, leaving room for sidecar suffixes.",
  ),

  /* ---- external sources (docs/03 §4, P04) ---- */
  mbContact: define(
    z.string(),
    "",
    "Contact put in the MusicBrainz User-Agent, as §4 requires. Empty means: take MM_MB_CONTACT.",
  ),
  acoustidKey: define(
    z.string(),
    "",
    "AcoustID application key. Empty means: take MM_ACOUSTID_KEY.",
    { secret: true },
  ),
  lastfmKey: define(z.string(), "", "Last.fm API key. Empty means: take MM_LASTFM_KEY.", {
    secret: true,
  }),
  fanartKey: define(
    z.string(),
    "",
    "fanart.tv API key, the fallback for artist images. Empty means: take MM_FANARTTV_KEY.",
    { secret: true },
  ),
  sourcesEnabled: define(
    sourceFlags,
    {
      musicbrainz: true,
      coverartarchive: true,
      acoustid: true,
      lrclib: true,
      deezer: true,
      lastfm: true,
      listenbrainz: true,
      wikimedia: true,
    },
    "Which of the eight sources of §4 may be called. A disabled source is simply not asked.",
  ),
  sourceTtlDays: define(
    sourceDays,
    {
      // MusicBrainz edits land constantly, so a month; a cover index and a fingerprint
      // essentially never change, so never. 0 means "never expires" (§1: nothing is purged).
      musicbrainz: 30,
      coverartarchive: 90,
      acoustid: 0,
      lrclib: 14,
      deezer: 90,
      lastfm: 30,
      listenbrainz: 30,
      wikimedia: 180,
    },
    "Days after which a stored source answer is refreshed. 0 = never. Rows are never deleted.",
  ),
  coverOrder: define<("coverartarchive" | "youtube")[]>(
    z.array(z.enum(["coverartarchive", "youtube"])),
    ["coverartarchive", "youtube"],
    "Where a front cover is looked for, best first. The YouTube thumbnail is the §4 fallback.",
  ),
  coverMaxBytes: define(
    z.number().int().min(0),
    8_000_000,
    "Refuse a cover file larger than this. 0 disables the check.",
  ),
  genrePreference: define<("musicbrainz" | "lastfm" | "listenbrainz")[]>(
    z.array(z.enum(["musicbrainz", "lastfm", "listenbrainz"])),
    ["musicbrainz", "lastfm", "listenbrainz"],
    "Which source's genres win. §4: MusicBrainz first, Last.fm and ListenBrainz as fallbacks.",
  ),
  maxGenres: define(
    z.number().int().min(1).max(10),
    3,
    "How many GENRE values a track carries at most.",
  ),
  genreMinCount: define(
    z.number().int().min(0),
    1,
    "Ignore a community tag with fewer votes than this; below it, tags are noise.",
  ),
  writeAcoustidFingerprint: define(
    z.boolean(),
    false,
    "Write the raw Chromaprint into ACOUSTID_FINGERPRINT. §2.5: bulky, so opt-in.",
  ),
  lyricsMaxDurationDelta: define(
    z.number().int().min(0),
    2,
    "Widest accepted difference, in seconds, between a LRCLIB result and the track.",
  ),

  /* ---- the versioned tag schema (docs/03 §8, P07) ---- */
  tagSchemaVersionOverride: define(
    z.number().int().min(0),
    0,
    "Pretend the tag schema is at this version instead of the one compiled in. 0 = off. It exists so §8's background re-tag can be exercised end to end without recompiling the domain package; a real installation never sets it.",
  ),
  retagBatchSize: define(
    z.number().int().min(1).max(500),
    25,
    "How many files one `retag` queue job re-projects before handing the queue back. Small enough that a cancel is felt quickly, large enough that the overhead is not the work.",
  ),
  sourcesRefreshEnabled: define(
    z.boolean(),
    true,
    "Let the weekly `sources.refresh` cron re-fetch MusicBrainz entities that changed upstream and queue the albums they touch for a re-tag.",
  ),

  /* ---- the Console itself (P06) ---- */
  trustedOrigins: define(
    z.array(z.string()),
    [],
    "Extra origins the Console may be reached from, beyond MM_WEB_URL — the public URL of a reverse proxy, say. Wildcards like `https://*.example.com` are allowed.",
  ),

  /* ---- the downloader (P07, Settings → Downloader) ---- */
  ytdlpAutoUpdate: define(
    z.boolean(),
    true,
    "Refresh yt-dlp on a schedule. Decision 012: a stale downloader is the single largest cause of breakage.",
  ),
  ytdlpUpdateCron: define(
    z.string().min(1),
    "0 4 * * *",
    "When the `cron.ytdlp-update` job runs, as a five-field cron expression.",
  ),
  ytdlpChannel: define(
    z.enum(["stable", "nightly", "master"]),
    "stable",
    "Which yt-dlp release channel `--update-to` follows.",
  ),
  ytdlpPin: define(
    z.string(),
    "",
    "Pin yt-dlp to one version (`2025.08.11`). Empty means: follow the channel.",
  ),
  ytdlpOnUpdateFailure: define(
    z.enum(["warn", "pause_downloads", "rollback"]),
    "warn",
    "What happens when an auto-update fails: raise an Inbox item, stop downloading, or go back to the previous build.",
  ),
  cookiesMode: define(
    z.enum(["anonymous", "file"]),
    "anonymous",
    "How yt-dlp authenticates. `anonymous` is the default and needs nothing; `file` uses a Netscape cookies.txt.",
  ),
  cookiesFile: define(
    z.string(),
    "",
    "Path to the `cookies.txt`, as this process sees it. Only read when `cookiesMode` is `file`.",
  ),
  downloadProxy: define(
    z.string(),
    "",
    "Proxy yt-dlp downloads through this URL (`http://host:port`, `socks5://…`). Empty means: direct.",
  ),
  ytdlpPlayerClient: define(
    z.string(),
    "",
    "yt-dlp `player_client` extractor argument (`web_safari`, `android,web`). Empty means: yt-dlp's own default.",
  ),
  ytdlpExtraArgs: define(
    z.array(z.string()),
    [],
    "Extra yt-dlp command-line arguments, one per entry. An escape hatch, not a habit.",
  ),

  /* ---- Navidrome (docs/03-metadonnees.md §7, decision 009) ---- */
  navidromeEnabled: define(
    z.boolean(),
    false,
    "Read every placed album back through OpenSubsonic. Off means the `verify` step only checks the files exist.",
  ),
  navidromeUrl: define(
    z.string(),
    "",
    "Base URL of the Navidrome server, without `/rest` (`http://localhost:4533`).",
  ),
  navidromeUser: define(z.string(), "", "Navidrome user the read-back authenticates as."),
  navidromePassword: define(
    z.string(),
    "",
    "That user's password. Sent as the Subsonic token+salt pair, never in clear.",
    { secret: true },
  ),
  navidromeRescanOnVerify: define(
    z.boolean(),
    true,
    "Ask Navidrome to scan before reading an album back. Off when a cron already scans often enough.",
  ),
  navidromeWaitTimeoutMs: define(
    z.number().int().min(1_000).max(3_600_000),
    240_000,
    "How long the `verify` step waits for a scan to finish before giving up on it.",
  ),

  /* ---- the library scan (P07) ---- */
  scanEnabled: define(z.boolean(), true, "Run the nightly library scan."),
  scanCron: define(
    z.string().min(1),
    "0 3 * * *",
    "When the nightly `cron.scan` runs, as a five-field cron expression.",
  ),
  scanIdentifyOrphans: define(
    z.boolean(),
    false,
    "Fingerprint orphan files during the scan and propose an AcoustID identification. Costs one call per file.",
  ),
  trashDir: define(
    z.string(),
    ".local/trash",
    "Where a deleted file goes. Nothing is ever unlinked: `delete` is a move into this directory.",
  ),

  /*
   * ---- notifications (P07b stored them, P08 delivers them) ----
   *
   * P07b defined these four keys with a placeholder vocabulary (`job_failed`, `inbox_opened`,
   * …) and said in as many words that the transports arrive in P08. They do, and the event
   * names are now the five of `docs/phases/P08-api-agents.md` — the same five a *webhook*
   * subscribes to, shared from `@mm/contracts` so a notification and a webhook can never
   * disagree about what "an import finished" is called.
   *
   * `webhook` is gone from the channel list on purpose. A generic signed HTTP callback is no
   * longer a notification *channel*; it is the `webhooks` table, which has retries, an HMAC
   * signature and a delivery log. Leaving a second, worse implementation of it here would
   * have made "which of the two do I use?" a question with no good answer.
   */
  notificationsEnabled: define(
    z.boolean(),
    false,
    "Announce finished imports, failures and Inbox items on one channel.",
  ),
  notificationsChannel: define(
    z.enum(["none", "ntfy", "discord", "email"]),
    "none",
    "Where a notification goes. Signed HTTP callbacks are webhooks, configured separately.",
  ),
  notificationsTarget: define(
    z.string(),
    "",
    "The ntfy topic URL, the Discord webhook URL, or the destination e-mail address.",
    { secret: true },
  ),
  notificationsEvents: define<NotifiableEvent[]>(
    z.array(notifiableEventSchema),
    ["import.failed", "review.needed"],
    "Which events are worth a notification.",
  ),
  /* ---- SMTP, for `notificationsChannel: "email"` ---- */
  smtpHost: define(z.string(), "", "SMTP server host. Empty disables the e-mail channel."),
  smtpPort: define(z.number().int().min(1).max(65_535), 587, "SMTP port. 465 implies TLS."),
  smtpUser: define(z.string(), "", "SMTP username. Empty sends unauthenticated."),
  smtpPassword: define(z.string(), "", "SMTP password.", { secret: true }),
  smtpFrom: define(z.string(), "", "The `From:` address. Defaults to the SMTP user."),
  smtpTls: define(z.boolean(), true, "Use STARTTLS (or implicit TLS on port 465)."),

  /* ---- the library, on both sides of the bridge ---- */
  libraryRoot: define(
    z.string(),
    "",
    "Library root as this process sees it. Empty means: take MM_LIBRARY_ROOT.",
  ),
  toolboxLibraryRoot: define(
    z.string(),
    "",
    "The same directory as the toolbox container sees it. Empty means: take MM_TOOLBOX_LIBRARY_ROOT.",
  ),
} as const;

export type SettingKey = keyof typeof SETTING_DEFINITIONS;
export type SettingValue<K extends SettingKey> = (typeof SETTING_DEFINITIONS)[K]["default"];
export type Settings = { [K in SettingKey]: SettingValue<K> };

export const SETTING_KEYS = Object.keys(SETTING_DEFINITIONS) as SettingKey[];

/** Every default, as one object. The starting point of `load()` and of the unit tests. */
export function defaults(): Settings {
  const out = {} as Record<string, unknown>;
  for (const key of SETTING_KEYS) out[key] = SETTING_DEFINITIONS[key].default;
  return out as Settings;
}

/** Parse one stored value, falling back to the default when the row no longer fits. */
export function coerce<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = definition.schema.safeParse(raw);
  if (parsed.success) return parsed.data as SettingValue<K>;
  console.warn(
    `settings: ignoring the stored value of "${key}" (${parsed.error.issues[0]?.message ?? "invalid"}); using the default.`,
  );
  return definition.default as SettingValue<K>;
}

/** Validate a value before it is written. Throws with a readable message. */
export function parseValue<K extends SettingKey>(key: K, raw: unknown): SettingValue<K> {
  const definition = SETTING_DEFINITIONS[key];
  const parsed = definition.schema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`invalid value for setting "${key}": ${detail}`);
  }
  return parsed.data as SettingValue<K>;
}

/** True when the value of `key` is a credential and must never be printed. */
export function isSecretSetting(key: SettingKey): boolean {
  return SETTING_DEFINITIONS[key].secret === true;
}

/**
 * What may be shown for a setting. A credential becomes its length and its last two
 * characters — enough to tell "the wrong key" from "no key", never enough to use.
 */
export function maskSetting<K extends SettingKey>(key: K, value: SettingValue<K>): unknown {
  if (!isSecretSetting(key)) return value;
  if (typeof value !== "string" || value === "") return "";
  return `set (${String(value.length)} chars, …${value.slice(-2)})`;
}

/** Every setting, with credentials masked. What the CLI and the API are allowed to show. */
export function maskedSettings(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SETTING_KEYS) out[key] = maskSetting(key, settings[key]);
  return out;
}

/** True when `key` is one of ours. The CLI needs this before it parses a value. */
export function isSettingKey(value: string): value is SettingKey {
  return Object.hasOwn(SETTING_DEFINITIONS, value);
}

/**
 * Read the whole store: defaults, overridden by whatever the database holds.
 *
 * One query. Every step of a job takes its knobs from a single snapshot, so a setting changed
 * halfway through cannot make a job behave two different ways in the same run.
 */
export async function loadSettings(db: Database = defaultDb()): Promise<Settings> {
  const rows = await db
    .select()
    .from(settingsTable)
    .where(inArray(settingsTable.key, SETTING_KEYS));
  const out = defaults() as Record<string, unknown>;
  for (const row of rows) {
    if (isSettingKey(row.key)) out[row.key] = coerce(row.key, row.value);
  }
  return out as Settings;
}

/** Read one setting. */
export async function getSetting<K extends SettingKey>(
  key: K,
  db: Database = defaultDb(),
): Promise<SettingValue<K>> {
  const [row] = await db.select().from(settingsTable).where(eq(settingsTable.key, key)).limit(1);
  return row === undefined
    ? (SETTING_DEFINITIONS[key].default as SettingValue<K>)
    : coerce(key, row.value);
}

/** Write one setting, after parsing it. */
export async function setSetting<K extends SettingKey>(
  key: K,
  value: unknown,
  options: { db?: Database; setBy?: string } = {},
): Promise<SettingValue<K>> {
  const db = options.db ?? defaultDb();
  const parsed = parseValue(key, value);
  await db
    .insert(settingsTable)
    .values({ key, value: parsed as never, setBy: options.setBy ?? "user" })
    .onConflictDoUpdate({
      target: settingsTable.key,
      set: { value: parsed as never, setBy: options.setBy ?? "user", updatedAt: new Date() },
    });
  return parsed;
}

/** Forget an override, returning the key to its default. */
export async function unsetSetting(key: SettingKey, db: Database = defaultDb()): Promise<void> {
  await db.delete(settingsTable).where(eq(settingsTable.key, key));
}

/**
 * Accept a value from a shell, where everything is a string.
 * `true`, `12`, `["a","b"]` and `plain text` all do what they look like.
 */
export function parseCliValue<K extends SettingKey>(key: K, raw: string): SettingValue<K> {
  const trimmed = raw.trim();
  try {
    return parseValue(key, JSON.parse(trimmed));
  } catch {
    return parseValue(key, trimmed);
  }
}
