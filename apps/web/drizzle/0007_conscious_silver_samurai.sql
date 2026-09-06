CREATE TYPE "public"."discover_kind" AS ENUM('discography', 'recommendation', 'similar_artist');--> statement-breakpoint
CREATE TYPE "public"."discover_status" AS ENUM('open', 'later', 'imported');--> statement-breakpoint
CREATE TABLE "discover_dismissals" (
	"subject" text PRIMARY KEY NOT NULL,
	"kind" "discover_kind" NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discover_items" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "discover_kind" NOT NULL,
	"status" "discover_status" DEFAULT 'open' NOT NULL,
	"subject" text NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"album_title" text,
	"artist_mbid" text,
	"release_group_mbid" text,
	"recording_mbid" text,
	"year" integer,
	"primary_type" text,
	"secondary_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	"source" text NOT NULL,
	"in_library" boolean DEFAULT false NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sync_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discover_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"discography_count" integer DEFAULT 0 NOT NULL,
	"recommendation_count" integer DEFAULT 0 NOT NULL,
	"similar_artist_count" integer DEFAULT 0 NOT NULL,
	"signals" jsonb,
	"error" text
);
--> statement-breakpoint
CREATE INDEX "discover_dismissals_kind_idx" ON "discover_dismissals" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "discover_items_subject_idx" ON "discover_items" USING btree ("kind","subject");--> statement-breakpoint
CREATE INDEX "discover_items_kind_score_idx" ON "discover_items" USING btree ("kind","score");--> statement-breakpoint
CREATE INDEX "discover_items_sync_idx" ON "discover_items" USING btree ("sync_id");