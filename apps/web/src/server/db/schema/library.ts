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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("library_tracks_path_idx").on(table.path),
    index("library_tracks_recording_idx").on(table.recordingMbid),
    index("library_tracks_album_idx").on(table.albumId),
  ],
);

export type LibraryAlbum = typeof libraryAlbums.$inferSelect;
export type NewLibraryAlbum = typeof libraryAlbums.$inferInsert;
export type LibraryTrack = typeof libraryTracks.$inferSelect;
export type NewLibraryTrack = typeof libraryTracks.$inferInsert;
