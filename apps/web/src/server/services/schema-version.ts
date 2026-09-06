/**
 * The tag schema version, as *this installation* sees it (`docs/03-metadonnees.md` §1, §8).
 *
 * `TAG_SCHEMA_VERSION` in `@mm/domain` is a compile-time constant, which is the right shape
 * for the thing it describes: the projection changed, so the number went up, and the change is
 * in the same commit as the resolvers that caused it.
 *
 * But §8's promise — "bump the version and the library catches up in the background" — is a
 * property of the *system*, and a property nobody can exercise is a property nobody can trust.
 * Proving it needs a library written under version N and a process that believes in N+1, and
 * recompiling the domain package between those two states is not something a test can do.
 *
 * So there is one override, `tagSchemaVersionOverride`, stored like every other setting:
 *
 *  - `0` (the default) means "use the constant", which is what every real installation does;
 *  - any other value is what the acceptance test of P07 sets in order to make every file in
 *    the library be behind by one, watch the `retag` queue drain, and see the count reach 0.
 *
 * It is deliberately a *setting* rather than an environment variable: the Console, the worker
 * and the CLI are three processes, and a test that flips a knob in one of them and expects the
 * other two to agree needs the knob to live where all three already look — the database.
 *
 * Nothing else in the app is allowed to read `TAG_SCHEMA_VERSION` directly for a *comparison*.
 * Writing it into a fresh document is fine (that is `documents.service`'s job and the constant
 * is right there); deciding whether a file is behind is not.
 */
import { TAG_SCHEMA_CHANGELOG, TAG_SCHEMA_VERSION, type TagSchemaChange } from "@mm/domain";
import type { Settings } from "#/server/services/settings.ts";

/** Just the part of the settings this module needs, so callers can pass a stub. */
export type SchemaSettings = Pick<Settings, "tagSchemaVersionOverride">;

/** The version this installation projects to. `TAG_SCHEMA_VERSION` unless overridden. */
export function effectiveSchemaVersion(settings: SchemaSettings): number {
  const override = settings.tagSchemaVersionOverride;
  return override > 0 ? override : TAG_SCHEMA_VERSION;
}

/** True when the override is in force — the Console says so rather than lying quietly. */
export function isSchemaOverridden(settings: SchemaSettings): boolean {
  return settings.tagSchemaVersionOverride > 0;
}

/**
 * True when a file written under `version` must be re-tagged.
 *
 * `undefined`/`null` counts as behind: a row with no version is a file we did not write, or
 * one written before the column existed, and both deserve a fresh projection.
 */
export function isBehindSchema(version: number | null | undefined, current: number): boolean {
  return version === null || version === undefined || version < current;
}

/**
 * The changelog, with a synthetic entry on top when the version is overridden.
 *
 * The Console shows the changelog next to "N files behind"; showing a list that stops at v1
 * while the badge says v2 would be the interface contradicting itself in the same paragraph.
 */
export function effectiveChangelog(settings: SchemaSettings): readonly TagSchemaChange[] {
  const current = effectiveSchemaVersion(settings);
  if (!isSchemaOverridden(settings) || current <= TAG_SCHEMA_VERSION) return TAG_SCHEMA_CHANGELOG;
  return [
    {
      version: current,
      at: new Date().toISOString().slice(0, 10),
      added: [],
      changed: ["the whole projection is re-derived from the raw cache"],
      removed: [],
      note: `Version override in force (setting "tagSchemaVersionOverride" = ${String(current)}). The projection itself is v${String(TAG_SCHEMA_VERSION)}; this exists so the background re-tag of §8 can be exercised end to end.`,
    },
    ...TAG_SCHEMA_CHANGELOG,
  ];
}

export { TAG_SCHEMA_VERSION };
