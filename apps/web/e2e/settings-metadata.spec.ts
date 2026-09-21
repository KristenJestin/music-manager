import { expect, test, signIn } from "./helpers.ts";

/**
 * Issue #4 — the switch the work fields hang on, on the page that owns it.
 *
 * The settings page owes every key it shows the same thing: the choices, the default, and a value
 * that survives a reload. `classical` has to be the one that is on out of the box, because that is
 * the behaviour the tag map documents (`docs/03-metadonnees.md` §2.4).
 */
test.describe("settings › metadata — the work tags switch", () => {
  test("shows the three choices, saves one, and keeps it across a reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/metadata");
    await expect(page.getByTestId("settings-metadata")).toBeVisible({ timeout: 60_000 });

    const chips = page.getByTestId("setting-writeWorkTags");
    await expect(chips).toBeVisible({ timeout: 60_000 });
    const classical = chips.getByRole("button", { name: "Classical releases only" });
    const always = chips.getByRole("button", { name: "Every release" });
    const never = chips.getByRole("button", { name: "Never" });

    // The default of D4-03, on a page nobody has saved from yet.
    await expect(classical).toHaveAttribute("aria-pressed", "true");
    await expect(always).toHaveAttribute("aria-pressed", "false");
    await expect(never).toHaveAttribute("aria-pressed", "false");

    await always.click();
    await expect(always).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(
      page.getByTestId("setting-writeWorkTags").getByRole("button", { name: "Every release" }),
    ).toHaveAttribute("aria-pressed", "true", { timeout: 60_000 });

    // Put it back, so the rest of the suite reads the documented default.
    await page
      .getByTestId("setting-writeWorkTags")
      .getByRole("button", { name: "Classical releases only" })
      .click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });
  });
});
