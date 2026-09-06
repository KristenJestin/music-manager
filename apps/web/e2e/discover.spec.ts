import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers.ts";

/**
 * `/discover`, offline.
 *
 * Everything this page shows is computed from `MM_FIXTURES=1`: the listening signals come from
 * the recorded Navidrome cassette, the discography comparison and the ListenBrainz similarity
 * from the `source_cache` rows `bun run cache:seed-fixtures` writes. No socket is opened by any
 * of it, which is what makes these assertions the same on every machine.
 *
 * The three tests are the three acceptance criteria of `docs/phases/P09-discover.md`, in order:
 * the page renders its three blocks; **Import** lands in the wizard at step 2 with a release
 * already chosen; **Not interested** survives a sync.
 */

/** Sync, and wait for the run to have finished rather than for a spinner to have started. */
async function sync(page: Page): Promise<void> {
  await page.getByTestId("discover-sync").click();
  await expect(page.getByText(/gaps · .* recommendations/)).toBeVisible({ timeout: 120_000 });
}

test.describe("discover", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto("/discover");
    await expect(page.getByTestId("discover")).toBeVisible({ timeout: 60_000 });
  });

  test("renders the three blocks and the signals behind them", async ({ page }) => {
    await sync(page);
    await page.reload();

    /* The strip: three sources, each saying what it is and whether it answered. */
    const signals = page.getByTestId("discover-signals");
    await expect(signals).toBeVisible();
    await expect(signals.getByTestId("signal-source-navidrome")).toBeVisible();
    await expect(signals.getByTestId("signal-source-listenbrainz")).toBeVisible();
    await expect(signals.getByTestId("signal-source-last.fm")).toBeVisible();
    // The cassette's most-played artist, weighted and named.
    await expect(signals).toContainText("Daft Punk");
    await expect(signals).toContainText("french house");

    /* Block 1: the discography gaps, grouped by artist with the shelf count. */
    const discography = page.getByTestId("discover-discography");
    await expect(discography.getByTestId("discography-card").first()).toBeVisible();
    await expect(discography.getByTestId("discography-card").first()).toContainText(
      /you have \d+ of \d+/,
    );
    await expect(discography.getByTestId("discover-item").first()).toContainText(
      /played \d+× this month/,
    );

    /* Block 2: recommendations, each with a score bar and a reason. */
    const recommendations = page.getByTestId("discover-recommendations");
    await expect(recommendations.getByTestId("discover-item").first()).toBeVisible();
    await expect(recommendations.getByTestId("discover-item").first()).toContainText(
      /similar to Daft Punk per ListenBrainz/,
    );

    /* Block 3: similar artists. */
    const similar = page.getByTestId("discover-similar");
    await expect(similar.getByTestId("similar-artist").first()).toBeVisible();
    expect(await similar.getByTestId("similar-artist").count()).toBeGreaterThan(0);
  });

  test("Import opens the wizard at step 2 with a release preselected", async ({ page }) => {
    await sync(page);
    await page.reload();

    const item = page.getByTestId("discover-discography").getByTestId("discover-item").first();
    await expect(item).toBeVisible();
    await item.getByTestId("discover-import").click();

    // Fixtures mode resolves the bridge to `fixture://discovery`; the wizard opens on the
    // import that produced, at the release-choice step.
    await page.waitForURL(/\/import\/new\?.*step=2/, { timeout: 120_000 });
    const wizard = page.getByTestId("wizard");
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await expect(wizard).toHaveAttribute("data-step", "2");

    const params = new URL(page.url()).searchParams;
    expect(params.get("importId"), "the wizard should be on a real import").toBeTruthy();
    expect(
      params.get("release"),
      "Discover should have chosen the release, not left it to the wizard",
    ).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("Not interested hides an item, and a sync does not bring it back", async ({ page }) => {
    await sync(page);
    await page.reload();

    const block = page.getByTestId("discover-recommendations");
    const first = block.getByTestId("discover-item").first();
    const subject = await first.getAttribute("data-subject");
    expect(subject, "every item is identified by its MusicBrainz subject").toBeTruthy();

    const before = await block.getByTestId("discover-item").count();
    await first.getByTestId("discover-dismiss").click();
    await expect(page.getByText(/will not be suggested again/)).toBeVisible({ timeout: 30_000 });

    await page.goto("/discover");
    await expect(page.locator(`[data-subject="${subject ?? ""}"]`)).toHaveCount(0);
    expect(await block.getByTestId("discover-item").count()).toBeLessThan(before);

    // The whole point: recomputing must not undo the decision.
    await sync(page);
    await page.reload();
    await expect(page.locator(`[data-subject="${subject ?? ""}"]`)).toHaveCount(0);
    await expect(page.getByTestId("discover-forget")).toBeVisible();

    // And it can be undone deliberately, which is the only way back.
    await page.getByTestId("discover-forget").click();
    await expect(page.getByText(/may come back on the next sync/)).toBeVisible({ timeout: 30_000 });
    await sync(page);
    await page.reload();
    await expect(page.locator(`[data-subject="${subject ?? ""}"]`)).toHaveCount(1);
  });
});
