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
import { MMError, notifiableEventSchema, type NotifiableEvent } from "@mm/contracts";
import {
  ARTIST_NAME_SOURCES,
  DEFAULT_GROUP_LIMIT,
  DEFAULT_PATH_TEMPLATE,
  DEFAULT_THRESHOLDS,
  DEFAULT_WEIGHTS,
  DISC_MODES,
  PATH_TOKENS,
  PREFERRED_LOCALES,
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
    "bestaudio[acodec=opus]/bestaudio/best",
    "yt-dlp format selector. Opus first, and never re-encode: the toolbox remuxes by stream copy.",
  ),
  localStepConcurrency: define(
    z.number().int().min(1).max(8),
    3,
    "How many tracks may be fingerprinted, tagged or filed at the same time. The download " +
      "slot stays at one whatever this says; these steps are local and cheap.",
  ),
  /*
   * The *preparation* concurrency: `resolve`, `match` and `confirm`, the three steps that run
   * before a single byte of audio is fetched.
   *
   * It was nailed to 1 in the worker, and on a few hundred queued imports that is what the
   * owner waited on: preparations came out at about four a minute, so the first download of
   * the batch started two hours after the paste. Nothing in `docs/06-stack.md` asks for it —
   * "one orchestrator" is a rule about the **download** slot, which stays at one whatever
   * this says (`QUEUES.download` is `singleton`, `localConcurrency: 1`, and the toolbox
   * answers `409 LOCKED` to a second caller).
   *
   * Raising it does **not** scale linearly, and the reason is `integrations/rate-gate.ts`:
   * `match` is mostly MusicBrainz, and MusicBrainz is one request per second for the whole
   * installation, across processes. Parallel preparations queue on that gate; what they
   * genuinely overlap is the yt-dlp extraction, the database work and each other's waiting.
   * Four is where the measured gain flattens on the development machine — the numbers, and
   * what to do when they are not yours, are in `docs/deploy.md` § 5 quater.
   */
  importStepConcurrency: define(
    z.number().int().min(1).max(8),
    4,
    "How many imports may be resolved, matched and confirmed at the same time. The single " +
      "download slot is unaffected: it stays at one whatever this says. Above four the " +
      "MusicBrainz rate limit (one request a second, installation-wide) is what you are " +
      "queueing on, not this number.",
  ),

  /* ---- upstream resilience: a busy source is a wait, not a failure ---- */
  //
  // Separate from the three `download*` knobs above, which govern retries *inside* one step
  // against yt-dlp. These govern how many times the whole import goes back on the queue when
  // a metadata source refuses it, and the two must be tunable apart: an operator who raises
  // their patience with MusicBrainz is not asking to hammer YouTube harder.
  upstreamMaxAttempts: define(
    z.number().int().min(0).max(20),
    6,
    "How many times an import is re-queued after a source refuses it (429, 5xx, timeout) " +
      "before it is given up on as `UPSTREAM_UNAVAILABLE`. 0 disables the wait entirely.",
  ),
  upstreamBackoffBaseMs: define(
    z.number().int().min(0),
    30_000,
    "Pause after the first upstream refusal; doubles on each further attempt.",
  ),
  upstreamBackoffMaxMs: define(
    z.number().int().min(0),
    3_600_000,
    "Ceiling of the upstream backoff. Six attempts from the default base reach it at the " +
      "seventh doubling, so an outage costs about an hour of waiting, not a day.",
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
    "How many results one MusicBrainz search asks for. A match makes `1 + matchGroupLimit`.",
  ),
  matchGroupLimit: define(
    z.number().int().min(1).max(10),
    DEFAULT_GROUP_LIMIT,
    "How many release groups get a release search of their own — the first level of the match.",
  ),
  matchCoveragePenalty: define(
    z.number().min(0).max(1),
    DEFAULT_THRESHOLDS.coveragePenalty,
    "Deduction at a total miss, scaled by the square of the share of videos a release leaves over.",
  ),
  matchReleaseWeights: define(
    z.object({
      title: z.number().min(0),
      artist: z.number().min(0),
      trackCount: z.number().min(0),
      durations: z.number().min(0),
      // Added by decision 152, hence a default: a settings row written before it exists.
      coverage: z.number().min(0).default(DEFAULT_WEIGHTS.release.coverage),
      year: z.number().min(0),
      label: z.number().min(0),
      format: z.number().min(0),
      status: z.number().min(0),
      country: z.number().min(0),
      // Added by decision 167, hence a default, for the same reason `coverage` has one.
      coverArt: z.number().min(0).default(DEFAULT_WEIGHTS.release.coverArt),
      // The release-type preference, hence a default, for the same reason the two above have one.
      type: z.number().min(0).default(DEFAULT_WEIGHTS.release.type),
    }),
    DEFAULT_WEIGHTS.release,
    "Weight of each release signal. The tracklist fit (`durations`) is the decisive one, and `coverage` — the share of your videos a release would actually import — is right behind it. `type` is the release-type preference: raise it to insist harder on an Album over an EP or a Single, set it to 0 to stop caring. It is a weight and never a veto, so a Single whose release group holds nothing else still wins.",
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
  writeArtistImage: define(
    z.boolean(),
    true,
    "Write `artist.jpg` in the artist folder, from the image `artists_cache` found for them.",
  ),
  embedArtwork: define(z.boolean(), true, "Embed the front cover in the audio file itself."),
  artworkSize: define(z.number().int().min(16).max(4000), 1200, "Longest side of `cover.jpg`."),
  replayGain: define(z.boolean(), true, "Run rsgain per album once every track is present."),
  replayGainReferenceLoudness: define(z.number(), -18, "rsgain's reference loudness, in LUFS."),

  /* ---- placement (docs/04 § Étapes, `place`) ---- */
  pathTemplate: define(
    // `validatePathTemplate` already knows *which* token is wrong; a constant message threw
    // that away and left the caller to guess. `superRefine` is what lets the issue carry it,
    // together with the list of what would have been accepted.
    z.string().superRefine((value, ctx) => {
      const check = validatePathTemplate(value);
      if (check.ok) return;
      ctx.addIssue({
        code: "custom",
        message: `unusable template — ${check.reason}. Valid tokens: ${PATH_TOKENS.map(
          (entry) => entry.token,
        ).join(
          " ",
        )} (and {track:0N} for any width). {title} must appear, or two tracks of an album would share a file name.`,
      });
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
    "Which of the eight sources of §4 may be called. A disabled source is simply not asked. Deezer's switch also governs the Console's 30-second previews: off means Discover offers no preview rather than a broken one.",
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
    "Days after which a stored source answer is refreshed. 0 = never. Rows are never deleted. Deezer preview lookups are the one exception: their URLs are signed and expire within hours, so they keep a fixed one-hour TTL of their own (PREVIEW_TTL_MS).",
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
  artistNameSource: define<"credited" | "canonical">(
    z.enum(ARTIST_NAME_SOURCES),
    "credited",
    "Which of MusicBrainz's two artist names goes into ARTIST, ARTISTS and ALBUMARTIST. `credited` writes the name printed on this release (`Ye` credited as `Kanye West`), which is what Picard does. `canonical` writes the artist's own name, so one spelling covers the whole library — and it is what v1 wrote, so it is the value that reproduces a v1 library's artist names. The join phrases are MusicBrainz's either way.",
  ),
  /* ---- Picard's "translate names to this locale" (docs/03 §2.1) ---- */
  preferredLocale: define<"" | "en" | "fr" | "de" | "es" | "it" | "ja" | "pt" | "ru" | "zh" | "ko">(
    z.enum(PREFERRED_LOCALES),
    "",
    "Write artist and album names in this locale when MusicBrainz has an alias for it: 梶浦由記 becomes Yuki Kajiura, with no manual step. The original is kept in ARTISTSORT, ALBUMSORT and TITLESORT, and in the document with its provenance. Empty — the default — translates nothing. Nothing is ever transliterated by machine: if MusicBrainz has no alias in this locale, the original name is written.",
  ),
  aliasTranslateArtists: define(
    z.boolean(),
    true,
    "Apply the preferred locale to ARTIST, ARTISTS, ALBUMARTIST and ALBUMARTISTS. A name credited differently from the artist's own on this particular release is never translated: a “credited as” is an editorial fact about that sleeve.",
  ),
  aliasTranslateAlbums: define(
    z.boolean(),
    true,
    "Apply the preferred locale to ALBUM, from the release group's aliases and then the release's. The original title moves into ALBUMSORT, which MusicBrainz otherwise leaves empty.",
  ),
  aliasTranslateOnlyNonLatin: define(
    z.boolean(),
    true,
    "Only translate a name that is not already written in Latin script — Picard's behaviour. It is what keeps `Björk` and `Sigur Rós` as they are while 梶浦由記 is spelled out.",
  ),
  aliasPseudoRelease: define<"off" | "prefer">(
    z.enum(["off", "prefer"]),
    "off",
    "Where a track TITLE in the preferred script comes from. Recording aliases carry no locale, so the only source is a MusicBrainz pseudo-release — the romanised edition of the album, filed in the same release group. `prefer` looks one up when the matched release is not in Latin script; that costs **one extra MusicBrainz search per album**, which is why it is opt-in. `off` leaves track titles as the release spells them.",
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
    z.enum(["anonymous", "file", "paste"]),
    "anonymous",
    "How yt-dlp authenticates: `anonymous` needs nothing, `file` reads a Netscape cookies.txt the toolbox can see, `paste` uses the jar stored below.",
  ),
  cookiesFile: define(
    z.string(),
    "",
    "Path to the `cookies.txt`, as the toolbox container sees it. Only read when `cookiesMode` is `file`.",
  ),
  cookiesText: define(
    z.string(),
    "",
    "A Netscape `cookies.txt` pasted whole. Only read when `cookiesMode` is `paste`; sent to the toolbox, which writes it to a private temporary file per call.",
    { secret: true },
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

  /* ---- Discover (P09, docs/05-recommandations.md) ---- */
  discoverEnabled: define(
    z.boolean(),
    true,
    "Compute recommendations at all. Off leaves the page with its empty state and skips the cron.",
  ),
  discoverCron: define(
    z.string().min(1),
    "0 6 * * *",
    "When `cron.discover` refreshes the recommendations, as a five-field cron expression.",
  ),
  discoverWindowDays: define(
    z.number().int().min(1).max(3650),
    30,
    "The sliding window the listening signals are read over. `you played Justice 43× this month`.",
  ),
  discoverTopArtists: define(
    z.number().int().min(1).max(50),
    8,
    "How many of your most-played artists get a discography comparison against MusicBrainz.",
  ),
  discoverMaxItems: define(
    z.number().int().min(1).max(200),
    40,
    "Ceiling on the `Recommended for you` list, after diversity and the redundancy penalty.",
  ),
  discoverMaxPerArtist: define(
    z.number().int().min(1).max(20),
    3,
    "How many recommendations one artist may occupy before the redundancy penalty pushes the rest down.",
  ),
  discoverIncludeTypes: define<("Album" | "EP" | "Single" | "Other")[]>(
    z.array(z.enum(["Album", "EP", "Single", "Other"])),
    ["Album", "EP"],
    "Which MusicBrainz release-group primary types count as a discography gap.",
  ),
  discoverExcludeLive: define(
    z.boolean(),
    true,
    "Ignore release-groups whose secondary types include Live.",
  ),
  discoverExcludeCompilations: define(
    z.boolean(),
    true,
    "Ignore release-groups whose secondary types include Compilation.",
  ),
  listenbrainzUser: define(
    z.string(),
    "",
    "The ListenBrainz account your listens are scrobbled to. Empty means no collaborative filtering.",
  ),
  discoverPlaylistEnabled: define(
    z.boolean(),
    false,
    "After a sync, push the recommendations Navidrome already has as a playlist, so Feishin shows them.",
  ),
  discoverPlaylistName: define(
    z.string().min(1),
    "Recommended",
    "Name of that playlist. It is replaced wholesale on each sync, never appended to.",
  ),

  /* ---- admission rules: what a source has to look like to be importable at all ---- */
  officialUploadsOnly: define(
    z.boolean(),
    false,
    "Refuse a video whose description does not carry the “Provided to YouTube by” line — the " +
      "marker a distributor writes on an official upload. Read from the description and never " +
      "from the channel name, because the channel is the unreliable one: on 9766 real sources " +
      "it is empty on 5306 and carries the `- Topic` suffix on only 580, while the line is " +
      "present on 9544 and absent on 222. A single URL is refused outright with " +
      "`SOURCE_NOT_OFFICIAL`; an entry inside a playlist, and a video a watched source found, " +
      "is skipped with the reason recorded. Off by default: it changes nothing until you ask.",
  ),
  requireAlbum: define(
    z.boolean(),
    false,
    "Refuse an isolated video that no album is attached to. “Isolated” is what `resolve` " +
      "classifies as kind `single` — a lone video, not an entry inside a playlist, which is " +
      "already an album by construction. “No album attached” means both of the sources " +
      "`resolve` itself reads are empty: the YouTube Music `album` tag on the entry (the field " +
      "it counts to tell an album from a playlist) and the album line of the auto-generated " +
      "description. Either one, non-blank, is an album. Refused with `SOURCE_NO_ALBUM`. Off by " +
      "default.",
  ),

  /* ---- watched sources: a playlist or channel scanned on a schedule ---- */
  watchedSourcesEnabled: define(
    z.boolean(),
    true,
    "Scan watched sources at all. Off keeps the page and the sources, and skips the cron.",
  ),
  watchedSourcesCron: define(
    z.string().min(1),
    "0 */6 * * *",
    "When `cron.watched-sources` scans every enabled source, as a five-field cron expression.",
  ),
  watchedSourcesAutoAcceptDefault: define(
    z.boolean(),
    false,
    "Whether a newly added source starts with auto-accept on. Off: docs/04 says the algorithm never chooses for you.",
  ),
  watchedSourcesAutoAcceptThreshold: define(
    z.number().min(0).max(1),
    0.95,
    "The score an auto-accepting source demands before confirming without you. Defaults to `safeThreshold`.",
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
  /*
   * The directories `POST /imports/{id}/tracks/{trackId}/file` may read a **server path** from.
   *
   * Empty on purpose, and empty means "the library and nothing else". A path arriving in an
   * HTTP body and opened without a check is a file-read primitive: the request would copy any
   * file the app can read into the library, give it a `.opus` name and hand it to the tagger.
   * So the route resolves the path (symlinks and all, `realpath`), and refuses it unless it
   * lands under the library root or under one of these roots. Adding `D:\Musique` here is the
   * operator saying, once, "this folder is mine and the app may read from it" — which is what
   * taking over an existing library needs, and it is a decision that belongs to a person with
   * access to Settings rather than to whoever holds an API key.
   */
  adoptSourceRoots: define(
    z.array(z.string().min(1)),
    [],
    "Absolute directories a local file may be adopted *from* by path. The library root is " +
      "always allowed; everything else has to be listed here. Uploads are unaffected.",
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
 * The one thing a masked credential says: whether there is one.
 *
 * It used to say `set (5 chars, …in)` — the exact length and the last two characters. On a
 * five-character password that is forty per cent of the secret handed to anything that can
 * read the settings, and the length alone narrows a brute force considerably. "Is a value
 * configured?" is the only question a reader legitimately has here; `SETTING_MASK` answers it
 * and nothing else. Distinguishing *which* key is set is what the source tests of decision
 * 073 are for, and they never print the value either.
 */
export const SETTING_MASK = "set";

/** What may be shown for a setting. A credential becomes `"set"` or `""`, never a prefix. */
export function maskSetting<K extends SettingKey>(key: K, value: SettingValue<K>): unknown {
  if (!isSecretSetting(key)) return value;
  if (typeof value !== "string" || value === "") return "";
  return SETTING_MASK;
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

/**
 * Write a whole patch, or write nothing at all.
 *
 * `setSetting` parses one value and immediately writes it, which is correct for one key and
 * wrong for a patch: a loop over `Object.entries` writes every key that parses *before* the
 * first one that does not, so `{maxGenres: 4, safeThreshold: "nawak"}` left `maxGenres` at 4
 * and answered with an error, while `{safeThreshold: "nawak", maxGenres: 5}` — the same patch,
 * the same refusal — left it alone. The caller could not know which half had taken, and the
 * answer depended on JavaScript's key order (MCP-FIX-3 §1).
 *
 * So: **two phases**. Every key is checked and every value parsed first; only then is anything
 * written, and the writes go in one transaction so a database failure mid-patch cannot split it
 * either. The refusal names *all* the bad values rather than the first, because an agent that
 * has to fix them one round trip at a time is being made to pay for our loop.
 *
 * This is the single write path for a patch: MCP's `update_settings`, `PATCH /api/v1/settings`
 * and every Settings tab of the Console go through it, so none of them can be atomic while
 * another is not.
 */
export async function setSettings(
  patch: Record<string, unknown>,
  options: { db?: Database; setBy?: string } = {},
): Promise<{ saved: SettingKey[]; values: Partial<Settings> }> {
  const database = options.db ?? defaultDb();
  const setBy = options.setBy ?? "user";

  const unknown = Object.keys(patch).filter((key) => !isSettingKey(key));
  if (unknown.length > 0) {
    throw new MMError("INVALID_INPUT", `Unknown setting(s): ${unknown.join(", ")}.`, {
      hint: "`get_settings` (or GET /api/v1/settings/schema) lists every key. Nothing was written.",
      details: { unknown },
      status: 400,
    });
  }

  /* Phase one: parse everything. Nothing below this block has touched the database. */
  const parsed: { key: SettingKey; value: unknown }[] = [];
  const problems: string[] = [];
  for (const [key, raw] of Object.entries(patch)) {
    if (!isSettingKey(key)) continue;
    try {
      parsed.push({ key, value: parseValue(key, raw) });
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (problems.length > 0) {
    throw new MMError("INVALID_INPUT", problems.join("; "), {
      hint: `Nothing was written: a patch is all-or-nothing, so the other ${String(parsed.length)} key(s) kept their previous value.`,
      details: { rejected: problems.length, keys: parsed.map((entry) => entry.key) },
      status: 400,
    });
  }

  /* Phase two: write, all of it or none of it. */
  await database.transaction(async (tx) => {
    for (const { key, value } of parsed) {
      await tx
        .insert(settingsTable)
        .values({ key, value: value as never, setBy })
        .onConflictDoUpdate({
          target: settingsTable.key,
          set: { value: value as never, setBy, updatedAt: new Date() },
        });
    }
  });

  const values = {} as Record<string, unknown>;
  for (const { key, value } of parsed) values[key] = value;
  return { saved: parsed.map((entry) => entry.key), values: values as Partial<Settings> };
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
