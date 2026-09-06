import { expect, test, signIn } from "./helpers.ts";

/**
 * The library scan, driven from the Tools card.
 *
 * The E2E library is empty until a spec imports something, so what this proves is the shape
 * of the feature rather than a particular finding: the card says "never scanned" honestly, a
 * scan can be queued from the page, and when the worker has run one the four sections appear
 * with their counts. The findings themselves — orphan, missing, drift, duplicate — are proven
 * on real files by `bun run e2e-verify`, which is where they can be *caused*.
 */
test.describe("library scan", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/tools");
    await expect(page.getByTestId("tools-scan")).toBeVisible({ timeout: 60_000 });
  });

  test("the card says so when the library has never been scanned", async ({ page }) => {
    const card = page.getByTestId("tools-scan");
    // Either state is legitimate depending on what ran before; both must be explicit.
    const empty = page.getByTestId("scan-empty");
    if (await empty.isVisible().catch(() => false)) {
      await expect(empty).toContainText("never been scanned");
      await expect(empty).toContainText("moved to the trash");
    } else {
      await expect(card.getByTestId("scan-orphans")).toBeVisible();
    }
  });

  test("Scan now refreshes the panel by itself, with no F5 — DRIVE-1 §B4", async ({ page }) => {
    /*
     * The panel used to go on saying "never run · 0 / 0 / 0" after a scan, because the page
     * invalidated its loader the instant the message was posted — before the worker had
     * walked anything. The button now waits for the run it started, so this asserts the whole
     * report **without reloading**, which is exactly what the old code could not do.
     */
    await page.getByTestId("scan-now").click();
    await expect(page.getByText(/Scan finished/)).toBeVisible({ timeout: 120_000 });

    for (const section of ["scan-orphans", "scan-missing", "scan-drift", "scan-duplicates"]) {
      await expect(page.getByTestId(section), section).toBeVisible();
    }
    await expect(page.getByTestId("tools-scan")).toContainText("last");
  });

  test("nothing on the card offers to delete a file outright", async ({ page }) => {
    /*
     * The scan's findings are heuristics, and a heuristic must never be allowed to destroy an
     * original. The only removal the page offers is a move into the trash directory, and the
     * button says so — this is the assertion that keeps it that way.
     */
    const card = page.getByTestId("tools-scan");
    await expect(card.getByRole("button", { name: /^Delete$/ })).toHaveCount(0);
  });
});
