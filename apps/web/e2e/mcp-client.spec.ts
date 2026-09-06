import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Page } from "@playwright/test";
import { expect, test, signIn } from "./helpers.ts";

/**
 * `/mcp`, driven by the **official SDK client** rather than by hand-written JSON-RPC.
 *
 * `api.spec.ts` already posts envelopes at the endpoint and reads the replies, which proves the
 * wire format. It cannot prove the thing an operator actually cares about: that a real MCP
 * client connects. A client does the protocol-version handshake, reads the server's declared
 * capabilities, keeps the transport's session state and decides for itself whether an answer
 * is an SSE frame or a JSON body — all of which a fixture that formats its own POST body
 * skips. This spec is the one that would fail if a transport change broke every agent in the
 * world while leaving `curl` perfectly happy.
 *
 * Added by P08-P11-verify-1; `api.spec.ts` is left as it is.
 */

/** A key with these scopes. Minted over the API with the Console's own session cookie. */
async function mintKey(page: Page, name: string, scopes: readonly string[]): Promise<string> {
  const response = await page.request.post("/api/v1/keys", { data: { name, scopes } });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { key?: string };
  expect(body.key ?? "", "the plaintext is returned once, at creation").toMatch(/^mm_/);
  return body.key as string;
}

/** The text of one resource content block. A `blob` block has no text, and that is a failure. */
function textOf(content: Record<string, unknown> | undefined): string {
  const text = content?.["text"];
  return typeof text === "string" ? text : "";
}

/** A connected SDK client. Closed by the caller. */
async function connect(baseURL: string, key: string): Promise<Client> {
  const client = new Client({ name: "mm-e2e-mcp-client", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseURL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    }),
  );
  return client;
}

test.describe("the MCP server, through the official SDK client", () => {
  test("handshakes, lists by scope, calls tools and reads its resources", async ({
    page,
    baseURL,
  }) => {
    await signIn(page);
    const full = await mintKey(page, "e2e-mcp-sdk-full", ["*"]);
    const reader = await mintKey(page, "e2e-mcp-sdk-read", ["library:read"]);
    const url = baseURL as string;

    /* ---- the handshake, done by the client ------------------------------ */

    const client = await connect(url, full);
    expect(client.getServerVersion()).toMatchObject({ name: "music-manager" });
    // A client plans from the capabilities; a server that forgets to declare one is invisible.
    const capabilities = client.getServerCapabilities() ?? {};
    expect(capabilities).toHaveProperty("tools");
    expect(capabilities).toHaveProperty("resources");

    /* ---- every tool, and a description an agent can plan with ----------- */

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    for (const expected of [
      "list_imports",
      "get_import",
      "create_import",
      "get_candidates",
      "confirm_mapping",
      "list_inbox",
      "resolve_inbox",
      "search_library",
      "get_album",
      "retag",
      "verify",
      "get_settings",
      "update_settings",
      "ytdlp_update",
    ]) {
      expect(names, `${expected} should be advertised`).toContain(expected);
    }

    /* ---- three calls, each reaching the service layer -------------------- */

    for (const [tool, args, key] of [
      ["search_library", { query: "discovery", limit: 3 }, "albums"],
      ["list_imports", { limit: 5 }, null],
      ["get_settings", {}, "pathTemplate"],
    ] as const) {
      const called = await client.callTool({ name: tool, arguments: args });
      expect(called.isError ?? false, `${tool} should not answer with an error`).toBe(false);
      const content = called.content as { type: string; text: string }[];
      expect(content[0]?.type).toBe("text");
      const answer: unknown = JSON.parse(content[0]?.text ?? "null");
      if (key === null) expect(Array.isArray(answer), "list_imports answers a list").toBe(true);
      else expect(answer).toHaveProperty(key);
    }

    /* ---- the resources -------------------------------------------------- */

    const resources = await client.listResources();
    const uris = resources.resources.map((resource) => resource.uri);
    expect(uris).toContain("mm://tagmap");

    const tagmap = await client.readResource({ uri: "mm://tagmap" });
    expect(textOf(tagmap.contents[0]).length).toBeGreaterThan(100);

    /*
     * `docs/` lives one level above the repository and is legitimately absent from a
     * production image, so its presence is not asserted — but when it is there, a document
     * must really be readable rather than merely listed.
     */
    const doc = uris.find((uri) => uri.startsWith("mm://docs/"));
    if (doc !== undefined) {
      const read = await client.readResource({ uri: doc });
      expect(textOf(read.contents[0]).length).toBeGreaterThan(0);
    }

    await client.close();

    /* ---- a narrower key sees a narrower server -------------------------- */

    const narrow = await connect(url, reader);
    const narrowNames = (await narrow.listTools()).tools.map((tool) => tool.name);
    expect(narrowNames).toContain("search_library");
    expect(narrowNames).not.toContain("create_import");
    expect(narrowNames).not.toContain("update_settings");

    // Hidden is refused, not merely undocumented: calling it anyway must not work.
    const refused = await narrow.callTool({
      name: "update_settings",
      arguments: { key: "pathTemplate", value: "PWNED/{title}.{ext}" },
    });
    expect(refused.isError).toBe(true);
    await narrow.close();

    // …and the setting it tried to change is untouched.
    const settings = await page.request.get("/api/v1/settings");
    expect((await settings.json()) as { pathTemplate?: string }).toMatchObject({
      pathTemplate: expect.not.stringContaining("PWNED") as unknown as string,
    });
  });

  test("refuses an anonymous client, with the header that tells it what to do", async ({
    baseURL,
  }) => {
    const client = new Client({ name: "mm-e2e-mcp-anon", version: "1.0.0" });
    await expect(
      client.connect(new StreamableHTTPClientTransport(new URL(`${baseURL as string}/mcp`))),
    ).rejects.toThrow(/401|unauthor/i);
  });
});
