/**
 * `@mm/domain` — the business core, in pure TypeScript.
 *
 * Rules for this package (see ../../CLAUDE.md):
 *  - no network, no filesystem, no database, no environment variables;
 *  - zod stays at the boundaries: inside, values are already typed;
 *  - everything is provable with the recorded fixtures and the golden files.
 *
 * What lives here, in the order of `docs/03-metadonnees.md`:
 *  - `tagmap/`      the table of §2, the consumer profiles of §5, the projection of §1;
 *  - `metadata/`    the document with provenance, the resolvers, the versioned schema;
 *  - `completeness/` the scores of §6;
 *  - `paths/`       the library layout and the sidecar names;
 *  - `normalize/`   title/artist normalisation and the YouTube description parser.
 */

/* ---- tag map (docs §2, §5) ---- */
export {
  ALBUM_SCOPE_FIELDS,
  keyFor,
  LEVEL_WEIGHT,
  TAG_FORMATS,
  TAG_GROUPS,
  TAGS,
  tagByField,
  tagsByVorbisKey,
} from "./tagmap/tags.ts";
export type { TagDefinition, TagField, TagFormat, TagGroup, TagLevel } from "./tagmap/tags.ts";

export { PROFILE_IDS, PROFILES, profileById, unreadCount } from "./tagmap/profiles.ts";
export type { ConsumerProfile, ProfileId, ProfileStatus } from "./tagmap/profiles.ts";

export { formatProjection, projectDocument, projectPictures } from "./tagmap/project.ts";
export type { ProjectedTag } from "./tagmap/project.ts";

export {
  describeProfile,
  exportFormatTable,
  exportNavidromeMappings,
  exportPicardScript,
} from "./tagmap/export.ts";

/* ---- metadata document (docs §1) ---- */
export {
  albumScopeConsistency,
  canonicalValue,
  emptyDocument,
  field,
  lock,
  merge,
  setUserValue,
  SOURCES,
  unknownFields,
  unlock,
} from "./metadata/document.ts";
export type {
  AlbumScopeDivergence,
  AlbumScopeReport,
  DocumentPatch,
  EmbeddedPicture,
  Field,
  FieldValue,
  LyricsValue,
  NotApplicable,
  PerformerCredit,
  SourceId,
  TrackDocument,
} from "./metadata/document.ts";

export { resolveTrackDocument } from "./metadata/resolve.ts";
export type { Cached, TrackResolutionInput } from "./metadata/resolve.ts";

export { needsRetag, TAG_SCHEMA_CHANGELOG, TAG_SCHEMA_VERSION } from "./metadata/schema.ts";
export type { TagSchemaChange } from "./metadata/schema.ts";

export * from "./metadata/resolvers/index.ts";

/* ---- completeness (docs §6) ---- */
export { albumCompleteness, profileCompleteness, trackCompleteness } from "./completeness/index.ts";
export type {
  AlbumCompleteness,
  CompletenessScore,
  FieldReport,
  FieldState,
  TrackCompleteness,
} from "./completeness/index.ts";

/* ---- paths (docs 04, step `place`) ---- */
export {
  albumFolder,
  bookletPath,
  sanitizeSegment,
  sidecarPaths,
  trackFileName,
  trackPath,
} from "./paths/index.ts";
export type { PathOptions, SanitizeMode, SidecarPaths, TrackPathInput } from "./paths/index.ts";

/* ---- normalisation (docs 04, §Algorithme de présélection) ---- */
export { normalizeArtist, normalizeTitle, titleSimilarity } from "./normalize/title.ts";
export { parseYouTubeDescription } from "./normalize/youtube-description.ts";
export type { YouTubeCredit, YouTubeDescription } from "./normalize/youtube-description.ts";

/* ---- matching (docs 04, §Algorithme de présélection) ---- */
export * from "./matching/index.ts";

/** Kept from P00 so downstream imports do not break; the real version is TAG_SCHEMA_VERSION. */
export const DOMAIN_SCHEMA_VERSION = 1 as const;
