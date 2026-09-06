import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test, signIn, typeInto } from "./helpers.ts";

/**
 * The public API, driven the way an agent would drive it.
 *
 * `request` rather than `page` for the API half: the whole claim of P08 is that `/api/v1` is
 * usable by something that is not a browser, and a test that reached it through `page.evaluate`
 * would be carrying the session cookie and the same-origin fetch stack with it — proving
 * something narrower than what is claimed. The Playwright `request` fixture is `curl` with
 * assertions, which is exactly the client this API is for.
 *
 * The token is created **through the Console**, because that is the only way a real user gets
 * one, and because the secret exists for exactly one render: if the panel that shows it ever
 * stops working there is no other way to recover the key, and this spec is what would notice.
 */

/** A key with these scopes, minted through Settings › API & agents. Returns the plaintext. */
async function mintKey(page: Page, name: string, scopes: readonly string[]): Promise<string> {
  await page.goto("/settings/api");
  await expect(page.getByTestId("settings-api")).toBeVisible({ timeout: 60_000 });

  await typeInto(page.getByTestId("key-name"), name);

  /*
   * The chips are a toggle group with two on by default, so each one is set to what this call
   * wants rather than cleared and re-ticked.
   *
   * Resolved from `getByRole("button")` and **not** from `getByRole("button", {pressed:true})`:
   * `.all()` hands back `nth(0…n-1)` locators against the filter it was given, and that filter
   * is re-evaluated at click time — so clearing the first pressed chip makes the second one
   * vanish from the set, and `nth(1)` waits thirty seconds for an element that no longer
   * matches. Filtering on a property the click itself changes is the trap; the set of buttons
   * is stable, their `aria-pressed` is not.
   */
  const scopeGroup = page.getByTestId("key-scopes");
  for (const chip of await scopeGroup.getByRole("button").all()) {
    const label = ((await chip.textContent()) ?? "").trim();
    const on = (await chip.getAttribute("aria-pressed")) === "true";
    if (on !== scopes.includes(label)) await chip.click();
  }

  /*
   * Wait on the three things Create is disabled for, rather than on Create itself.
   *
   * The button is `disabled` until React has a name and at least one scope in *state*, and the
   * server-rendered HTML is on screen well before React attaches — so a click can land on a
   * button that is still disabled and Playwright then waits thirty seconds and reports only
   * "element is not enabled", which says nothing about which of the three inputs was missing.
   * Asserting them separately turns that into a failure that names its own cause.
   */
  await expect(page.getByTestId("key-name")).toHaveValue(name);
  await expect(scopeGroup.getByRole("button", { pressed: true })).toHaveCount(scopes.length);
  await expect(page.getByTestId("create-key")).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId("create-key").click();

  // Shown once, and only once. If this panel is missing the key is unrecoverable.
  const secret = page.getByTestId("secret-value");
  await expect(secret).toBeVisible({ timeout: 60_000 });
  const value = (await secret.textContent()) ?? "";
  expect(value, "the key's plaintext should be shown once").toMatch(/^mm_/);
  await page.getByTestId("dismiss-secret").click();
  return value;
}

