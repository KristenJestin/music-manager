CREATE TABLE "library_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"files_seen" integer DEFAULT 0 NOT NULL,
	"tracked" integer DEFAULT 0 NOT NULL,
	"orphans" integer DEFAULT 0 NOT NULL,
	"missing" integer DEFAULT 0 NOT NULL,
	"drift" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"report" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "library_scans_started_idx" ON "library_scans" USING btree ("started_at");