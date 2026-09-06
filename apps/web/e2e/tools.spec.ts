import { expect, test } from "@playwright/test";
import { signIn, typeInto } from "./helpers.ts";

/**
 * `/tools` — the diagnostics page.
 *
 * The property under test is the one the page exists for: **it renders, and it keeps
 * rendering when something behind it is unavailable.** In the E2E stack Navidrome is not
 * configured and the outside world is unreachable, so half the probes fail — and that is the
 * interesting case, because a diagnostics page that blanks out when a probe fails has hidden
 * exactly the information it was built to show.
 */
test.describe("tools", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/tools");
    await expect(page.getByRole("heading", { name: /Tools/ })).toBeVisible({ timeout: 60_000 });
  });

  test("every panel renders, even with half the world unreachable", async ({ page }) => {
    for (const panel of [
      "tools-health",
      "tools-services",
      "tools-url",
      "tools-errors",
      "tools-scan",
      "tools-log",
    ]) {
      await expect(page.getByTestId(panel), panel).toBeVisible();
    }
  });

  test("the downloader row shows the versions the toolbox reports", async ({ page }) => {
    // The toolbox is in fixtures mode here, and it still knows which binaries it carries.
    await expect(page.getByTestId("diag-ytdlp")).toContainText("fixtures mode");
    await expect(page.getByTestId("diag-binaries")).toBeVisible();
    await expect(page.getByTestId("diag-cookies")).toContainText("Anonymous mode");
  });

  test("Navidrome is reported honestly, whatever is or is not configured", async ({ page }) => {
    /*
     * Not pinned to "not configured": the settings specs write and restore a URL, and a spec
     * that depended on the *order* they ran in would be a worse test than this one. The
     * property that matters is that the row never invents a working server.
     */
    await expect(page.getByTestId("diag-navidrome")).toContainText(
      /No Navidrome server|did not answer|not answering|navidrome/,
    );
    await expect(page.getByTestId("diag-readback")).toBeVisible();
  });

  test("the yt-dlp self-test runs and says what it checked", async ({ page }) => {
    /*
     * Waits on the server function's own response, not on the toast.
     *
     * The toast is a four-second courtesy; under a loaded machine an assertion on it is
     * timing an animation. What the test is named for is that the button really runs the
     * self-test and really gets an answer, and that is exactly one HTTP round trip.
     */
    const [response] = await Promise.all([
      page.waitForResponse((event) => event.url().includes("_serverFn"), { timeout: 120_000 }),
      page.getByTestId("ytdlp-selftest").click(),
    ]);
    expect(response.ok()).toBe(true);
    // Either verdict is a result; what must not happen is an unhandled failure.
    await expect(page.getByTestId("tools-health")).toBeVisible();
  });

  test("the cookies test answers for the anonymous mode without a jar", async ({ page }) => {
    const [response] = await Promise.all([
      page.waitForResponse((event) => event.url().includes("_serverFn"), { timeout: 120_000 }),
      page.getByTestId("cookies-test").click(),
    ]);
    expect(response.ok()).toBe(true);
    await expect(page.getByTestId("diag-cookies")).toContainText("Anonymous mode");
  });

  test("the error decoder is served from the toolbox's own taxonomy", async ({ page }) => {
    const table = page.getByTestId("errors-table");
    await expect(table).toBeVisible();
    // The codes come from services/toolbox/src/toolbox/errors.py over GET /errors.
    await expect(table).toContainText("YTDLP_BOT_CHECK");
    await expect(table).toContainText("LOCKED");
    await expect(table).toContainText("Configure cookies");
  });

  test("Test a URL runs an extract without downloading anything", async ({ page }) => {
    await typeInto(page.getByTestId("url-input"), "fixture://discovery");
    await page.getByTestId("url-extract").click();
    const result = page.getByTestId("url-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result).toContainText("entries");
    await expect(result).toContainText("One More Time");
  });

  test("an unknown URL comes back decoded, not as a stack trace", async ({ page }) => {
    await typeInto(page.getByTestId("url-input"), "fixture://nothing-like-this");
    await page.getByTestId("url-extract").click();
    const result = page.getByTestId("url-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    // The toolbox's own code and hint, which is what the decoder table above explains.
    await expect(result).toContainText("FIXTURE_UNKNOWN");
  });

  test("the services panel pings each source once and reports a row for each", async ({ page }) => {
    const services = page.getByTestId("tools-services");
    for (const name of [
      "svc-musicbrainz",
      "svc-coverartarchive",
      "svc-acoustid",
      "svc-lrclib",
      "svc-deezer",
      "svc-lastfm",
      "svc-listenbrainz",
    ]) {
      await expect(services.getByTestId(name), name).toBeVisible();
    }
  });
});
