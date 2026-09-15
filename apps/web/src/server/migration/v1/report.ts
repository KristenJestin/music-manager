/**
 * What a migration says about itself (§ Étapes 7).
 *
 * The report is written to `migration_v1_runs.report` as JSON, printed by the CLI and shown
 * on the Tools page — one shape, three renderings, so the three can never disagree. It is
 * kept whole rather than normalised because it is read as one document and never queried by
 * its innards, which is the same argument `library_scans` makes for its own report.
 *
 * The counters are the ones the phase asks for: migrated tracks, complete documents, imports
 * created, orphan files, rows without a file, duration, errors.
 */
import type { MigrationClass } from "#/server/db/schema/migration.ts";
import type { RecordingRungs } from "./inventory.ts";
import type { Discrepancy } from "./reconcile.ts";

export interface MigrationCounts {
  /** `"Songs"` rows read (after `--limit`). */
  readonly songs: number;
  readonly byClass: Readonly<Record<MigrationClass, number>>;
  /** Library tracks created or refreshed. */
  readonly migrated: number;
  /** Of those, the ones with no **required** field missing (`docs/03` §6). */
  readonly documentsComplete: number;
  /**
   * Recommended fields still missing across the migrated documents, counted per field.
   *
   * The phase asks for R **and** C. R is met; this is what is left of C, named rather than
   * defined away — `acoustid` is the expected entry, because a migration does not fingerprint
   * the files it adopts.
   */
  readonly recommendedGaps: Readonly<Record<string, number>>;
  readonly importsCreated: number;
  readonly importTracksCreated: number;
  /** Files under the v1 library that no v1 row claims. */
  readonly orphanFiles: number;
  /** Rows with no file: everything that became an import. */
  readonly withoutFile: number;
  readonly filesRetagged: number;
  readonly sidecarsWritten: number;
  readonly replaygainAlbums: number;
  readonly renamed: number;
  /** Files moved into their album's folder by the consolidation. */
  readonly consolidated: number;
  /** Tracks moved from one `library_albums` row to another by the regrouping. */
  readonly regrouped: number;
  /** Album rows the regrouping left with no track, and therefore deleted. */
  readonly albumsRemoved: number;
  /** Albums whose key was a release MBID — the rule. */
  readonly albumsByRelease: number;
  /** Albums that fell back to v1's (album artist, album, year) triple plus the folder. */
  readonly albumsByTags: number;
  /** Present rows with no release MBID at all, which is the only reason `albumsByTags` is not 0. */
  readonly withoutRelease: number;
  /**
   * Where the present rows' recording MBIDs came from, one entry per rung.
   *
   * The release has `withoutRelease` and the albums that follow from it; the recording is the
   * other half of "the MBIDs build the track" and had no number at all. `fromTags` is the one
   * to read: rows whose `Songs` column is empty and whose file still carries what v1 wrote
   * there. They used to migrate with no recording, and nothing in the report said so.
   */
  readonly recordings: RecordingRungs;
  readonly albumsVerified: number;
  readonly inboxItems: number;
  readonly failed: number;
  /** Rows a previous run had already finished, and that this one skipped. */
  readonly alreadyDone: number;
}

export interface ReportAlbum {
  readonly id: string;
  readonly folder: string;
  readonly artist: string;
  readonly title: string;
  readonly year: number | null;
  readonly tracks: number;
  /** 0…1, the mean track completeness. `null` before any document is built. */
  readonly completeness: number | null;
  readonly replaygain: boolean;
  /**
   * The Navidrome read-back, or `failed` when the album never got as far as one.
   *
   * `failed` is the album-level isolation of `run.ts`: the album threw before or during its
   * tracks, every one of them is written down as `failed` in `migration_v1`, and the run went
   * on to the next album rather than stopping. It is the state a re-run retries.
   */
  readonly verified: "ok" | "mismatch" | "not_indexed" | "skipped" | "failed";
}

