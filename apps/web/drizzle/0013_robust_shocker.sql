CREATE TABLE "discover_playlists" (
	"server" text PRIMARY KEY NOT NULL,
	"playlist_id" text NOT NULL,
	"name" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
