-- Merge the duplicate `library_tracks` rows a `pathTemplate` change created.
--
-- A track's identity was its path, so renaming the files and re-importing inserted a second
-- row per track instead of updating the first. One reported album carried twenty-five rows for
-- thirteen songs — twelve real ones and thirteen pointing at files that no longer existed —
-- and `quality.trackCount`, the completeness score, `relocate` and `verify` each answered with
-- a different wrong number as a result.
--
-- The next migration adds the two unique indexes that make it impossible; this one makes the
-- existing data satisfy them. It runs before them, and it must, because a `CREATE UNIQUE INDEX`
-- on duplicated rows fails and takes the whole migration with it.
--
-- **Which row survives.** Postgres cannot stat a file, so the ordering below is the best
-- evidence the database itself holds, strongest first:
--
--   1. a row a metadata document points at — that is the row the rest of the app uses;
--   2. a row that still knows which import produced it (`import_track_id`);
--   3. the most recently written one — after a re-import that is the new file, and the ghost is
--      the old name.
--
-- The disk itself has the last word, but later: `mergeDuplicateTracks` in `services/scan.ts`
-- runs inside every `scan`, sees which paths exist, and keeps the row whose file is there.
-- What this migration has to guarantee is only that the constraint can be created.
--> statement-breakpoint
WITH scored AS (
	SELECT
		t."id",
		t."album_id",
		t."recording_mbid",
		t."disc_number",
		t."track_number",
		(EXISTS (SELECT 1 FROM "metadata_documents" d WHERE d."library_track_id" = t."id"))::int AS has_document,
		(t."import_track_id" IS NOT NULL)::int AS has_import,
		t."updated_at",
		t."created_at"
	FROM "library_tracks" t
), ranked AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "album_id", "recording_mbid"
			ORDER BY has_document DESC, has_import DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS rank
	FROM scored
	WHERE "album_id" IS NOT NULL AND "recording_mbid" IS NOT NULL
)
DELETE FROM "library_tracks" WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);
--> statement-breakpoint
WITH scored AS (
	SELECT
		t."id",
		t."album_id",
		t."disc_number",
		t."track_number",
		(EXISTS (SELECT 1 FROM "metadata_documents" d WHERE d."library_track_id" = t."id"))::int AS has_document,
		(t."import_track_id" IS NOT NULL)::int AS has_import,
		t."updated_at",
		t."created_at"
	FROM "library_tracks" t
), ranked AS (
	SELECT
		"id",
		row_number() OVER (
			PARTITION BY "album_id", coalesce("disc_number", 1), "track_number"
			ORDER BY has_document DESC, has_import DESC, "updated_at" DESC, "created_at" DESC, "id" DESC
		) AS rank
	FROM scored
	WHERE "album_id" IS NOT NULL AND "track_number" IS NOT NULL
)
DELETE FROM "library_tracks" WHERE "id" IN (SELECT "id" FROM ranked WHERE rank > 1);
--> statement-breakpoint
-- The counters on the album row were computed from the rows just removed.
UPDATE "library_albums" a
SET
	"track_count" = GREATEST(counts.n, 0),
	"present_count" = LEAST(a."present_count", counts.n),
	"updated_at" = now()
FROM (
	SELECT "album_id" AS id, count(*)::int AS n
	FROM "library_tracks"
	WHERE "album_id" IS NOT NULL
	GROUP BY "album_id"
) counts
WHERE a."id" = counts.id AND a."track_count" <> counts.n;
