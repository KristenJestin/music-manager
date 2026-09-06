import { expect, test } from "@playwright/test";
import { ADMIN, signIn } from "./helpers.ts";

/**
 * `docs/phases/P06-web-coeur.md`: *toutes les routes et server functions sont protégées ;
 * `/health` reste public.*
 *
 * The unit tests prove the gate refuses and that every function carries it. These prove it
 * over real HTTP, which is the only place the claim actually matters.
 */
test.describe("authentication", () => {
  test("every page redirects to /login without a session", async ({ page }) => {
    for (const path of ["/", "/imports", "/review", "/import/new", "/library", "/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByTestId("login-submit")).toBeVisible();
    }
  });

  test("/health stays public, so a container healthcheck can reach it", async ({ request }) => {
    const response = await request.get("/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
  });

  test("a server function refuses a caller with no session", async ({ page, request }) => {
    /*
     * The endpoint is captured from a signed-in page rather than constructed: its path encodes
     * the module and the export, and hard-coding that would test our guess at the framework's
     * URL scheme instead of the app.
     */
    const calls: string[] = [];
    page.on("request", (event) => {
      if (event.url().includes("/_serverFn/")) calls.push(event.url());
    });

    await signIn(page);
    // A *client-side* navigation, not `goto`: during a full page load the loaders run inside
    // the server render and never touch the network, so nothing would be captured.
    await page.getByRole("link", { name: "Jobs" }).click();
    await page.waitForURL(/\/imports/, { timeout: 60_000 });
    await expect(page.getByTestId("jobs-table")).toBeVisible();
    expect(
      calls.length,
      "the page should have called at least one server function",
    ).toBeGreaterThan(0);

    /*
     * A request context of its own, so it carries no cookies.
     *
     * Two gates can refuse it — the origin check and the session check — and which one fires
     * first depends on headers this context does not fully control. Both are correct answers,
     * so the assertion is the property that actually matters and that neither gate may break:
     * **no data comes back**. The redirect target is checked only when there is one.
     */
    const endpoint = calls[0] ?? "";
    const anonymous = await request.get(endpoint, {
      headers: { origin: new URL(endpoint).origin, referer: `${new URL(endpoint).origin}/imports` },
      maxRedirects: 0,
    });

    /*
     * The status is deliberately not pinned to one value.
     *
     * A real client always calls a server function as an RPC, and the session gate answers it
     * with `307 → /login` — that is what the app does and what a browser sees. A hand-rolled
     * request that is *shaped* differently can be refused earlier and differently: `403` from
     * the origin check without an `Origin`, or a `500` when the framework cannot express a
     * thrown redirect for a request shape it did not produce. All three are refusals. Asserting
     * one of them would be asserting the framework's internals; asserting "no data came back"
     * is the promise the phase specification actually makes.
     */
    expect(anonymous.status(), "an unauthenticated server function must not answer 200").not.toBe(
      200,
    );

    const body = await anonymous.text();
    expect(body, "no payload may leak to a caller without a session").not.toContain("jobs");
    expect(body).not.toContain("imp_");

    const location = anonymous.headers()["location"];
    if (location !== undefined) expect(location).toContain("/login");
  });

  test("a wrong password is refused, and says so on the page", async ({ page }) => {
    await page.goto("/login");
    await page.getByTestId("login-email").fill(ADMIN.email);
    await page.getByTestId("login-password").fill("not-the-password");
    await page.getByTestId("login-submit").click();
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("signing in returns you to where you were sent away from", async ({ page }) => {
    await page.goto("/imports");
    await expect(page).toHaveURL(/redirect=/);
    await page.getByTestId("login-email").fill(ADMIN.email);
    await page.getByTestId("login-password").fill(ADMIN.password);
    await page.getByTestId("login-submit").click();
    await page.waitForURL(/\/imports/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Jobs" })).toBeVisible();
  });
});
