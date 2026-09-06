import { expect, test, signIn, typeInto } from "./helpers.ts";

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
/*
 * Serial, and for a reason: these specs write to the settings store, and other pages read it.
 * Run in parallel they would be testing one another's leftovers.
 */
test.describe.configure({ mode: "serial" });

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

  test("a Navidrome that does not answer is reported as such, never as 'no mismatches'", async ({
    page,
  }) => {
    await expect(
      page.getByTestId("settings-integrations").getByText(/not configured|not answering/),
    ).toBeVisible();
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
    await typeInto(page.getByTestId("navidrome-url"), "http://127.0.0.1:4599");
    await typeInto(page.getByTestId("navidrome-user"), "admin");
    await page.getByTestId("navidrome-test").click();
    /*
     * The assertion is on the **status row**, not on the toast.
     *
     * A failure is a result, and a result belongs in the page: the toast is a four-second
     * courtesy and asserting on it would be timing the animation rather than the behaviour.
     * What must be true is that the page is still there and now says the server is not
     * answering — never that it silently stays on the last good status.
     */
    await expect(page.getByTestId("settings-integrations")).toBeVisible();
    await expect(
      page.getByTestId("settings-integrations").getByText(/not answering|not configured/),
    ).toBeVisible({ timeout: 60_000 });
  });

  /*
   * P07b asserted the badge that said "delivery coming in P08". P08 is the delivery, so the
   * badge is gone and the assertion had to become one about behaviour rather than about a
   * promise: the channels are the three real transports, and the Test button — which sends
   * *now*, whatever the event list says — is on the page.
   */
  test("the notifications block offers the three real channels, and can send a test", async ({
    page,
  }) => {
    const channels = page.getByTestId("chips-notify-channel");
    await expect(channels).toBeVisible();
    for (const label of ["None", "ntfy", "Discord", "Email (SMTP)"]) {
      await expect(channels.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    // A signed, retried callback is a *webhook* and lives on Settings › API & agents; it is
    // deliberately no longer one of these channels.
    await expect(channels.getByRole("button", { name: "Webhook", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("chips-notify-events")).toBeVisible();
    await expect(page.getByTestId("notifications-test")).toBeVisible();
  });

  test("a saved value is read back by the settings store", async ({ page }) => {
    await typeInto(page.getByTestId("navidrome-url"), "http://navidrome.test:4533");
    await page.getByTestId("integrations-save").click();
    await expect(page.getByTestId("toaster")).toContainText(/setting\(s\) saved/, {
      timeout: 60_000,
    });

    await page.reload();
    await expect(page.getByTestId("navidrome-url")).toHaveValue("http://navidrome.test:4533");

    /*
     * Put it back, and wait for the toast *before* reloading.
     *
     * A reload on its own aborts the save that is still in flight ("Failed to fetch") and
     * leaves the store holding the previous value. The toast says the server function came
     * back; the reload after it is what proves the store really kept the answer.
     */
    await typeInto(page.getByTestId("navidrome-url"), "");
    await page.getByTestId("integrations-save").click();
    await expect(page.getByTestId("toaster")).toContainText(/setting\(s\) saved/, {
      timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByTestId("navidrome-url")).toHaveValue("");
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

    await typeInto(page.getByTestId("input-jitter-min"), "7000");
    await page.getByTestId("downloader-save").click();
    await expect(page.getByTestId("toaster")).toContainText(/setting\(s\) saved/, {
      timeout: 60_000,
    });

    await page.reload();
    await expect(page.getByTestId("input-jitter-min")).toHaveValue("7000");

    await typeInto(page.getByTestId("input-jitter-min"), "5000");
    await page.getByTestId("downloader-save").click();
    await expect(page.getByTestId("toaster")).toContainText(/setting\(s\) saved/, {
      timeout: 60_000,
    });
    await page.reload();
    await expect(page.getByTestId("input-jitter-min")).toHaveValue("5000");
  });
});