export interface ReportImport {
  readonly importId: string;
  /** The v1 parent playlist the import was grouped by, or `null` for the loose songs. */
  readonly playlist: string | null;
  readonly url: string;
  readonly status: string;
  readonly tracks: number;
  /** Forced MBIDs carried over as a preselection. */
  readonly preselected: number;
}

export interface ReportRename {
  readonly from: string;
  readonly to: string;
}

export interface ReportMove {
  readonly from: string;
  readonly to: string;
}

/**
 * One album the run regrouped: where its tracks were, and where they go.
 *
 * This is what `--dry-run` prints before anything moves, and it is the whole preview a person
 * needs in order to say yes: which release, which album rows it dissolves, which folder wins,
 * and every file the consolidation touches.
 */
export interface ReportRegroup {
  /** The release MBID that is the album's key, `null` for a tag-grouped album. */
  readonly release: string | null;
  /** `Artist — Title`, for a human. */
  readonly album: string;
  /** The `library_albums` rows the tracks are in today, labelled. */
  readonly from: readonly string[];
  /** The folder the album lands in. */
  readonly to: string;
  readonly tracks: number;
  readonly moves: readonly ReportMove[];
}

export interface ReportError {
  readonly songId: number | null;
  readonly path: string | null;
  readonly message: string;
}

export interface MigrationReport {
  readonly runId: string;
  readonly dryRun: boolean;
  readonly renameToTemplate: boolean;
  /** `release` or `tags` — which rule decided what an album is. */
  readonly groupBy: "release" | "tags";
  /** True when `--keep-folders` suppressed the consolidation. */
  readonly keepFolders: boolean;
  readonly library: string;
  /** The v1 connection string, password removed. */
  readonly database: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly counts: MigrationCounts;
  readonly albums: readonly ReportAlbum[];
  readonly imports: readonly ReportImport[];
  readonly playlists: readonly { name: string; path: string; entries: number; missing: number }[];
  readonly renames: readonly ReportRename[];
  /** The consolidation, file by file. Empty with `--keep-folders`. */
  readonly moves: readonly ReportMove[];
  /** The albums this run regrouped, planned in a dry run and performed in a real one. */
  readonly regroup: readonly ReportRegroup[];
  readonly discrepancies: readonly Discrepancy[];
  readonly errors: readonly ReportError[];
  /**
   * Rows written outside `migration_v1*`. A dry run must end with zero here, and the E2E
   * asserts it rather than trusting the code path (§ Sécurité).
   */
  readonly writes: number;
}

export function emptyCounts(): MigrationCounts {
  return {
    songs: 0,
    byClass: {
      present_with_file: 0,
      present_missing_file: 0,
      needed: 0,
      needs_manual_review: 0,
      failed: 0,
    },
    migrated: 0,
    documentsComplete: 0,
    recommendedGaps: {},
    importsCreated: 0,
    importTracksCreated: 0,
    orphanFiles: 0,
    withoutFile: 0,
    filesRetagged: 0,
    sidecarsWritten: 0,
    replaygainAlbums: 0,
    renamed: 0,
    consolidated: 0,
    regrouped: 0,
    albumsRemoved: 0,
    albumsByRelease: 0,
    albumsByTags: 0,
    withoutRelease: 0,
    recordings: { forced: 0, fromColumn: 0, fromTags: 0, none: 0 },
    albumsVerified: 0,
    inboxItems: 0,
    failed: 0,
    alreadyDone: 0,
  };
}

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */

const CLASS_LABELS: Readonly<Record<MigrationClass, string>> = {
  present_with_file: "present, file found",
  present_missing_file: "present, file missing",
  needed: "never downloaded",
  needs_manual_review: "needs manual review",
  failed: "failed in v1",
};

