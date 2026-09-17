CREATE TABLE "inbox_dismissals" (
	"subject" text PRIMARY KEY NOT NULL,
	"type" "inbox_type" NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "inbox_dismissals_type_idx" ON "inbox_dismissals" USING btree ("type");