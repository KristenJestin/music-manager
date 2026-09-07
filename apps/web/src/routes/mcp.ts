import { createFileRoute } from "@tanstack/react-router";
import { handleMcpRequest } from "#/server/mcp/http.ts";

/**
 * `/mcp` — the Model Context Protocol endpoint, over Streamable HTTP.
 *
 * Three verbs, one handler, and the handler is in `server/mcp/http.ts` so that it can be driven
 * by a real MCP client in a test without a router. Everything worth knowing about the endpoint
 * — why it is stateless, why authentication happens before the transport, and why a refusal is
 * shaped as JSON-RPC rather than as the REST error envelope — is documented there.
 */
export const Route = createFileRoute("/mcp")({
  server: {
    handlers: {
      // `GET` opens the server→client notification stream, `POST` carries JSON-RPC, and
      // `DELETE` ends a session. All three belong to the protocol; the transport sorts them.
      GET: ({ request }) => handleMcpRequest(request),
      POST: ({ request }) => handleMcpRequest(request),
      DELETE: ({ request }) => handleMcpRequest(request),
    },
  },
});
