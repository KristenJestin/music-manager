/**
 * @mm/domain — pure TypeScript domain logic.
 *
 * Rules for this package (see ../../CLAUDE.md):
 *  - no network, no filesystem, no database, no environment variables;
 *  - everything here must be testable with recorded fixtures and golden files.
 *
 * P00 ships only the package shell. The tag map, metadata document, resolvers,
 * completeness scoring, profiles and path rendering arrive in P01.
 */

/** Schema version of the metadata document produced by this package. */
export const DOMAIN_SCHEMA_VERSION = 1 as const;

/** Placeholder so the package has one exercised, exported behaviour in P00. */
export function domainInfo(): { name: string; schemaVersion: number } {
  return { name: "@mm/domain", schemaVersion: DOMAIN_SCHEMA_VERSION };
}
