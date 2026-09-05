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
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { settings as settingsTable } from "#/server/db/schema/index.ts";

/** One knob: how to parse it, what it is worth when nobody said, and why it exists. */
interface SettingDefinition<T> {
  readonly schema: z.ZodType<T>;
  readonly default: T;
  readonly doc: string;
}

function define<T>(schema: z.ZodType<T>, value: T, doc: string): SettingDefinition<T> {
  return { schema, default: value, doc };
}

const sanitizeMode = z.enum(["unicode", "windows", "strict"]);
const onExists = z.enum(["skip", "overwrite", "keep_both"]);

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

  /* ---- the library, on both sides of the bridge ---- */
  libraryRoot: define(
    z.string().min(1),
    "",
    "Library root as this process sees it. Empty means: take MM_LIBRARY_ROOT.",
  ),
  toolboxLibraryRoot: define(
    z.string().min(1),
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
