/**
 * `apps/web/src/server/migration/v1/` — the v1 → v2 migration (P11).
 *
 * The public surface is small on purpose: the CLI, the worker handler and the Tools page all
 * call `runMigration` and read a `MigrationReport`. Everything else here is either pure and
 * unit-tested (`schema`, `paths`, `classify`, `reconcile`, `seed`, `playlists`) or an
 * implementation detail of one of the two halves of a run (`inventory`, `execute`).
 */
export {
  acknowledgeBackup,
  backupAcknowledged,
  BACKUP_KEY,
  getRun,
  lastRun,
  listRuns,
  reportOf,
  runMigration,
  type MigrationOptions,
  type MigrationResult,
} from "./run.ts";

export {
  emptyCounts,
  formatReport,
  type MigrationCounts,
  type MigrationReport,
  type ReportAlbum,
  type ReportError,
  type ReportImport,
  type ReportRename,
} from "./report.ts";

export {
  libraryPrefixOf,
  planFrom,
  probeLibrary,
  type MigrationPlan,
  type PlannedAlbum,
  type PlannedImportGroup,
  type PlannedSong,
} from "./inventory.ts";

export { classify, importStatusFor, needsImport, reasonFor } from "./classify.ts";
export { openV1Reader, redactUrl, type V1Reader } from "./reader.ts";
export {
  commentVideoId,
  recordingMbidOf,
  reconcile,
  type Discrepancy,
  type Reconciliation,
  type ScannedFile,
} from "./reconcile.ts";
export {
  normalizeV1Path,
  padD2,
  pathKey,
  predictV1Path,
  sanitizeV1,
  type V1PathParts,
} from "./paths.ts";
export { albumKeyOf, seedDocument, V1_CONFIDENCE, type SeedResult } from "./seed.ts";
export {
  defaultPlaylistDir,
  exportPlaylists,
  playlistFileName,
  renderPlaylist,
  type ExportedPlaylist,
} from "./playlists.ts";
export {
  identifiersOf,
  isV1ForceField,
  isV1SongStatus,
  sourceVideoId,
  splitForcedList,
  splitList,
  V1_FORCE_FIELDS,
  V1_SONG_STATUSES,
  videoIdFromUrl,
  type V1Dataset,
  type V1ForceMetadata,
  type V1Playlist,
  type V1PlaylistSong,
  type V1Song,
} from "./schema.ts";
