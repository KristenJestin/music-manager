/**
 * What each v1 row becomes (`docs/phases/P11-migration-v1.md` § Étapes 1 and 4).
 *
 * The classification is deliberately coarse, because only one distinction actually changes
 * what happens: **is there a file?** A row with a file becomes a library track that gets
 * re-tagged in place; a row without one becomes a v2 import, whatever the reason for its
 * absence, because the only way to get the audio is to fetch it and only the pipeline can do
 * that.
 *
 * The reason still travels with the row — it decides whether the import rests at `queued` or
 * at `awaiting_review`, and it is what the report groups by.
 */
import type { ImportStatus } from "#/server/db/schema/index.ts";
import type { MigrationClass } from "#/server/db/schema/migration.ts";
import type { V1Song } from "./schema.ts";

/** v1 statuses that mean "there should be a file at `FinalFilePath`". */
const PRESENT_STATUSES = new Set(["Present"]);

/** v1 statuses that mean "v1 gave up and wants a human". */
const REVIEW_STATUSES = new Set(["NeedsManualReview"]);

/** v1 statuses that mean "v1 tried and failed". */
const FAILED_STATUSES = new Set(["DownloadFailed", "MetadataFailed", "ProcessingFailed"]);

export interface ClassifyInput {
  readonly song: V1Song;
  /** Did the inventory find a real file for this row? */
  readonly hasFile: boolean;
}

/**
 * Classify one row.
 *
 * `Downloaded`, `Downloading`, `ProcessingMetadata` and `ReadyToDownload` are all "in flight
 * when v1 stopped". They are treated as `needed`: v1 never finished them, so v2 must, and a
 * half-processed row is not something to inherit silently.
 */
export function classify({ song, hasFile }: ClassifyInput): MigrationClass {
  const status = song.downloadStatus;

  if (PRESENT_STATUSES.has(status)) {
    return hasFile ? "present_with_file" : "present_missing_file";
  }
  // A file exists even though v1 never called the row `Present`: v1 crashed between the write
  // and the status update. The file is the fact; the status is the opinion.
  if (hasFile) return "present_with_file";

  if (REVIEW_STATUSES.has(status)) return "needs_manual_review";
  if (FAILED_STATUSES.has(status)) return "failed";
  return "needed";
}

/** True when the class means "make a v2 import for it" rather than "adopt the file". */
export function needsImport(classification: MigrationClass): boolean {
  return classification !== "present_with_file";
}

/**
 * Where the created import rests (§ Étapes 4).
 *
 * Nothing is downloaded during a migration, so no import is ever left `pending` — that is the
 * state the worker picks up. `paused` is the v2 word for "queued, not running": the row is
 * complete, the wizard can resume it, and the download slot is untouched until somebody says
 * so. A row v1 could not decide about arrives as `awaiting_review`, which is exactly the same
 * promise v2 makes everywhere else: the algorithm proposes, a human chooses.
 */
export function importStatusFor(classification: MigrationClass): ImportStatus {
  switch (classification) {
    case "needs_manual_review":
      return "awaiting_review";
    case "present_missing_file":
    case "failed":
    case "needed":
      return "paused";
    case "present_with_file":
      return "paused";
  }
}

/** A one-line reason, for the Inbox item and the report. */
export function reasonFor(song: V1Song, classification: MigrationClass): string {
  switch (classification) {
    case "present_with_file":
      return "the file is on disk";
    case "present_missing_file":
      return `v1 said Present but ${song.finalFilePath ?? "no path"} is not there`;
    case "needs_manual_review":
      return song.errorMessage ?? "v1 asked for a manual review";
    case "failed":
      return song.errorMessage ?? `v1 status ${song.downloadStatus}`;
    case "needed":
      return song.downloadStatus === "Needed"
        ? "never downloaded by v1"
        : `v1 stopped at ${song.downloadStatus}`;
  }
}
