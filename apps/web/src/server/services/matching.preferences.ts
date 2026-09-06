/**
 * Light preference learning from the decision log (`docs/04-pipeline-et-matching.md`:
 * "Les décisions passées alimentent les préférences (pays, format, explicit) mais pas de façon
 * opaque : elles sont listées dans Settings").
 *
 * Three rules make this acceptable rather than creepy:
 *
 *  1. **It only ever reorders what you already declared.** A country you have never listed is
 *     not added; a format you have never chosen does not become the preferred one. Learning
 *     moves `preferredCountries` around and can change `preferredFormat` to a value you have
 *     confirmed repeatedly — it does not invent a policy.
 *  2. **It writes to `settings`, where you can see it and change it back.** The learned values
 *     are ordinary settings rows with `set_by = "learned"`, and `learnedFrom` says how many
 *     decisions they came from. `mm settings list` shows both. Turning `learnPreferences` off
 *     freezes them at once.
 *  3. **It needs evidence.** Fewer than `MIN_DECISIONS` confirmed releases, or a plurality
 *     under `MIN_SHARE`, and nothing moves. One import of a Japanese pressing must not make
 *     Japan the first preference for ever.
 *
 * The country and format of a confirmed release are not stored on the decision: they are read
 * back from the raw cache, where `match` put the full release lookup. That costs no request
 * and no migration, and it means the learning is recomputable from the log at any time.
 */
import { desc, eq } from "drizzle-orm";
import type { MbRelease } from "@mm/domain";
import { mainFormat } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { decisions } from "#/server/db/schema/index.ts";
import { get as cacheGet } from "#/server/services/cache.ts";
import { loadSettings, setSetting, type Settings } from "#/server/services/settings.ts";

/** How many confirmed releases before anything is learned at all. */
export const MIN_DECISIONS = 5;

/** The share of them that must agree before a preference moves. */
export const MIN_SHARE = 0.6;

/** How far back the log is read. Old taste should not outvote current taste for ever. */
export const WINDOW = 50;

export interface LearnedPreferences {
  readonly countries: readonly string[];
  readonly format: string;
  readonly from: number;
  /** One line per change, for the Console and for `mm settings list`. */
  readonly changes: readonly string[];
}

/** The release a `decisions` row was about, out of the raw cache. `null` when never fetched. */
async function releaseOf(db: Database, mbid: string): Promise<MbRelease | null> {
  const hit = await cacheGet<MbRelease>("musicbrainz", `release/${mbid}?inc=releaseFull`, db);
  return hit?.data ?? null;
}

/** The most common value, and how large its share is. */
function plurality(values: readonly string[]): { value: string; share: number } | null {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [value, count] of [...counts].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return { value: best, share: bestCount / values.length };
}

/** What was confirmed, reduced to the two facts the preferences are about. */
export interface Observation {
  readonly country: string | null;
  readonly format: string | null;
}

/**
 * The whole decision, as a pure function of the observations and the current settings.
 *
 * Pure so that it can be argued with. Everything that makes preference learning suspicious —
 * how much evidence is enough, what counts as agreement, what it is allowed to change — is
 * decided here, in twenty lines, with no database in sight.
 */
export function decidePreferences(
  observations: readonly Observation[],
  current: Pick<Settings, "preferredCountries" | "preferredFormat">,
): LearnedPreferences | null {
  const seen = observations.length;
  if (seen < MIN_DECISIONS) return null;

  const countries = observations
    .map((observation) => observation.country)
    .filter((value): value is string => value !== null && value !== "");
  const formats = observations
    .map((observation) => observation.format)
    .filter((value): value is string => value !== null && value !== "");

  const changes: string[] = [];
  const settings = current;
  let preferredCountries = [...settings.preferredCountries];
  let preferredFormat = settings.preferredFormat;

  const country = plurality(countries);
  if (country !== null && country.share >= MIN_SHARE) {
    const known = preferredCountries.some(
      (code) => code.toUpperCase() === country.value.toUpperCase(),
    );
    // Only a reordering: a country you never listed is not silently adopted.
    if (known && preferredCountries[0]?.toUpperCase() !== country.value.toUpperCase()) {
      preferredCountries = [
        country.value,
        ...preferredCountries.filter((code) => code.toUpperCase() !== country.value.toUpperCase()),
      ];
      changes.push(
        `Country ${country.value} moved to first preference (${Math.round(country.share * 100)}% of ${String(seen)} confirmed releases).`,
      );
    }
  }

  const format = plurality(formats);
  if (format !== null && format.share >= MIN_SHARE && format.value !== preferredFormat) {
    preferredFormat = format.value;
    changes.push(
      `Preferred format is now ${format.value} (${Math.round(format.share * 100)}% of ${String(seen)} confirmed releases).`,
    );
  }

  return { countries: preferredCountries, format: preferredFormat, from: seen, changes };
}

/**
 * Read the decision log and say what the preferences would become. Writes nothing.
 *
 * Split from `learnPreferences` so the Console — and `mm settings list` — can show the
 * proposal before it is applied. A preference that changes without being shown first is
 * exactly the opacity `docs/04` rules out.
 */
export async function proposePreferences(
  db: Database = defaultDb(),
): Promise<LearnedPreferences | null> {
  const settings = await loadSettings(db);
  const rows = await db
    .select()
    .from(decisions)
    .where(eq(decisions.kind, "release"))
    .orderBy(desc(decisions.createdAt))
    .limit(WINDOW);

  const observations: Observation[] = [];
  for (const row of rows) {
    const mbid = row.subject;
    if (mbid === null || mbid === "") continue;
    const release = await releaseOf(db, mbid);
    // A release the cache never saw teaches nothing. It is skipped rather than counted as an
    // absence, so a partial cache cannot dilute the evidence into inaction.
    if (release === null) continue;
    observations.push({ country: release.country ?? null, format: mainFormat(release) });
  }

  return decidePreferences(observations, settings);
}

/**
 * Apply what the log says, when `learnPreferences` is on.
 *
 * Returns the proposal it applied, or `null` when there was nothing to learn. Called after a
 * release decision is recorded; safe to call as often as you like, since it is a pure function
 * of the log.
 */
export async function learnPreferences(
  db: Database = defaultDb(),
): Promise<LearnedPreferences | null> {
  const settings = await loadSettings(db);
  if (!settings.learnPreferences) return null;

  const proposal = await proposePreferences(db);
  if (proposal === null) return null;

  await setSetting("learnedFrom", proposal.from, { db, setBy: "learned" });
  if (proposal.changes.length === 0) return proposal;

  await setSetting("preferredCountries", proposal.countries, { db, setBy: "learned" });
  await setSetting("preferredFormat", proposal.format, { db, setBy: "learned" });
  return proposal;
}
