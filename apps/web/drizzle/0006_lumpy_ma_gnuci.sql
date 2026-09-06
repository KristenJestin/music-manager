CREATE TABLE "migration_v1" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text,
	"v1_song_id" text NOT NULL,
	"v1_path" text,
	"path" text,
	"classification" text NOT NULL,
	"outcome" text DEFAULT 'planned' NOT NULL,
	"matched_by" text DEFAULT 'none' NOT NULL,
	"library_album_id" text,
	"library_track_id" text,
	"document_id" text,
	"import_id" text,
	"import_track_id" text,
	"renamed_from" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "migration_v1_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text DEFAULT 'cli' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"rename_to_template" boolean DEFAULT false NOT NULL,
	"library_path" text DEFAULT '' NOT NULL,
	"db_label" text DEFAULT '' NOT NULL,
	"limit" integer,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"migrated" integer DEFAULT 0 NOT NULL,
	"imports_created" integer DEFAULT 0 NOT NULL,
	"orphan_files" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"message" text,
	"error" jsonb,
	"report" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_v1_song_idx" ON "migration_v1" USING btree ("v1_song_id");--> statement-breakpoint
CREATE INDEX "migration_v1_run_idx" ON "migration_v1" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "migration_v1_outcome_idx" ON "migration_v1" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "migration_v1_path_idx" ON "migration_v1" USING btree ("path");--> statement-breakpoint
CREATE INDEX "migration_v1_runs_status_idx" ON "migration_v1_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "migration_v1_runs_created_at_idx" ON "migration_v1_runs" USING btree ("created_at");