ALTER TYPE "public"."import_status" ADD VALUE 'waiting_upstream' BEFORE 'done';--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "upstream_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "imports_next_attempt_at_idx" ON "imports" USING btree ("next_attempt_at");