/**
 * `/mcp` over Streamable HTTP: one `Request` in, one `Response` out.
 *
 * It lives here rather than in `routes/mcp.ts` because a route file is not testable without a
 * router: `createFileRoute` wants the generated tree, and the thing worth testing is this
 * function, which an MCP client can be pointed straight at through the SDK transport's `fetch`
 * option. The route is now the three lines that say which HTTP verbs reach it.
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
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MMError, type MMErrorBody } from "@mm/contracts";
import { buildMcpServer } from "#/server/mcp/server.ts";
import { errorBody, resolvePrincipal } from "#/server/api/auth.ts";

/**
 * JSON-RPC codes for the ways this endpoint says no before the protocol layer exists.
 *
 * The `-32000…-32099` block is reserved for implementation-defined server errors, which is
 * exactly what these are: JSON-RPC has no vocabulary for "unauthenticated". `-32001` for
 * authentication is the convention MCP servers have converged on; the other two follow it. The
 * HTTP status is kept as well — a proxy and a client read different things — and the real code
 * (`UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`) travels in `error.data`, where it is not
 * competing with the transport's own numbering.
 */
export const JSONRPC_CODES: Record<number, number> = { 401: -32001, 403: -32003, 429: -32029 };

/**
 * The `id` of the request being refused, or `null`.
 *
 * A JSON-RPC response is useless to a client that cannot attach it to a call, and the `id` only
 * exists in the body. Reading it here is safe because these paths never hand the request on to
 * the transport. A batch (an array) or an unparseable body answers `id: null`, which the
 * specification allows and every client accepts.
 */
export async function requestId(request: Request): Promise<string | number | null> {
  if (request.method !== "POST") return null;
  try {
    const body: unknown = await request.clone().json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

/** A JSON-RPC error object carrying the app's own error body whole, in `data`. */
export function jsonRpcError(
  code: number,
  body: MMErrorBody,
  id: string | number | null,
): { jsonrpc: "2.0"; id: string | number | null; error: object } {
  return { jsonrpc: "2.0", id, error: { code, message: body.message, data: body } };
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const resolution = await resolvePrincipal(request);
  if (!resolution.ok) {
    /*
     * A refusal on `/mcp` has to be **JSON-RPC**, not the REST envelope.
     *
     * The guard answers before the protocol layer exists, so it used to reply with
     * `{"error":{"code":"RATE_LIMITED",…}}` — the shape every other endpoint uses and the one
     * shape an MCP client cannot read. Without `jsonrpc` and the request's `id`, a strict
     * client reports a protocol violation instead of "you are limited, retry in 9 s", which is
     * how the third test report came to believe the server had broken. The REST body is not
     * thrown away: it travels whole in `error.data`, so nothing that used to be readable
     * stopped being readable.
     *
     * `WWW-Authenticate` is not decoration either: RFC 6750 is what a client reads to discover
     * *how* to authenticate, and without it a client shows "401" and stops.
     */
    const body = errorBody(resolution.error).error;
    const headers: Record<string, string> = {
      "www-authenticate": 'Bearer realm="music-manager"',
    };
    // A countdown a client can act on without parsing prose, for the 429.
    const retryAfter = /(\d+)s/.exec(body.hint ?? "")?.[1];
    if (resolution.status === 429 && retryAfter !== undefined) headers["retry-after"] = retryAfter;

    return Response.json(
      jsonRpcError(JSONRPC_CODES[resolution.status] ?? -32000, body, await requestId(request)),
      { status: resolution.status, headers },
    );
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
    // Same reasoning as the refusal above: on `/mcp`, an error is a JSON-RPC error. -32603 is
    // the specification's own "internal error".
    const body = errorBody(MMError.from(error)).error;
    return Response.json(jsonRpcError(-32603, body, await requestId(request)), { status: 500 });
  }
}
