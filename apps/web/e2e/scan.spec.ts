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

  test("Scan now queues a run and the report comes back with its four sections", async ({
    page,
  }) => {
    await page.getByTestId("scan-now").click();
    await expect(page.getByText(/Scan queued/)).toBeVisible({ timeout: 30_000 });

    // The worker picks the job off the `scan` queue; the page shows the run once it lands.
    await expect(async () => {
      await page.reload();
      await expect(page.getByTestId("scan-orphans")).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 120_000 });

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
