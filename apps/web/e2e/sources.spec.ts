import { expect, test, signIn, typeInto } from "./helpers.ts";

/**
 * `/sources`, offline.
 *
 * The page is deliberately thin — a table and an add form — so the spec is about the three
 * things that would be expensive to get wrong:
 *
 *  - adding a source works from the form and lands in the table;
 *  - the auto-accept switch **says what it costs** before it is used, rather than after;
 *  - deleting goes through a confirmation that names what is kept, and what is not.
 *
 * Nothing here scans: a scan is worker work, and a browser test that waited for one would be
 * testing the queue. `scripts/e2e-fixture.ts` owns that half.
 */

const URL_ONE = "fixture://watched?snapshot=1&spec=list";

test.describe("watched sources", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/sources");
  });

  test("adds a source from the form and shows it in the table", async ({ page }) => {
    await typeInto(page.getByTestId("source-url"), URL_ONE);
    await typeInto(page.getByTestId("source-label"), "Spec playlist");
    await page.getByTestId("source-add-submit").click();

    const table = page.getByTestId("sources-table");
    await expect(table).toContainText("Spec playlist", { timeout: 30_000 });
    await expect(table).toContainText(URL_ONE);
    // Off unless somebody says otherwise — `docs/04` § Ce que l'algo ne fait jamais.
    await expect(table).toContainText("off");
  });

  test("warns that auto-accept bypasses the review before it is used", async ({ page }) => {
    await page.getByTestId("source-auto-accept").click();
    await expect(page.getByTestId("source-add")).toContainText(/confirm imports without you/i);
    await expect(page.getByTestId("source-add")).toContainText(/watched-source/);
  });

  test("reaches the page from the sidebar", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Sources", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Watched sources" })).toBeVisible();
  });

  test("deletes a source behind a confirmation that says what is kept", async ({ page }) => {
    await typeInto(page.getByTestId("source-url"), "fixture://watched?snapshot=1&spec=delete");
    await page.getByTestId("source-add-submit").click();

    const row = page.getByTestId("sources-table").locator("tr").filter({ hasText: "spec=delete" });
    await expect(row).toBeVisible({ timeout: 30_000 });

    await row.getByRole("button").last().click();
    const dialog = page.getByTestId("source-delete-confirm");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/import\(s\) it already opened are/i);

    await page.getByTestId("source-delete-confirm-confirm").click();
    await expect(page.getByTestId("sources-table")).not.toContainText("spec=delete", {
      timeout: 30_000,
    });
  });
});
