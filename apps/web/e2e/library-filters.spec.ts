import type { Page } from "@playwright/test";
import { expect, test, reloadUntil, signIn, typeInto } from "./helpers.ts";

/**
 * The filter builder on `/library`, driven the way a person drives it.
 *
 * Like `library.spec.ts`, this reads the album `import-album.spec.ts` places and imports
 * nothing of its own: the suite is single-worker and serial against one database, specs run in
 * file-name order, and `import-album` sorts before `library-filters`.
 *
 * Two conditions rather than one, because one condition proves nothing about the encoding —
 * `?f=` has to carry a *list*, joined, and come back as the same list. And the third act is a
 * reload rather than a re-render: the filter's home is the URL, so the only proof that matters
 * is that the URL alone reproduces the view.
 */

async function ensureLibrary(page: Page): Promise<void> {
  await reloadUntil(page, "/library", async () => {
    await expect(
      page.getByTestId("album-card").first(),
      "the library is empty: import-album.spec.ts places the album these tests read, so run the whole suite rather than this file alone",
    ).toBeVisible({ timeout: 5_000 });
  });
}

/** Walk the picker: field, then operator, then the value, then Add. */
async function addCondition(
  page: Page,
  field: string,
  operator: string | null,
  value: string | null,
): Promise<void> {
  await page.getByTestId("filter-add").click();
  await expect(page.getByTestId("filter-fields")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId(`filter-field-${field}`).click();
  await expect(page.getByTestId("filter-builder")).toBeVisible();

  if (operator !== null) {
    await page.getByTestId("filter-operator").click();
    await page.getByRole("option", { name: operator, exact: true }).click();
  }
  if (value !== null) await typeInto(page.getByTestId("filter-value-0"), value);

  await page.getByTestId("filter-apply").click();
}

test.describe("the library filter builder", () => {
  test("two conditions, the rows they leave, and the URL that reproduces them", async ({
    page,
  }) => {
    await signIn(page);
    await ensureLibrary(page);

    const cards = page.getByTestId("album-card");
    const title = (await cards.first().getAttribute("data-album-title")) ?? "";
    expect(title).not.toBe("");
    // A word of the title, so `contains` is doing work rather than matching the whole string.
    const word = title.split(" ")[0] ?? title;

    /* ---- one condition ------------------------------------------------------ */

    await addCondition(page, "title", null, word);
    await page.waitForURL(/[?&]f=/, { timeout: 60_000 });
    await expect(page.getByTestId("filter-chip-0")).toBeVisible();
    await expect(page.getByTestId("filter-chip-0")).toContainText("Title contains");
    await expect(cards.first()).toBeVisible();
    await expect(page.getByTestId("album-card").filter({ hasText: title })).toHaveCount(1);

    /* ---- and a second, which is what the encoding is actually for ----------- */

    // "Metadata at least 1 %" holds every album that has been scored at all, so the pair
    // narrows to the same album rather than to nothing — the point here is the *list*.
    await addCondition(page, "score", "at least", "1");
    await expect(page.getByTestId("filter-chip-1")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("filter-chip-1")).toContainText("Metadata at least");
    // Two conditions means the all/any switch appears, and it says "all" by default.
    await expect(page.getByTestId("filter-join")).toContainText("Match all");
    await expect(page.getByTestId("album-card").filter({ hasText: title })).toHaveCount(1);

    const url = page.url();
    expect(decodeURIComponent(url)).toContain("title:contains:");
    expect(decodeURIComponent(url)).toContain("score:gte:1");

    /* ---- the URL is the filter --------------------------------------------- */

    await page.reload();
    await expect(page.getByTestId("filter-chip-0")).toContainText("Title contains");
    await expect(page.getByTestId("filter-chip-1")).toContainText("Metadata at least");
    await expect(page.getByTestId("filter-join")).toContainText("Match all");
    await expect(page.getByTestId("album-card").filter({ hasText: title })).toHaveCount(1);

    // And it is a link: the same URL in a fresh navigation is the same view.
    await page.goto(url);
    await expect(page.getByTestId("filter-chip-1")).toContainText("Metadata at least");
    await expect(page.getByTestId("album-card").filter({ hasText: title })).toHaveCount(1);

    /* ---- a condition that excludes empties the grid rather than erroring ---- */

    await page
      .getByTestId("filter-chip-1")
      .getByRole("button", { name: /^Remove the filter/ })
      .click();
    await expect(page.getByTestId("filter-chip-1")).toHaveCount(0, { timeout: 60_000 });
    await addCondition(page, "title", "starts with", "zzz-no-such-album");
    await expect(page.getByTestId("library-empty")).toBeVisible({ timeout: 60_000 });

    /* ---- clearing puts everything back ------------------------------------- */

    await page.getByTestId("filter-clear").click();
    await expect(page.getByTestId("filter-chip-0")).toHaveCount(0, { timeout: 60_000 });
    await expect(cards.first()).toBeVisible();
  });

  test("a filter a link cannot deliver degrades to no filter, with a notice", async ({ page }) => {
    await signIn(page);
    await ensureLibrary(page);
    const total = await page.getByTestId("album-card").count();

    // A field that is not on the whitelist — a truncated link, or somebody guessing a column
    // name. Neither may reach a query, and neither may cost the reader the page.
    await page.goto("/library?f=cover_path%3Acontains%3Ax");
    await expect(page.getByTestId("filter-error")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("filter-error")).toContainText("was ignored");
    await expect(page.getByTestId("album-card")).toHaveCount(total);

    // And a string that is not the grammar at all.
    await page.goto("/library?f=%28year%3Agte%3A2000");
    await expect(page.getByTestId("filter-error")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("album-card")).toHaveCount(total);
  });

  test("the tracks page filters and pages on the same predicate", async ({ page }) => {
    await signIn(page);
    await reloadUntil(page, "/library/tracks", async () => {
      await expect(page.getByTestId("tracks-table").locator("tbody tr").first()).toBeVisible({
        timeout: 5_000,
      });
    });

    const rows = page.getByTestId("tracks-table").locator("tbody tr");

    // Opus is what the fixture downloads, so "Format is Opus" holds rows rather than nothing.
    await page.getByTestId("filter-add").click();
    await expect(page.getByTestId("filter-fields")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("filter-field-format").click();
    await page.getByTestId("filter-apply").click();
    await page.waitForURL(/[?&]f=/, { timeout: 60_000 });
    await expect(page.getByTestId("filter-chip-0")).toContainText("Format is Opus");
    await expect(rows.first()).toBeVisible();

    /*
     * And then a format this library does not hold. The assertion is not "no rows" — it is
     * that the *pager* says `0–0 of 0`. A predicate applied after the page was fetched would
     * empty the table and leave that line describing the unfiltered library, which is the bug
     * the whole design exists to make impossible.
     */
    // `exact`, because the chip's other button is named "Remove the filter Format is Opus" and
    // a substring match owns both.
    await page
      .getByTestId("filter-chip-0")
      .getByRole("button", { name: "Format is Opus", exact: true })
      .click();
    await expect(page.getByTestId("filter-builder")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("filter-value-select").click();
    await page.getByRole("option", { name: "WAV", exact: true }).click();
    await page.getByTestId("filter-apply").click();

    await expect(page.getByTestId("filter-chip-0")).toContainText("Format is WAV", {
      timeout: 60_000,
    });
    // `DataTable` draws one row holding its empty message, so "no rows" is that message.
    await expect(page.getByText("No track matches.")).toBeVisible();
    await expect(page.getByText("0–0 of 0")).toBeVisible();
  });
});
