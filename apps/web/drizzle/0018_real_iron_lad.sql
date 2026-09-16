CREATE TYPE "public"."paused_by" AS ENUM('user', 'worker');--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "paused_by" "paused_by";