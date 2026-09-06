/**
 * What is actually on disk (`docs/04-pipeline-et-matching.md` § Modèle, `library_*`).
 *
 * These tables are the answer to two questions the pipeline asks constantly: "do I already
 * have this recording?" (idempotence, `docs/04` § Règles) and "which file does this document
 * project into?" (the background re-tag of `docs/03-metadonnees.md` §8).
 *
 * Paths are stored **library-relative** and with `/` separators, never host-absolute: the
 * same rows are read by the worker on Windows and by the toolbox inside Linux.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { imports, importTracks } from "./imports.ts";

export const libraryAlbums = pgTable(
  "library_albums",
  {
    id: text("id").primaryKey(),
    releaseMbid: text("release_mbid"),
    releaseGroupMbid: text("release_group_mbid"),
    albumArtist: text("album_artist").notNull(),
    title: text("title").notNull(),
    year: integer("year"),
    /** `Daft Punk/Discovery (2001)` — relative to the library root. */
    folder: text("folder").notNull(),
    trackCount: integer("track_count").notNull().default(0),
    presentCount: integer("present_count").notNull().default(0),
    completeness: doublePrecision("completeness"),
    coverPath: text("cover_path"),
    /**
     * The last OpenSubsonic read-back (`docs/03-metadonnees.md` §7), as an `AlbumVerification`
     * from `src/server/services/verify.ts`: one verdict per field, `ok | mismatch |
     * not_indexed`, plus what was written and what came back.
     */
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_albums_folder_idx").on(table.folder),
    index("library_albums_release_mbid_idx").on(table.releaseMbid),
  ],
);

export const libraryTracks = pgTable(
  "library_tracks",
  {
    id: text("id").primaryKey(),
    albumId: text("album_id").references(() => libraryAlbums.id, { onDelete: "cascade" }),
    recordingMbid: text("recording_mbid"),
    trackMbid: text("track_mbid"),
    title: text("title").notNull(),
    artist: text("artist"),
    discNumber: integer("disc_number"),
    trackNumber: integer("track_number"),
    /** `Daft Punk/Discovery (2001)/01 One More Time.opus`. */
    path: text("path").notNull(),
    format: text("format"),
    size: bigint("size", { mode: "number" }),
    duration: doublePrecision("duration"),
    /** `MUSICMANAGER_TAGSCHEMA` written into the file (`docs/03` §1). */
    tagSchemaVersion: integer("tag_schema_version"),
    /** Hash of the projected key/value list, so a re-tag can skip an unchanged file. */
    projectionHash: text("projection_hash"),
    importId: text("import_id").references(() => imports.id, { onDelete: "set null" }),
    importTrackId: text("import_track_id").references(() => importTracks.id, {
      onDelete: "set null",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyResult: jsonb("verify_result").$type<Record<string, unknown>>(),
    /**
     * When a library scan last found this row's file **absent from disk**, `null` when the
     * file was there.
     *
     * The scan already knew — it reports "missing files" on the Tools page — and nothing else
     * did: an album whose `13 - Wonderland.opus` had been deleted by hand still announced
     * "13/13 tracks · 50.6 MB", and the track still carried its `lrc` and `rg` badges
     * (DRIVE-1 §B5). `albumDetail` stats each file on its way to one album, which is right for
     * one album and impossible for a grid of hundreds; a column the scan writes is what lets
     * the grid, the filters and the Quality page say the same true thing without walking the
     * tree. It is a *fact with a date on it*, not a flag: "the scan of 14:32 could not find
     * this" is honest even if somebody has since plugged the drive back in.
     */
    missingAt: timestamp("missing_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_tracks_path_idx").on(table.path),
    index("library_tracks_recording_idx").on(table.recordingMbid),
    index("library_tracks_album_idx").on(table.albumId),
    /*
     * **A track's identity is not its path.**
     *
     * It was, and changing `pathTemplate` then re-importing an album produced a second row per
     * track: twenty-five rows for a thirteen-track record, thirteen of them pointing at files
     * that no longer existed. `quality.trackCount` then said 25, the score was computed on it,
     * `relocate` classified the ghosts as `missing-file` and could not remove them (it moves
     * files, it never deletes a row), and `verify` picked a ghost as "the album's first track"
     * and gave up. One setting change, four wrong answers — that is data corruption, not an
     * inconvenience.
     *
     * The real identity is what MusicBrainz already gives us: **the recording, inside the
     * album**. A partial unique index is the right shape for it because `recording_mbid` is
     * legitimately null for an untagged import, and Postgres does not constrain what does not
     * exist.
     */
    uniqueIndex("library_tracks_album_recording_idx")
      .on(table.albumId, table.recordingMbid)
      .where(sql`${table.albumId} is not null and ${table.recordingMbid} is not null`),
    /*
     * And the position inside the album is the identity of an untagged track: two files cannot
     * both be track 4 of the same album. Partial for the same reason — a row with no track
     * number is a file we know too little about to constrain.
     *
     * `coalesce(disc_number, 1)` rather than the column, because a unique index treats two
     * nulls as *distinct*: without it, the single-disc case — where the document simply never
     * carried a `discnumber` — would be exempt from the constraint, and the single-disc case is
     * the one this bug was reported on.
     */
    uniqueIndex("library_tracks_album_position_idx")
      .on(table.albumId, sql`coalesce(${table.discNumber}, 1)`, table.trackNumber)
      .where(sql`${table.albumId} is not null and ${table.trackNumber} is not null`),
  ],
);

export type LibraryAlbum = typeof libraryAlbums.$inferSelect;
export type NewLibraryAlbum = typeof libraryAlbums.$inferInsert;
export type LibraryTrack = typeof libraryTracks.$inferSelect;
export type NewLibraryTrack = typeof libraryTracks.$inferInsert;
