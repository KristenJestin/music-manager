CREATE TABLE "source_rate_limit" (
	"source" text PRIMARY KEY NOT NULL,
	"next_free_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
