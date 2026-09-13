import { readFile } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { db } from "#/server/db/client.ts";
import { placedArtistImage } from "#/server/services/library.ts";

/**
 * `GET /api/artist-image?artist=<name>` — the `artist.jpg` that sits beside an artist's folder.
 *
 * Modelled on `api.cover.ts`. The library is a directory on the host; a browser cannot read
 * it, so the one file of it the artists page wants gets an endpoint. It takes an **artist
 * name**, not a path — `artistList` groups by `library_albums.album_artist`, which is the
 * string the folders are named after (there is no MBID for every artist, but there is always
 * a name), so the row says where the file is (`server/services/library.ts`,
 * `placedArtistImage`) and no library path is ever in a URL and none can be walked out of.
 *
 * A **404 is a normal answer** — most artists have no placed image — and it is the signal the
 * `<Cover>` tile is built around: the browser's own failed load moves it to the next
 * candidate, `artists_cache.imageUrl`, and then to the gradient. Nothing waits on a probe.
 *
 * Session-gated like every other route (`AGENTS.md`, "One account"). `<img src>` carries the
 * session cookie on a same-origin request, so the tiles need nothing extra.
 *
 * No component: a route with only `server.handlers` is an API endpoint.
 */
export const Route = createFileRoute("/api/artist-image")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSession(request.headers);
        if (session === null) return new Response("unauthorized", { status: 401 });

        const artist = new URL(request.url).searchParams.get("artist") ?? "";
        if (artist === "") return new Response("artist name required", { status: 400 });

        const image = await placedArtistImage(artist, db());
        if (image === null) return new Response("no image for this artist", { status: 404 });

        // The tile is drawn on every list that mentions the artist, so the cheap conditional
        // request is worth the four lines: a re-render costs a 304 rather than the JPEG again.
        if (request.headers.get("if-none-match") === image.etag) {
          return new Response(null, { status: 304, headers: { ETag: image.etag } });
        }

        const bytes = await readFile(image.file);
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": image.contentType,
            "Content-Length": String(image.bytes),
            ETag: image.etag,
            // Private: it is the owner's library, not something a proxy may keep for anyone.
            "Cache-Control": "private, max-age=300, must-revalidate",
          },
        });
      },
    },
  },
});
