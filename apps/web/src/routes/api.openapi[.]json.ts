import { createFileRoute } from "@tanstack/react-router";
import { MMError } from "@mm/contracts";
import { describeSecurity, openApiDocument } from "#/server/api/app.ts";
import { errorBody, resolvePrincipal } from "#/server/api/auth.ts";

/**
 * `GET /api/openapi.json` — the generated OpenAPI 3.1 document.
 *
 * **Behind authentication**, like `/api/docs`. It is not a secret in the cryptographic sense,
 * but it is a complete map of every verb this installation exposes, and a self-hosted app on
 * somebody's home network has nothing to gain from handing that to an unauthenticated scanner.
 * Any credential does — a key with any scope, or the Console's cookie — because the document
 * describes the API rather than being part of it.
 *
 * The filename is `api.openapi[.]json.ts`: the bracket escape is how TanStack Start's file
 * router spells a literal dot in a path segment instead of a route separator.
 */
export const Route = createFileRoute("/api/openapi.json")({
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }) => {
        const resolution = await resolvePrincipal(request);
        if (!resolution.ok) {
          return Response.json(errorBody(resolution.error), { status: resolution.status });
        }
        try {
          return Response.json(describeSecurity(openApiDocument()), {
            headers: { "cache-control": "no-store" },
          });
        } catch (error) {
          return Response.json(errorBody(MMError.from(error)), { status: 500 });
        }
      },
    },
  },
});
