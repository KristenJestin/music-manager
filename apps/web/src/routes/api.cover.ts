import { readFile } from "node:fs/promises";
import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { db } from "#/server/db/client.ts";
import { placedCover } from "#/server/services/library.ts";

/**
 * `GET /api/cover?album=<id>` — the `cover.jpg` that sits beside an album's audio files.
 *
 * The library is a directory on the host; a browser cannot read it, so the one file of it that
 * every screen wants gets an endpoint. It takes an **album id**, not a path: the row says where
 * the file is (`server/services/library.ts`, `placedCover`), so no library path is ever in a
 * URL and none can be walked out of.
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

        const albumId = new URL(request.url).searchParams.get("album") ?? "";
        if (albumId === "") return new Response("album id required", { status: 400 });

        const cover = await placedCover(albumId, db());
        if (cover === null) return new Response("no cover for this album", { status: 404 });

        /*
         * The tile is drawn on every list that mentions the album, so the cheap conditional
         * request is worth the four lines: a re-render costs a 304 rather than the JPEG again.
         */
        if (request.headers.get("if-none-match") === cover.etag) {
          return new Response(null, { status: 304, headers: { ETag: cover.etag } });
        }

        const bytes = await readFile(cover.file);
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": cover.contentType,
            "Content-Length": String(cover.bytes),
            ETag: cover.etag,
            // Private: it is the owner's library, not something a proxy may keep for anyone.
            "Cache-Control": "private, max-age=300, must-revalidate",
          },
        });
      },
    },
  },
});
