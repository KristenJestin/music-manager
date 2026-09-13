CREATE TYPE "public"."watched_item_status" AS ENUM('new', 'imported', 'skipped', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."watched_scan_status" AS ENUM('never', 'ok', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."watched_source_kind" AS ENUM('playlist', 'channel');--> statement-breakpoint
ALTER TYPE "public"."inbox_type" ADD VALUE 'source_new_video';--> statement-breakpoint
CREATE TABLE "watched_source_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"video_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"import_id" text,
	"status" "watched_item_status" DEFAULT 'new' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watched_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"kind" "watched_source_kind" NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_accept" boolean DEFAULT false NOT NULL,
	"auto_accept_threshold" double precision,
	"min_duration" integer,
	"max_duration" integer,
	"require_provided_to_youtube" boolean DEFAULT false NOT NULL,
	"last_scan_at" timestamp with time zone,
	"last_scan_status" "watched_scan_status" DEFAULT 'never' NOT NULL,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "watched_source_items" ADD CONSTRAINT "watched_source_items_source_id_watched_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."watched_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watched_source_items" ADD CONSTRAINT "watched_source_items_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "watched_source_items_source_video_idx" ON "watched_source_items" USING btree ("source_id","video_id");--> statement-breakpoint
CREATE INDEX "watched_source_items_status_idx" ON "watched_source_items" USING btree ("status");--> statement-breakpoint
CREATE INDEX "watched_source_items_import_idx" ON "watched_source_items" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "watched_sources_url_idx" ON "watched_sources" USING btree ("url");--> statement-breakpoint
CREATE INDEX "watched_sources_enabled_idx" ON "watched_sources" USING btree ("enabled");