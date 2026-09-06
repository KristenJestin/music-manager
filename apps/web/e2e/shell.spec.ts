import { expect, test } from "@playwright/test";
import { pressGlobal, shellReady, signIn } from "./helpers.ts";

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
    await page.getByTestId("url-paste").fill("fixture://discovery");
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
    await page.getByTestId("url-paste").fill("no");
    await page.getByTestId("url-paste").press("r");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("url-paste")).toHaveValue("nor");
  });

  test("⌘K opens the palette, Escape closes it", async ({ page }) => {
    await shellReady(page);
    await pressGlobal(page, "ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await page.getByTestId("palette-input").fill("Jobs");
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

  test("Library and System are navigable, and honest about arriving in P07", async ({ page }) => {
    for (const path of ["/library", "/library/tracks", "/library/quality", "/tools", "/settings"]) {
      await page.goto(path);
      await expect(page.getByTestId("coming-soon")).toBeVisible();
      await expect(page.getByTestId("coming-soon")).toContainText(/Coming in P0[79]/);
    }
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
