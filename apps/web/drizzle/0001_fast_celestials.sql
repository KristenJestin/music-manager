CREATE TYPE "public"."decision_kind" AS ENUM('release', 'mapping', 'inbox', 'option');--> statement-breakpoint
CREATE TYPE "public"."event_level" AS ENUM('info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."import_kind" AS ENUM('album', 'single', 'playlist', 'channel');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('pending', 'running', 'awaiting_confirm', 'awaiting_review', 'paused', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."inbox_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."inbox_type" AS ENUM('ambiguous_release', 'ambiguous_recording', 'uncovered_tracks', 'extra_videos', 'fingerprint_mismatch', 'job_failed', 'ytdlp_update', 'cookies_expiring', 'album_incomplete', 'orphan_files', 'duplicate_recording', 'verify_mismatch');--> statement-breakpoint
CREATE TYPE "public"."step_name" AS ENUM('resolve', 'match', 'confirm', 'download', 'fingerprint', 'tag', 'place', 'verify');--> statement-breakpoint
CREATE TYPE "public"."step_status" AS ENUM('pending', 'running', 'done', 'blocked', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."track_role" AS ENUM('mapped', 'extra', 'unmatched');--> statement-breakpoint
CREATE TYPE "public"."track_state" AS ENUM('pending', 'downloaded', 'fingerprinted', 'tagged', 'placed', 'done', 'skipped', 'failed');--> statement-breakpoint
CREATE TABLE "import_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"position" integer NOT NULL,
	"video_id" text NOT NULL,
	"url" text NOT NULL,
	"source_title" text NOT NULL,
	"source_duration" double precision,
	"uploader" text,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"role" "track_role" DEFAULT 'unmatched' NOT NULL,
	"state" "track_state" DEFAULT 'pending' NOT NULL,
	"track_mbid" text,
	"recording_mbid" text,
	"track_title" text,
	"track_position" integer,
	"medium_position" integer,
	"confidence" double precision,
	"download_path" text,
	"downloaded_bytes" integer,
	"fingerprint" text,
	"fingerprint_duration" double precision,
	"acoustid_mbid" text,
	"fingerprint_ok" boolean,
	"library_path" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"kind" "import_kind" NOT NULL,
	"status" "import_status" DEFAULT 'pending' NOT NULL,
	"step" "step_name" DEFAULT 'resolve' NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"release_mbid" text,
	"release_group_mbid" text,
	"title" text,
	"artist" text,
	"year" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"import_id" text,
	"track_id" text,
	"step" "step_name",
	"level" "event_level" DEFAULT 'info' NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"import_id" text NOT NULL,
	"step" "step_name" NOT NULL,
	"status" "step_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_albums" (
	"id" text PRIMARY KEY NOT NULL,
	"release_mbid" text,
	"release_group_mbid" text,
	"album_artist" text NOT NULL,
	"title" text NOT NULL,
	"year" integer,
	"folder" text NOT NULL,
	"track_count" integer DEFAULT 0 NOT NULL,
	"present_count" integer DEFAULT 0 NOT NULL,
	"completeness" double precision,
	"cover_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"album_id" text,
	"recording_mbid" text,
	"track_mbid" text,
	"title" text NOT NULL,
	"artist" text,
	"disc_number" integer,
	"track_number" integer,
	"path" text NOT NULL,
	"format" text,
	"size" bigint,
	"duration" double precision,
	"tag_schema_version" integer,
	"projection_hash" text,
	"import_id" text,
	"import_track_id" text,
	"verified_at" timestamp with time zone,
	"verify_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artists_cache" (
	"artist_mbid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort_name" text,
	"country" text,
	"image_url" text,
	"payload" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "metadata_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"import_track_id" text,
	"library_track_id" text,
	"recording_mbid" text,
	"document" jsonb NOT NULL,
	"tag_schema_version" integer NOT NULL,
	"projection_hash" text,
	"completeness" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_cache" (
	"source" text NOT NULL,
	"key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"etag" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_cache_source_key_pk" PRIMARY KEY("source","key")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "decision_kind" NOT NULL,
	"import_id" text,
	"inbox_item_id" text,
	"subject" text,
	"choice" jsonb NOT NULL,
	"decided_by" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbox_items" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "inbox_type" NOT NULL,
	"status" "inbox_status" DEFAULT 'open' NOT NULL,
	"import_id" text,
	"track_id" text,
	"title" text NOT NULL,
	"summary" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preselected" jsonb,
	"resolution" jsonb,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"set_by" text DEFAULT 'user' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_tracks" ADD CONSTRAINT "import_tracks_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_track_id_import_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."import_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_album_id_library_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."library_albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_tracks" ADD CONSTRAINT "library_tracks_import_track_id_import_tracks_id_fk" FOREIGN KEY ("import_track_id") REFERENCES "public"."import_tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_documents" ADD CONSTRAINT "metadata_documents_import_track_id_import_tracks_id_fk" FOREIGN KEY ("import_track_id") REFERENCES "public"."import_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "metadata_documents" ADD CONSTRAINT "metadata_documents_library_track_id_library_tracks_id_fk" FOREIGN KEY ("library_track_id") REFERENCES "public"."library_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_track_id_import_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."import_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "import_tracks_import_position_idx" ON "import_tracks" USING btree ("import_id","position");--> statement-breakpoint
CREATE INDEX "import_tracks_state_idx" ON "import_tracks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "import_tracks_recording_idx" ON "import_tracks" USING btree ("recording_mbid");--> statement-breakpoint
CREATE INDEX "imports_status_idx" ON "imports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "imports_created_at_idx" ON "imports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "imports_release_mbid_idx" ON "imports" USING btree ("release_mbid");--> statement-breakpoint
CREATE INDEX "imports_url_idx" ON "imports" USING btree ("url");--> statement-breakpoint
CREATE INDEX "job_events_import_id_idx" ON "job_events" USING btree ("import_id","id");--> statement-breakpoint
CREATE INDEX "job_events_at_idx" ON "job_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "job_steps_import_step_idx" ON "job_steps" USING btree ("import_id","step");--> statement-breakpoint
CREATE INDEX "job_steps_status_idx" ON "job_steps" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "library_albums_folder_idx" ON "library_albums" USING btree ("folder");--> statement-breakpoint
CREATE INDEX "library_albums_release_mbid_idx" ON "library_albums" USING btree ("release_mbid");--> statement-breakpoint
CREATE UNIQUE INDEX "library_tracks_path_idx" ON "library_tracks" USING btree ("path");--> statement-breakpoint
CREATE INDEX "library_tracks_recording_idx" ON "library_tracks" USING btree ("recording_mbid");--> statement-breakpoint
CREATE INDEX "library_tracks_album_idx" ON "library_tracks" USING btree ("album_id");--> statement-breakpoint
CREATE INDEX "artists_cache_name_idx" ON "artists_cache" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "metadata_documents_import_track_idx" ON "metadata_documents" USING btree ("import_track_id");--> statement-breakpoint
CREATE INDEX "metadata_documents_library_track_idx" ON "metadata_documents" USING btree ("library_track_id");--> statement-breakpoint
CREATE INDEX "metadata_documents_recording_idx" ON "metadata_documents" USING btree ("recording_mbid");--> statement-breakpoint
CREATE INDEX "metadata_documents_schema_idx" ON "metadata_documents" USING btree ("tag_schema_version");--> statement-breakpoint
CREATE INDEX "source_cache_fetched_at_idx" ON "source_cache" USING btree ("fetched_at");--> statement-breakpoint
CREATE INDEX "decisions_import_idx" ON "decisions" USING btree ("import_id");--> statement-breakpoint
CREATE INDEX "decisions_kind_idx" ON "decisions" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "inbox_items_status_idx" ON "inbox_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "inbox_items_type_idx" ON "inbox_items" USING btree ("type");--> statement-breakpoint
CREATE INDEX "inbox_items_import_idx" ON "inbox_items" USING btree ("import_id");