/** The report as the CLI prints it, and as the phase's acceptance run pastes it. */
export function formatReport(report: MigrationReport): string {
  const lines: string[] = [];
  const { counts } = report;

  lines.push(
    `${report.dryRun ? "Dry run" : "Migration"} ${report.runId} — ${String(counts.songs)} v1 song(s) in ${String(Math.round(report.durationMs / 100) / 10)}s`,
  );
  lines.push(`  v1 database   ${report.database}`);
  lines.push(`  v1 library    ${report.library}`);
  lines.push(
    `  grouping      ${report.groupBy === "release" ? "by v1 release MBID" : "by v1 tags (album artist, album, year) + folder"}` +
      `${report.keepFolders ? ", folders kept as they are" : ""}`,
  );
  lines.push("");

  lines.push("  inventory");
  for (const [name, label] of Object.entries(CLASS_LABELS)) {
    const value = counts.byClass[name as MigrationClass];
    lines.push(`    ${String(value).padStart(5)}  ${label}`);
  }
  lines.push(`    ${String(counts.orphanFiles).padStart(5)}  files no v1 row claims`);
  lines.push(
    `    ${String(counts.albumsByRelease).padStart(5)}  album(s) keyed on a v1 release MBID`,
  );
  lines.push(
    `    ${String(counts.albumsByTags).padStart(5)}  album(s) keyed on v1 tags, for ${String(counts.withoutRelease)} row(s) with no release`,
  );
  /*
   * `migrate show <run id>` renders whatever JSON was stored at the time, and stored reports
   * are never migrated, so a run from before this counter existed has no `recordings` at all.
   * Skip the line rather than crash on it: an old report is still worth reading.
   */
  const recordings = counts.recordings as RecordingRungs | undefined;
  if (recordings !== undefined) {
    lines.push(
      `    ${String(recordings.fromTags).padStart(5)}  recording MBID(s) read off MUSICBRAINZ_TRACKID in the file` +
        ` (${String(recordings.forced)} forced, ${String(recordings.fromColumn)} from the v1 column,` +
        ` ${String(recordings.none)} row(s) with no recording)`,
    );
  }
  lines.push("");

  lines.push(report.dryRun ? "  would do" : "  did");
  lines.push(`    ${String(counts.migrated).padStart(5)}  library track(s)`);
  lines.push(
    `    ${String(counts.documentsComplete).padStart(5)}  document(s) with every required field`,
  );
  const gaps = Object.entries(counts.recommendedGaps).sort((left, right) => right[1] - left[1]);
  if (gaps.length > 0) {
    lines.push(
      `           recommended still missing: ${gaps
        .map(([field, count]) => `${field} (${String(count)})`)
        .join(", ")}`,
    );
  }
  lines.push(`    ${String(counts.filesRetagged).padStart(5)}  file(s) re-tagged in place`);
  lines.push(`    ${String(counts.sidecarsWritten).padStart(5)}  sidecar(s)`);
  lines.push(`    ${String(counts.replaygainAlbums).padStart(5)}  album(s) with ReplayGain`);
  lines.push(`    ${String(counts.importsCreated).padStart(5)}  import(s) created`);
  lines.push(`    ${String(counts.importTracksCreated).padStart(5)}  import track(s)`);
  lines.push(`    ${String(counts.renamed).padStart(5)}  file(s) renamed to the v2 template`);
  lines.push(
    `    ${String(counts.consolidated).padStart(5)}  file(s) moved into their album's folder`,
  );
  lines.push(`    ${String(counts.regrouped).padStart(5)}  track(s) moved to another album row`);
  lines.push(
    `    ${String(counts.albumsRemoved).padStart(5)}  album row(s) left empty and removed`,
  );
  lines.push(`    ${String(counts.inboxItems).padStart(5)}  Inbox item(s)`);
  lines.push(`    ${String(counts.alreadyDone).padStart(5)}  row(s) already done, skipped`);
  lines.push(`    ${String(counts.failed).padStart(5)}  failure(s)`);

  if (report.albums.length > 0) {
    lines.push("");
    lines.push("  albums");
    for (const album of report.albums) {
      const score =
        album.completeness === null ? "  ·  " : `${String(Math.round(album.completeness * 100))}%`;
      lines.push(
        `    ${score.padStart(5)}  ${String(album.tracks).padStart(3)} tr  ${album.artist} — ${album.title}` +
          `${album.replaygain ? "  [rg]" : ""}` +
          // An album the run could not migrate is listed with the others rather than only in
          // `errors`, because "which albums came out of this" is the question this block
          // answers and an answer that silently omits one is worse than no answer.
          `${album.verified === "failed" ? "  [FAILED — run it again]" : ""}`,
      );
    }
  }

  if (report.imports.length > 0) {
    lines.push("");
    lines.push("  imports created");
    for (const created of report.imports) {
      lines.push(
        `    ${created.importId}  ${String(created.tracks).padStart(3)} tr  ${created.status.padEnd(16)}` +
          `  ${created.playlist ?? "(no playlist)"}`,
      );
    }
  }

  if (report.playlists.length > 0) {
    lines.push("");
    lines.push("  playlists exported");
    for (const playlist of report.playlists) {
      lines.push(
        `    ${String(playlist.entries).padStart(4)} entries (${String(playlist.missing)} not migrated)  ${playlist.name}`,
      );
    }
  }

  if (report.regroup.length > 0) {
    lines.push("");
    lines.push(report.dryRun ? "  would regroup" : "  regrouped");
    for (const entry of report.regroup.slice(0, 30)) {
      lines.push(
        `    ${entry.album}  ${String(entry.tracks)} tr` +
          `${entry.release === null ? "" : `  release ${entry.release}`}`,
      );
      for (const from of entry.from) lines.push(`      was in  ${from}`);
      lines.push(`      now in  ${entry.to}`);
    }
    if (report.regroup.length > 30) {
      lines.push(`    … and ${String(report.regroup.length - 30)} more`);
    }
  }

  if (report.moves.length > 0) {
    lines.push("");
    lines.push(
      report.dryRun
        ? "  would move into the album folder (Navidrome play counts follow the path)"
        : "  moved into the album folder — Navidrome play counts follow the path",
    );
    for (const move of report.moves.slice(0, 20)) {
      lines.push(`    ${move.from}`);
      lines.push(`      → ${move.to}`);
    }
    if (report.moves.length > 20) {
      lines.push(`    … and ${String(report.moves.length - 20)} more`);
    }
  }

  if (report.renames.length > 0) {
    lines.push("");
    lines.push("  renames");
    for (const rename of report.renames.slice(0, 20)) {
      lines.push(`    ${rename.from}`);
      lines.push(`      → ${rename.to}`);
    }
    if (report.renames.length > 20) {
      lines.push(`    … and ${String(report.renames.length - 20)} more`);
    }
  }

  if (report.discrepancies.length > 0) {
    lines.push("");
    lines.push(`  discrepancies (${String(report.discrepancies.length)})`);
    for (const item of report.discrepancies.slice(0, 30)) {
      lines.push(`    ${item.kind.padEnd(19)} ${item.detail}`);
    }
    if (report.discrepancies.length > 30) {
      lines.push(`    … and ${String(report.discrepancies.length - 30)} more`);
    }
  }

  if (report.errors.length > 0) {
    lines.push("");
    lines.push(`  errors (${String(report.errors.length)})`);
    for (const failure of report.errors.slice(0, 30)) {
      lines.push(`    ${failure.path ?? `song ${String(failure.songId)}`}: ${failure.message}`);
    }
  }

  lines.push("");
  lines.push(
    report.dryRun
      ? `  dry run: ${String(report.writes)} row(s) written outside migration_v1 (must be 0)`
      : `  ${String(report.writes)} row(s) written`,
  );

  return lines.join("\n");
}