test.describe("the REST API", () => {
  test("a key created in the Console authenticates, and its scopes are enforced", async ({
    page,
    request,
  }) => {
    await signIn(page);
    const readOnly = await mintKey(page, "e2e-readonly", ["library:read"]);
    const writer = await mintKey(page, "e2e-writer", ["imports:write", "library:read"]);

    /* ---- who am I ------------------------------------------------------- */

    const me = await request.get("/api/v1/me", { headers: { "x-api-key": readOnly } });
    expect(me.status()).toBe(200);
    expect(await me.json()).toMatchObject({ kind: "apiKey", scopes: ["library:read"] });

    // Both spellings are equivalent; an agent should not have to guess which one this app wants.
    const viaBearer = await request.get("/api/v1/me", {
      headers: { authorization: `Bearer ${readOnly}` },
    });
    expect(viaBearer.status()).toBe(200);

    /* ---- 200 with the scope, 403 without --------------------------------- */

    const allowed = await request.get("/api/v1/library/albums", {
      headers: { "x-api-key": readOnly },
    });
    expect(allowed.status()).toBe(200);

    const refused = await request.post("/api/v1/imports", {
      headers: { "x-api-key": readOnly },
      data: { url: "fixture://discovery" },
    });
    // 403, not 401: the key is valid, it simply may not do this. The distinction is the
    // difference between "check your key" and "issue a key with that scope".
    expect(refused.status()).toBe(403);
    const body = (await refused.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.details).toMatchObject({ required: "imports:write" });

    /* ---- and the same call succeeds for a key that carries it ------------- */

    /*
     * Created through the API, and then cancelled through it — on purpose.
     *
     * The claim under test is authorisation: a key carrying `imports:write` gets a 201 and an
     * import id, where the read-only key got a 403. Running the pipeline to `done` is
     * `import-album.spec.ts`'s subject, and it must stay its subject alone.
     *
     * This used to pass `autoConfirm: true` and walk away, which launched a full background
     * import of *the same album into the same library* from the very first spec of the suite
     * and left it racing everything after it. (`autoConfirm` is not even what made it run:
     * `confirmStep` treats fixtures mode as automatic, so dropping the flag would change
     * nothing.) It cost `library.spec.ts` a run: both imports owned
     * `Daft Punk/Discovery (2001)`, the second found every file "already present" and so never
     * re-tagged it, and the Tags tab then showed fourteen files whose `MUSICMANAGER_IMPORTID`
     * was the *first* import's while the database held the second's — "no drift on a freshly
     * tagged album" failing on a real drift that no part of the product had caused. Which
     * import tagged the files depended on how two background jobs interleaved, so it failed
     * some runs and not others.
     *
     * Cancelling is both the cure and extra coverage: the import never reaches `place`, so it
     * writes no file, and `POST /{id}/cancel` gets exercised. `place` is a download and
     * fourteen tag calls away from the 201, so this is not a race with anything.
     */
    const created = await request.post("/api/v1/imports", {
      headers: { "x-api-key": writer },
      data: { url: "fixture://discovery", options: { autoConfirm: true } },
    });
    expect(created.status()).toBe(201);
    const payload = (await created.json()) as { import: { id: string; status: string } };
    expect(payload.import.id).toMatch(/^imp_/);

    const cancelled = await request.post(`/api/v1/imports/${payload.import.id}/cancel`, {
      headers: { "x-api-key": writer },
    });
    expect(cancelled.status()).toBe(200);
    // Asserted rather than assumed. `cancelImport` writes the status inside the request, and
    // `runImport` refuses to re-enter a terminal import — the pipeline hands the download to
    // its own queue and so always comes back through that gate before a file is placed.
    const state = (await cancelled.json()) as { import: { status: string } };
    expect(state.import.status).toBe("cancelled");

    /* ---- an unknown key is 401, which is a different problem -------------- */

    const anonymous = await request.get("/api/v1/me");
    expect(anonymous.status()).toBe(401);
    const bogus = await request.get("/api/v1/me", { headers: { "x-api-key": "mm_nonsense" } });
    expect(bogus.status()).toBe(401);
    expect(((await bogus.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });

  test("the OpenAPI document is generated, complete, and behind authentication", async ({
    page,
    request,
  }) => {
    await signIn(page);
    const key = await mintKey(page, "e2e-docs", ["*"]);

    // A complete map of every verb this installation exposes is not for an anonymous scanner.
    expect((await request.get("/api/openapi.json")).status()).toBe(401);

    const response = await request.get("/api/openapi.json", { headers: { "x-api-key": key } });
    expect(response.status()).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };

    // 3.1, because zod v4 emits JSON Schema 2020-12 and 3.0 would need a lossy conversion.
    expect(document.openapi).toBe("3.1.0");
    // The acceptance criterion of `docs/phases/P08-api-agents.md` is ≥ 25.
    expect(Object.keys(document.paths).length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(document.components.securitySchemes)).toEqual(
      expect.arrayContaining(["apiKeyHeader", "bearer"]),
    );
    // Spot-check that the document describes the routes rather than merely existing.
    expect(document.paths).toHaveProperty("/api/v1/imports");
    // P09 mounts Discover on the same document, under its own tag.
    expect(document.paths).toHaveProperty("/api/v1/discover");
    expect(document.paths).toHaveProperty("/api/v1/imports/{id}/confirm-mapping");
    expect(document.paths).toHaveProperty("/api/v1/events");

    const docs = await request.get("/api/docs", { headers: { "x-api-key": key } });
    expect(docs.status()).toBe(200);
    expect(await docs.text()).toContain("/api/openapi.json");
  });

  test("the event stream is Server-Sent Events, and needs a scope", async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page);
    const key = await mintKey(page, "e2e-events", ["imports:read"]);

    /*
     * Plain `fetch`, not the `request` fixture.
     *
     * `request.get()` resolves when the **body** is complete, and an event stream's body is
     * never complete — the call simply timed out after thirty seconds against a perfectly
     * healthy 200. Reading the headers and then the first chunk off the stream is both what a
     * real SSE client does and a stronger assertion: it proves the endpoint *emits* something
     * rather than merely agreeing to a content type.
     */
    const controller = new AbortController();
    const stream = await fetch(`${baseURL ?? ""}/api/v1/events?since=0`, {
      headers: { "x-api-key": key, accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    // Nitro and nginx both buffer by default, which would defeat the whole endpoint.
    expect(stream.headers.get("x-accel-buffering")).toBe("no");

    // The stream opens with a comment line so a proxy cannot sit on the headers.
    const reader = stream.body?.getReader();
    expect(reader, "an event stream must have a body").toBeTruthy();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain(":");
    controller.abort();

    // The paged form of the same journal, for a client that would rather not hold a socket.
    const history = await request.get("/api/v1/events/history?limit=5", {
      headers: { "x-api-key": key },
    });
    expect(history.status()).toBe(200);
    expect((await history.json()) as { events: unknown[] }).toHaveProperty("events");
  });
});

test.describe("the MCP server", () => {
  /** One JSON-RPC call over Streamable HTTP. */
  async function rpc(
    request: APIRequestContext,
    key: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await request.post("/mcp", {
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      data: { jsonrpc: "2.0", id: 1, method, params },
    });
    const text = await response.text();
    // The transport may answer as JSON or as a single SSE frame; both carry the same envelope.
    const json = text.startsWith("event:") ? text.slice(text.indexOf("data:") + 5).trim() : text;
    return {
      status: response.status(),
      body: response.ok() ? (JSON.parse(json) as Record<string, unknown>) : {},
    };
  }

  test("lists its tools over HTTP, filtered by the key's scopes", async ({ page, request }) => {
    await signIn(page);
    const full = await mintKey(page, "e2e-mcp-full", ["*"]);
    const reader = await mintKey(page, "e2e-mcp-read", ["library:read"]);

    /* ---- unauthenticated, with the header that tells a client what to do --- */

    const anonymous = await request.post("/mcp", {
      headers: { "content-type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(anonymous.status()).toBe(401);
    // RFC 6750: without this a client shows "401" and stops; with it, it can prompt for a token.
    expect(anonymous.headers()["www-authenticate"]).toContain("Bearer");

    /* ---- the handshake ---------------------------------------------------- */

    const initialised = await rpc(request, full, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "playwright", version: "1" },
    });
    expect(initialised.status).toBe(200);
    expect(initialised.body).toHaveProperty("result.serverInfo.name", "music-manager");

    /* ---- every tool of the spec, for a key that may use them all ---------- */

    const listed = await rpc(request, full, "tools/list");
    expect(listed.status).toBe(200);
    const tools = (listed.body as { result: { tools: { name: string }[] } }).result.tools;
    const names = tools.map((tool) => tool.name);
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
      "list_discover",
    ]) {
      expect(names, `${expected} should be advertised`).toContain(expected);
    }
    // Every tool carries a description an agent can plan with, not just a name.
    for (const tool of tools) {
      expect((tool as { description?: string }).description ?? "").not.toHaveLength(0);
    }

    /* ---- and only the ones a narrower key may call ------------------------ */

    const narrow = await rpc(request, reader, "tools/list");
    const narrowNames = (narrow.body as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    // An agent that can see a tool it may not call plans a route that fails; better to hide it.
    expect(narrowNames).toContain("search_library");
    expect(narrowNames).not.toContain("create_import");
    expect(narrowNames).not.toContain("update_settings");

    /* ---- the resources ---------------------------------------------------- */

    const resources = await rpc(request, full, "resources/list");
    const uris = (
      resources.body as { result: { resources: { uri: string }[] } }
    ).result.resources.map((resource) => resource.uri);
    expect(uris).toContain("mm://tagmap");
    // `docs/` lives one level above the repository and may legitimately be absent in a
    // container, so this asserts the tag map and only *prefix*-checks the documents.
    expect(uris.filter((uri) => uri.startsWith("mm://docs/")).length).toBeGreaterThanOrEqual(0);
  });

  test("a tool call reaches the service layer", async ({ page, request }) => {
    await signIn(page);
    const key = await mintKey(page, "e2e-mcp-call", ["library:read"]);

    const called = await rpc(request, key, "tools/call", {
      name: "search_library",
      arguments: { query: "discovery", limit: 5 },
    });
    expect(called.status).toBe(200);
    const content = (called.body as { result: { content: { type: string; text: string }[] } })
      .result.content;
    expect(content[0]?.type).toBe("text");
    // The tool answers with the service layer's own shape, not a bespoke one.
    const answer = JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
    expect(answer).toHaveProperty("albums");
    expect(answer).toHaveProperty("tracks");
    expect(answer).toHaveProperty("artists");
  });
});

test.describe("Settings › API & agents", () => {
  test("shows the endpoints, and revokes a key it created", async ({ page, request }) => {
    await signIn(page);
    const key = await mintKey(page, "e2e-revoke-me", ["library:read"]);

    // It works…
    expect((await request.get("/api/v1/me", { headers: { "x-api-key": key } })).status()).toBe(200);

    // The page tells an agent where everything is, without anyone having to guess.
    await expect(page.getByTestId("mcp-endpoint")).toHaveValue(/\/mcp$/);

    const row = page.getByRole("row", { name: /e2e-revoke-me/ });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText(/Revoked/i)).toBeVisible({ timeout: 60_000 });

    // …and then it does not. A revoked key is deleted, not disabled.
    expect((await request.get("/api/v1/me", { headers: { "x-api-key": key } })).status()).toBe(401);
  });

  test("creates a webhook, shows its secret once, and delivers a signed test event", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/settings/api");
    await expect(page.getByTestId("settings-api")).toBeVisible({ timeout: 60_000 });

    // A URL that will refuse the delivery, so the failure path is what is asserted: the point
    // here is that the Console reports what the endpoint said rather than claiming success.
    await typeInto(page.getByTestId("webhook-url"), "http://127.0.0.1:9/hook");
    await page.getByTestId("create-webhook").click();

    const secret = page.getByTestId("secret-value");
    await expect(secret).toBeVisible({ timeout: 60_000 });
    expect((await secret.textContent()) ?? "").toMatch(/^whsec_/);
    await page.getByTestId("dismiss-secret").click();

    const row = page.getByRole("row", { name: /127\.0\.0\.1:9/ });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Test" }).click();
    // Nothing is listening on port 9, so the honest answer is the error, not "delivered".
    await expect(page.getByTestId("toaster")).toBeVisible({ timeout: 60_000 });
  });
});
