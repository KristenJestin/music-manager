import { createFileRoute } from "@tanstack/react-router";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MMError } from "@mm/contracts";
import { buildMcpServer } from "#/server/mcp/server.ts";
import { errorBody, resolvePrincipal } from "#/server/api/auth.ts";

/**
 * `/mcp` — the Model Context Protocol endpoint, over Streamable HTTP.
 *
 * `WebStandardStreamableHTTPServerTransport` rather than `StreamableHTTPServerTransport`: the
 * latter wraps Node's `req`/`res`, which this app does not have. TanStack Start hands us a
 * `Request` and wants a `Response`, and the SDK ships a Web-standard transport for exactly
 * that — `transport.handleRequest(request)` is the whole integration.
 *
 * **Stateless**, i.e. `sessionIdGenerator` is left undefined. One server and one transport per
 * request, closed when it ends. Two reasons, and the second is the real one:
 *
 *  - a session map in a module-level variable is lost on every hot reload and on every restart,
 *    so a "session" would be a promise this process cannot keep;
 *  - the tool list depends on the *caller's scopes*, so a server instance is already per-key.
 *    Caching one would mean either a map keyed by key id — a session by another name — or
 *    handing a `library:read` client the tools of whoever connected first.
 *
 * Authentication is an API key as a bearer token, checked before the transport is built, so an
 * unauthenticated request never reaches the protocol layer. See `server/mcp/server.ts` for why
 * this is a plain key rather than Better Auth's OAuth-based MCP plugin.
 */
async function handle({ request }: { request: Request }): Promise<Response> {
  const resolution = await resolvePrincipal(request);
  if (!resolution.ok) {
    /*
     * `WWW-Authenticate` is not decoration.
     *
     * RFC 6750 is what an MCP client reads to discover *how* to authenticate; without the
     * header a client shows "401" and stops, and with it the better ones prompt for a token.
     */
    return Response.json(errorBody(resolution.error), {
      status: resolution.status,
      headers: { "www-authenticate": 'Bearer realm="music-manager"' },
    });
  }

  const server = buildMcpServer(resolution.principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless. See the note above.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    await transport.close().catch(() => undefined);
    return Response.json(errorBody(MMError.from(error)), { status: 500 });
  }
}

export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      // `GET` opens the server→client notification stream, `POST` carries JSON-RPC, and
      // `DELETE` ends a session. All three belong to the protocol; the transport sorts them.
      GET: handle,
      POST: handle,
      DELETE: handle,
    },
  },
});
