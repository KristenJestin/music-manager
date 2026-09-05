/**
 * The three layers of `docs/03-metadonnees.md` §1, persisted.
 *
 *  - `source_cache`        layer 1: every source response, verbatim, never purged (§8);
 *  - `metadata_documents`  layer 2: one document per track, with provenance per field;
 *  - `artists_cache`       the artist entities the document and the sidecars need.
 *
 * The document is a pure function of the cache, so both can be rebuilt from the other's
 * absence: dropping documents costs a recomputation, dropping the cache costs the network.
 */
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { importTracks } from "./imports.ts";
import { libraryTracks } from "./library.ts";

/**
 * Layer 1. Keyed by `(source, key)` — `("musicbrainz", "release/d073287b-…")`,
 * `("lrclib", "search?track=One+More+Time&artist=Daft+Punk")`. `etag` lets P04 revalidate
 * without re-downloading; `fetched_at` is what the resolvers stamp on every field.
 */
export const sourceCache = pgTable(
  "source_cache",
  {
    source: text("source").notNull(),
    key: text("key").notNull(),
    payload: jsonb("payload").notNull(),
    etag: text("etag"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.source, table.key] }),
    index("source_cache_fetched_at_idx").on(table.fetchedAt),
  ],
);

/**
 * Layer 2. One row per track document. It is attached to the import track that produced it
 * and, once `place` has run, to the library track it describes.
 */
export const metadataDocuments = pgTable(
  "metadata_documents",
  {
    id: text("id").primaryKey(),
    importTrackId: text("import_track_id").references(() => importTracks.id, {
      onDelete: "cascade",
    }),
    libraryTrackId: text("library_track_id").references(() => libraryTracks.id, {
      onDelete: "cascade",
    }),
    recordingMbid: text("recording_mbid"),
    /** The `TrackDocument` of `@mm/domain`: `{ fields, na, schemaVersion }`. */
    document: jsonb("document").$type<Record<string, unknown>>().notNull(),
    /** `MUSICMANAGER_TAGSCHEMA` this document was projected under (§1, §8). */
    tagSchemaVersion: integer("tag_schema_version").notNull(),
    /** Hash of the projected Vorbis pairs — the re-tag's "has anything changed?". */
    projectionHash: text("projection_hash"),
    completeness: doublePrecision("completeness"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("metadata_documents_import_track_idx").on(table.importTrackId),
    index("metadata_documents_library_track_idx").on(table.libraryTrackId),
    index("metadata_documents_recording_idx").on(table.recordingMbid),
    index("metadata_documents_schema_idx").on(table.tagSchemaVersion),
  ],
);

/** Artists, cached whole: the sidecar `artist.jpg`, `ARTISTSORT`, and P09's Discover. */
export const artistsCache = pgTable(
  "artists_cache",
  {
    artistMbid: text("artist_mbid").primaryKey(),
    name: text("name").notNull(),
    sortName: text("sort_name"),
    country: text("country"),
    imageUrl: text("image_url"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("artists_cache_name_idx").on(table.name)],
);

export type SourceCacheRow = typeof sourceCache.$inferSelect;
export type NewSourceCacheRow = typeof sourceCache.$inferInsert;
export type MetadataDocumentRow = typeof metadataDocuments.$inferSelect;
export type NewMetadataDocumentRow = typeof metadataDocuments.$inferInsert;
export type ArtistCacheRow = typeof artistsCache.$inferSelect;
export type NewArtistCacheRow = typeof artistsCache.$inferInsert;
