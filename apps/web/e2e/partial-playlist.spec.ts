import { expect, test, resolveSource, signIn } from "./helpers.ts";

/**
 * The wizard, on a playlist that lost one of its entries.
 *
 * The defect of 2026-09-17: a single unreadable video cancelled the extraction of the whole
 * playlist, so twenty live albums were filed as vanished from YouTube under one video's
 * message. The extraction now tolerates the hole — and the point of *this* test is the other
 * half, which is that tolerating it silently would be its own bug. Somebody about to press
 * Start on fourteen tracks has to know the source offered fifteen.
 *
 * `fixture://discovery?gap=14` takes entry 14 out of the recorded listing and reports it as
 * unreadable, exactly as a live `ignoreerrors` extraction does.
 *
 * **Nothing is started.** The wizard parks its import until step 4 says otherwise, and this
 * test never says otherwise: it reads the parked import's own page instead. Two reasons —
 * the assertions are about what is shown *before* the decision, and a second Discovery import
 * running to completion would be filing into the album `import-album.spec.ts` owns.
 */
test.describe("a playlist with an unreadable entry", () => {
  test("says 14 of 15 before Start, and keeps saying it afterwards", async ({ page }) => {
    await signIn(page);

    /* ---- step 1: the count is the listing's, not the survivors' ---------- */

    const importId = await resolveSource(page, "fixture://discovery?gap=14");
    await expect(page.getByTestId("source-count")).toContainText("14 of 15 entries");
    await expect(page.getByTestId("source-videos").locator("tbody tr")).toHaveCount(14);

    /* ---- step 4: the gap, before the decision ---------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });
    await page.waitForURL(/release=/, { timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 120_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    const summary = page.getByTestId("summary-unreadable");
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("14 of 15 entries; 1 could not be read");
    // The source's own sentence, not a code: "private" and "deleted" are different news.
    await expect(summary).toContainText("Private video");

    /* ---- and on the import's own page, for as long as it exists ---------- */

    await page.goto(`/imports/${importId}`);
    const callout = page.getByTestId("job-unreadable");
    await expect(callout).toBeVisible();
    await expect(callout).toContainText("14 of 15 entries");
    await expect(callout).toContainText("entry 15");
  });
});
