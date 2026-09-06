import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.ts";

/**
 * The Navidrome read-back, from the Console.
 *
 * There is no Navidrome in the E2E stack — it is `bun run e2e-verify` that runs the real
 * server, and the field-by-field table is asserted there against real answers. What belongs
 * here is everything the Console must get right **when the server is absent**, because that
 * is the state a new installation is in and the one where a wrong message costs the most:
 *
 *  - Settings → Integrations says "not configured", not "no mismatches";
 *  - the album's Navidrome tab offers a rescan instead of showing an empty table;
 *  - the password field never renders the stored value.
 */
test.describe("settings › integrations", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/integrations");
    await expect(page.getByTestId("settings-integrations")).toBeVisible({ timeout: 60_000 });
  });

  test("the tab strip only offers tabs that exist", async ({ page }) => {
    const nav = page.getByTestId("settings-nav");
    await expect(nav.getByTestId("settings-tab-downloader")).toBeVisible();
    await expect(nav.getByTestId("settings-tab-integrations")).toBeVisible();
    for (const link of await nav.getByRole("link").all()) {
      const href = await link.getAttribute("href");
      expect(href, "every tab points somewhere").toBeTruthy();
    }
  });

  test("an unconfigured Navidrome is reported as such", async ({ page }) => {
    await expect(page.getByText("not configured")).toBeVisible();
    await expect(page.getByTestId("navidrome-url")).toHaveValue("");
  });

  test("the password box is empty and its placeholder is a mask, never a value", async ({
    page,
  }) => {
    const field = page.getByTestId("navidrome-password");
    await expect(field).toHaveValue("");
    await expect(field).toHaveAttribute("type", "password");
    const placeholder = (await field.getAttribute("placeholder")) ?? "";
    expect(placeholder === "not set" || placeholder.startsWith("set (")).toBe(true);
  });

  test("Test reports a failure against a server that is not there", async ({ page }) => {
    await page.getByTestId("navidrome-url").fill("http://127.0.0.1:4599");
    await page.getByTestId("navidrome-user").fill("admin");
    await page.getByTestId("navidrome-test").click();
    // A failure is a *result*: it lands in the toast and in the status row, not in an error page.
    await expect(page.getByTestId("settings-integrations")).toBeVisible();
    await expect(page.getByText(/not answering|did not answer|No answer/)).toBeVisible({
      timeout: 60_000,
    });
  });

  test("the notifications block says where its delivery lives", async ({ page }) => {
    await expect(page.getByText("delivery coming in P08")).toBeVisible();
    await expect(page.getByTestId("chips-notify-channel")).toBeVisible();
  });

  test("a saved value is read back by the settings store", async ({ page }) => {
    await page.getByTestId("navidrome-url").fill("http://navidrome.test:4533");
    await page.getByTestId("integrations-save").click();
    await expect(page.getByText(/setting\(s\) saved/)).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId("navidrome-url")).toHaveValue("http://navidrome.test:4533");

    // Put it back, so the specs stay order-independent.
    await page.getByTestId("navidrome-url").fill("");
    await page.getByTestId("integrations-save").click();
    await expect(page.getByText(/setting\(s\) saved/)).toBeVisible({ timeout: 60_000 });
  });
});

test.describe("settings › downloader", () => {
  test("the form loads, and the tool paths are read-only", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/downloader");
    await expect(page.getByTestId("settings-downloader")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("ytdlp-banner")).toContainText("yt-dlp");
    await expect(page.getByTestId("chips-channel")).toBeVisible();
    // docs/06-stack.md fixes the concurrency at one; the page must not pretend otherwise.
    await expect(page.getByText("one download at a time")).toBeVisible();
  });

  test("a changed knob survives a save and a reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/downloader");
    await expect(page.getByTestId("settings-downloader")).toBeVisible({ timeout: 60_000 });

    await page.getByTestId("input-jitter-min").fill("7000");
    await page.getByTestId("downloader-save").click();
    await expect(page.getByText(/setting\(s\) saved/)).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId("input-jitter-min")).toHaveValue("7000");

    await page.getByTestId("input-jitter-min").fill("5000");
    await page.getByTestId("downloader-save").click();
    await expect(page.getByText(/setting\(s\) saved/)).toBeVisible({ timeout: 60_000 });
  });
});
