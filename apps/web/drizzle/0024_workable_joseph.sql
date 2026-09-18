ALTER TYPE "public"."track_state" ADD VALUE 'sourceless';--> statement-breakpoint
ALTER TABLE "import_tracks" ALTER COLUMN "video_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "import_tracks" ALTER COLUMN "url" DROP NOT NULL;