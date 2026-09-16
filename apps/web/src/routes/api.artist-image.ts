import { readFile } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { db } from "#/server/db/client.ts";
import { parseImageSize, respondWithImage } from "#/server/services/image-variants.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { placedArtistImage } from "#/server/services/library.ts";
import { loadSettings } from "#/server/services/settings.ts";

/**
 * `GET /api/artist-image?artist=<name>[&size=64|160|320|640|original]` — the `artist.jpg` that
 * sits beside an artist's folder, at the size the caller is going to draw it.
 *
 * Modelled on `api.cover.ts`, down to the `size` parameter and the variant cache behind it
 * (`services/image-variants.ts`). The library is a directory on the host; a browser cannot read
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

        const params = new URL(request.url).searchParams;
        const artist = params.get("artist") ?? "";
        if (artist === "") return new Response("artist name required", { status: 400 });

        const size = parseImageSize(params.get("size"));
        if (size === null) return new Response("unsupported size", { status: 400 });

        const image = await placedArtistImage(artist, db());
        if (image === null) return new Response("no image for this artist", { status: 404 });

        return await respondWithImage({
          request,
          placed: image,
          size,
          paths: resolvePaths(await loadSettings(db())),
          read: readFile,
        });
      },
    },
  },
});
