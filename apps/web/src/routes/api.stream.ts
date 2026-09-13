import { createFileRoute } from "@tanstack/react-router";
import { getSession } from "#/server/auth/session.ts";
import { db } from "#/server/db/client.ts";
import { placedTrackFile } from "#/server/services/library.ts";
import { streamResponse } from "#/server/services/stream.ts";

/**
 * `GET /api/stream?track=<libraryTrackId>` — the audio file of one library track.
 *
 * The sibling of `api.cover.ts`, and built the same way for the same reasons: it takes a **row
 * id, never a path**, so no library path is ever in a URL and none can be walked out of, and
 * it is behind the same session check as everything else (`CLAUDE.md`, "One account"). An
 * `<audio src>` on a same-origin URL carries the session cookie by itself, so the player needs
 * nothing extra.
 *
 * The one thing it does that the cover endpoint does not is **honour `Range`**, which is not
 * optional: an `<audio>` element seeks by asking for a byte interval, and a server that always
 * answers 200 gives you a track that plays from the beginning and a scrub bar that does not
 * move. `server/services/stream.ts` owns that, and has its own tests.
 *
 * A 404 is a normal answer — an unknown id, a row whose file was deleted — and the player
 * shows it as "this track is not playable" rather than as a failure of the page.
 *
 * No component: a route with only `server.handlers` is an API endpoint.
 */
export const Route = createFileRoute("/api/stream")({
  server: {
    handlers: {
      GET: async ({ request }) => await serve(request),
      HEAD: async ({ request }) => await serve(request),
    },
  },
});

async function serve(request: Request): Promise<Response> {
  const session = await getSession(request.headers);
  if (session === null) return new Response("unauthorized", { status: 401 });
  return await streamResponse(request, async (trackId) => await placedTrackFile(trackId, db()));
}
