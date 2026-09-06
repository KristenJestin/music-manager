import { expect, test, pressGlobal, shellReady, signIn, typeInto } from "./helpers.ts";

/**
 * The Console shell: the parts that are on every page, and the keyboard.
 *
 * `docs/07-ui.md` calls this app keyboard-first, which is a claim that has to be checked
 * rather than asserted in a docstring.
 */
test.describe("the shell", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("the paste box takes a URL straight into the wizard", async ({ page }) => {
    // `typeInto`, not `fill`: the paste box is a Base UI input and does not see a value set
    // through the native setter (see helpers.ts). Its Enter handler reads React state.
    await typeInto(page.getByTestId("url-paste"), "fixture://discovery");
    await page.getByTestId("url-paste").press("Enter");
    await page.waitForURL(/\/import\/new/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 120_000 });
  });

  test("N opens the wizard and R opens the review queue", async ({ page }) => {
    await pressGlobal(page, "n");
    await page.waitForURL(/\/import\/new/, { timeout: 60_000 });

    await page.goto("/");
    await shellReady(page);
    await pressGlobal(page, "r");
    await page.waitForURL(/\/review/, { timeout: 60_000 });
  });

  test("a shortcut does not fire while you are typing into a field", async ({ page }) => {
    await typeInto(page.getByTestId("url-paste"), "no");
    await page.getByTestId("url-paste").press("r");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("url-paste")).toHaveValue("nor");
  });

  test("⌘K opens the palette, Escape closes it", async ({ page }) => {
    await shellReady(page);
    await pressGlobal(page, "ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await typeInto(page.getByTestId("palette-input"), "Jobs");
    await page.getByRole("option", { name: "Jobs" }).first().click();
    await page.waitForURL(/\/imports/, { timeout: 60_000 });

    await pressGlobal(page, "ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await pressGlobal(page, "Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
  });

  test("the activity drawer opens and shows the journal", async ({ page }) => {
    await page.getByTestId("open-drawer").click();
    const drawer = page.getByTestId("activity-drawer");
    await expect(drawer).toHaveAttribute("aria-hidden", "false");
    await pressGlobal(page, "Escape");
    await expect(drawer).toHaveAttribute("aria-hidden", "true");
  });

  test("the worker card is on every page", async ({ page }) => {
    for (const path of ["/", "/imports", "/review"]) {
      await page.goto(path);
      await expect(page.getByTestId("worker-card")).toBeVisible();
    }
  });

  /**
   * Every entry in the sidebar leads somewhere real — and now every one of them is built.
   *
   * P07 replaced its own placeholders and left `/discover` as the last one, asserted here by
   * the phase name it advertised. P09 built it, so the exception is gone and the rule is the
   * whole list: no `coming-soon` anywhere, and a heading on each page.
   */
  test("every Library and System entry leads to a real page", async ({ page }) => {
    for (const path of ["/library", "/library/tracks", "/library/quality", "/discover", "/tools"]) {
      await page.goto(path);
      await expect(page.getByTestId("coming-soon")).toHaveCount(0);
      await expect(page.locator("h1").first()).toBeVisible();
    }
    // `/settings` is a layout: it redirects to its first tab rather than rendering alone.
    await page.goto("/settings");
    await expect(page.getByTestId("settings-nav")).toBeVisible();
  });

  test("the dashboard tiles link where they say they do", async ({ page }) => {
    await page.goto("/");
    await page.getByText("Needs you").click();
    await page.waitForURL(/\/review/, { timeout: 60_000 });
    await page.goto("/");
    await page.getByText("In progress").click();
    await page.waitForURL(/\/imports/, { timeout: 60_000 });
  });
});
