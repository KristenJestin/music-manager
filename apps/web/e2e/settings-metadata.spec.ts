import { expect, test, signIn } from "./helpers.ts";

/**
 * Issue #4 — the switch the work fields hang on, on the page that owns it, and issue #5's
 * advisory beside it (see the second block).
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

/**
 * Issue #5 — the advisory switch, on the same page and for the same reason.
 *
 * `ITUNESADVISORY` is the one tag whose absence is a decision rather than missing data, so the
 * owner has to be able to see which way it is set and change it without a terminal. The claim
 * here is the page's own: off out of the box, on after a save, still on after a reload.
 */
test.describe("settings › metadata — the explicit-tag switch", () => {
  test("default installation: the advisory is off, and turning it on survives a reload", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/settings/metadata");
    await expect(page.getByTestId("settings-metadata")).toBeVisible({ timeout: 60_000 });

    const toggle = page.getByTestId("setting-writeExplicitTag");
    await expect(toggle).toBeVisible({ timeout: 60_000 });
    // D5-01's default, on a page nobody has saved from yet.
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId("setting-writeExplicitTag")).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: 60_000 },
    );

    // Put it back, so the rest of the suite reads the documented default.
    await page.getByTestId("setting-writeExplicitTag").click();
    await page.getByTestId("settings-save").click();
    await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });
  });
});
