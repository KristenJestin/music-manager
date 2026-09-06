import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

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

  test("Navidrome is honestly reported as not configured", async ({ page }) => {
    await expect(page.getByTestId("diag-navidrome")).toContainText("No Navidrome server");
    await expect(page.getByTestId("diag-readback")).toContainText("never been read back");
  });

  test("the yt-dlp self-test runs and says what it checked", async ({ page }) => {
    await page.getByTestId("ytdlp-selftest").click();
    // The toast carries the verdict; either outcome is a *result*, which is the point.
    await expect(page.getByText(/Self-test (OK|failed)/)).toBeVisible({ timeout: 60_000 });
  });

  test("the cookies test answers for the anonymous mode without a jar", async ({ page }) => {
    await page.getByTestId("cookies-test").click();
    await expect(page.getByText(/Anonymous mode|usable session/)).toBeVisible({ timeout: 60_000 });
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
    await page.getByTestId("url-input").fill("fixture://discovery");
    await page.getByTestId("url-extract").click();
    const result = page.getByTestId("url-result");
    await expect(result).toBeVisible({ timeout: 60_000 });
    await expect(result).toContainText("entries");
    await expect(result).toContainText("One More Time");
  });

  test("an unknown URL comes back decoded, not as a stack trace", async ({ page }) => {
    await page.getByTestId("url-input").fill("fixture://nothing-like-this");
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
