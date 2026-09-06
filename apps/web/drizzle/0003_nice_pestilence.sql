CREATE TYPE "public"."retag_scope" AS ENUM('library', 'album', 'track');--> statement-breakpoint
CREATE TYPE "public"."retag_status" AS ENUM('pending', 'running', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."retag_trigger" AS ENUM('manual', 'schema', 'sources', 'cron');--> statement-breakpoint
CREATE TABLE "retag_diffs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"library_track_id" text,
	"album_id" text,
	"path" text NOT NULL,
	"added" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unchanged" integer DEFAULT 0 NOT NULL,
	"wrote" boolean DEFAULT false NOT NULL,
	"schema_before" integer,
	"schema_after" integer,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retag_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" "retag_scope" DEFAULT 'library' NOT NULL,
	"target_id" text,
	"trigger" "retag_trigger" DEFAULT 'manual' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"status" "retag_status" DEFAULT 'pending' NOT NULL,
	"schema_version" integer NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"message" text,
	"error" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_albums" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "library_albums" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retag_diffs" ADD CONSTRAINT "retag_diffs_run_id_retag_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."retag_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retag_diffs" ADD CONSTRAINT "retag_diffs_library_track_id_library_tracks_id_fk" FOREIGN KEY ("library_track_id") REFERENCES "public"."library_tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retag_diffs" ADD CONSTRAINT "retag_diffs_album_id_library_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."library_albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retag_diffs_run_idx" ON "retag_diffs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "retag_diffs_track_idx" ON "retag_diffs" USING btree ("library_track_id");--> statement-breakpoint
CREATE INDEX "retag_runs_status_idx" ON "retag_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "retag_runs_created_at_idx" ON "retag_runs" USING btree ("created_at");