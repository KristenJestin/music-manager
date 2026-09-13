import type { Page } from "@playwright/test";
import { expect, test, signIn } from "./helpers.ts";

/**
 * `/discover`, offline.
 *
 * Everything this page shows is computed from `MM_FIXTURES=1`: the listening signals come from
 * the recorded Navidrome cassette, the discography comparison and the ListenBrainz similarity
 * from the `source_cache` rows `bun run cache:seed-fixtures` writes. No socket is opened by any
 * of it, which is what makes these assertions the same on every machine.
 *
 * The three acceptance criteria of `docs/phases/P09-discover.md` are here in order — the page
 * renders its three blocks; **Import** lands in the wizard at step 2 with a release already
 * chosen; **Not interested** survives a sync — plus the split of the Recommended block.
 *
 * That fourth test asserts the *invariant* rather than a population: the two tabs partition the
 * recommendations, and "In your library" never offers an Import. It holds whether or not the
 * fixture library happens to own one of the suggestions, which is what keeps it from depending
 * on whichever spec ran before it.
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

  test("Recommended is split into two tabs that are never shown together", async ({ page }) => {
    await sync(page);
    await page.reload();

    const block = page.getByTestId("discover-recommendations");
    const toImport = page.getByTestId("discover-recommended-tab-to-import");
    const inLibrary = page.getByTestId("discover-recommended-tab-in-library");
    await expect(toImport).toBeVisible();
    await expect(inLibrary).toBeVisible();

    /*
     * The counts are the whole point of splitting: every recommendation is in exactly one of
     * the two tabs, so they add up to the number the heading claims. Read from the chips
     * rather than computed here, because a tab that lies about its size is the failure this
     * assertion is for.
     */
    const countOf = async (tab: typeof toImport): Promise<number> =>
      Number.parseInt((await tab.innerText()).replace(/\D+/g, ""), 10);
    const heading = await block.innerText();
    const total = Number.parseInt(/(\d+) suggestions/.exec(heading)?.[1] ?? "-1", 10);
    expect((await countOf(toImport)) + (await countOf(inLibrary))).toBe(total);

    /* "To import" is the default, and it is the half that offers to import. */
    await expect(toImport).toHaveAttribute("data-active", "true");
    await expect(inLibrary).toHaveAttribute("data-active", "false");
    const importable = await block.getByTestId("discover-item").count();
    expect(importable).toBe(await countOf(toImport));
    if (importable > 0) {
      await expect(block.getByTestId("discover-import").first()).toBeVisible();
      await expect(block.getByTestId("discover-open-album")).toHaveCount(0);
    }
    const first = await block
      .getByTestId("discover-item")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-subject")));

    /* The other half: owned already, so nothing here may offer an Import. */
    await inLibrary.click();
    await expect(inLibrary).toHaveAttribute("data-active", "true");
    await expect(page).toHaveURL(/recommended=in-library/);
    await expect(block.getByTestId("discover-import")).toHaveCount(0);
    const second = await block
      .getByTestId("discover-item")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-subject")));
    expect(second.length).toBe(await countOf(inLibrary));
    // Mutually exclusive: no subject appears under both tabs.
    expect(second.filter((subject) => first.includes(subject))).toEqual([]);

    /* The choice is in the URL, so a reload lands where you were and not on the default. */
    await page.reload();
    await expect(page.getByTestId("discover-recommended-tab-in-library")).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(
      page.getByTestId("discover-recommendations").getByTestId("discover-import"),
    ).toHaveCount(0);
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
