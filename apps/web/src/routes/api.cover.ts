import { readFile } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { db } from "#/server/db/client.ts";
import { parseImageSize, respondWithImage } from "#/server/services/image-variants.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { placedCover } from "#/server/services/library.ts";
import { loadSettings } from "#/server/services/settings.ts";

/**
 * `GET /api/cover?album=<id>[&size=64|160|320|640|original]` — the `cover.jpg` that sits
 * beside an album's audio files, at the size the caller is going to draw it.
 *
 * The library is a directory on the host; a browser cannot read it, so the one file of it that
 * every screen wants gets an endpoint. It takes an **album id**, not a path: the row says where
 * the file is (`server/services/library.ts`, `placedCover`), so no library path is ever in a
 * URL and none can be walked out of.
 *
 * `size` is a **closed set** and not an integer, so the variant cache cannot be turned into
 * thousands of files by anyone who can type a number; `services/image-variants.ts` owns the
 * set, the cache and the resizing, and a missing parameter still means the whole file.
 *
 * A **404 is a normal answer** — most albums have no placed cover — and it is the signal the
 * `<Cover>` tile is built around: the browser's own failed load moves it to the next candidate,
 * the Cover Art Archive, and then to the gradient. Nothing waits on a probe.
 *
 * Session-gated like every other route (`CLAUDE.md`, "One account"). `<img src>` carries the
 * session cookie on a same-origin request, so the tiles need nothing extra.
 *
 * No component: a route with only `server.handlers` is an API endpoint.
 */
export const Route = createFileRoute("/api/cover")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getSession(request.headers);
        if (session === null) return new Response("unauthorized", { status: 401 });

        const params = new URL(request.url).searchParams;
        const albumId = params.get("album") ?? "";
        if (albumId === "") return new Response("album id required", { status: 400 });

        const size = parseImageSize(params.get("size"));
        if (size === null) return new Response("unsupported size", { status: 400 });

        const cover = await placedCover(albumId, db());
        if (cover === null) return new Response("no cover for this album", { status: 404 });

        return await respondWithImage({
          request,
          placed: cover,
          size,
          paths: resolvePaths(await loadSettings(db())),
          read: readFile,
        });
      },
    },
  },
});
