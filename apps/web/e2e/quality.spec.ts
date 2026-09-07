import type { Page } from "@playwright/test";
import { TAG_SCHEMA_VERSION } from "@mm/domain";
import { expect, test, signIn, typeInto } from "./helpers.ts";

/**
 * The version the bump goes to: the next one, whatever the current one is.
 *
 * It used to be the literal `2`, which worked exactly as long as the projection stayed at
 * v1. Raising `TAG_SCHEMA_VERSION` to 2 for the album-scope pass turned the override into a
 * no-op, the library stayed up to date, and the test failed on "every placed file is now
 * behind the projection" — a red run caused by the constant it was asserting against, not by
 * the behaviour it describes.
 */
const NEXT_SCHEMA = TAG_SCHEMA_VERSION + 1;

/**
 * The acceptance scenario of `docs/phases/P07-bibliotheque-qualite.md`:
 *
 *   bump the tag schema → the Quality page says N files are behind → a dry run shows the diff
 *   without touching anything → the real run drains the `retag` queue offline → 0 behind.
 *
 * The bump is the `tagSchemaVersionOverride` setting, changed through the Settings page like a
 * person would. That is deliberately not an environment variable: the Console, the worker and
 * the CLI are three processes, and a test that flipped a knob in one and expected the others
 * to agree needs the knob to live where all three already look — the database.
 *
 * Everything the re-tag does is offline. It rebuilds each document from the raw source cache
 * (`documents.rebuild` with `offline: true`, which makes a cache miss an error rather than an
 * HTTP call), projects it, and hands the pairs to the toolbox. No network, no re-download, and
 * the audio stream is never touched.
 */

/**
 * The text of an element that may not be there, read in **one** call.
 *
 * `if (await locator.count() > 0) await locator.innerText()` is a check followed by an act, and
 * `/library/quality` refreshes itself while a re-tag runs: the element can be counted and then
 * gone, and `innerText` then waits thirty seconds for something that has just been removed.
 * That is how this spec failed a run — `locator.innerText: Timeout 30000ms exceeded, waiting
 * for getByTestId('files-behind')`, on a page that had simply moved on. `allInnerTexts()` asks
 * once and answers `[]` when there is nothing, so there is no window between the two.
 */
async function textOrNothing(page: Page, testId: string): Promise<string | undefined> {
  return (await page.getByTestId(testId).allInnerTexts())[0];
}

/** Read the "files behind" number out of the schema callout. */
async function filesBehind(page: Page): Promise<number> {
  await page.goto("/library/quality");
  await expect(page.getByTestId("schema-callout")).toBeVisible({ timeout: 60_000 });
  const badge = await textOrNothing(page, "files-behind");
  return badge === undefined ? 0 : Number.parseInt(badge.trim(), 10);
}

/**
 * Set the schema override through the Settings page, as a person would.
 *
 * It asserts the value **after a reload**, not the toast. The toast says "N setting(s) saved",
 * and `N` may be zero — which is exactly what happened when the form accepted a keystroke
 * before React was attached to it: the page saved the values the loader had put there, said so
 * cheerfully, and the override never moved. A round trip is the only honest confirmation.
 */
async function setOverride(page: Page, value: number): Promise<void> {
  await page.goto("/settings/metadata");
  const field = page.getByTestId("setting-tagSchemaVersionOverride");
  await expect(field).toBeVisible({ timeout: 60_000 });
  await typeInto(field, String(value));
  await page.getByTestId("settings-save").click();
  await expect(page.getByText(/setting\(s\) saved/i)).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await expect(page.getByTestId("setting-tagSchemaVersionOverride")).toHaveValue(String(value), {
    timeout: 60_000,
  });
}

/** Wait for the run in flight to finish, whatever it was. */
async function waitForRetag(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto("/library/quality");
        const bar = await textOrNothing(page, "retag-progress");
        return bar !== undefined && bar.includes("running") ? "running" : "idle";
      },
      { timeout: 180_000, intervals: [2000] },
    )
    .toBe("idle");
}

test.describe("metadata quality and the tag schema", () => {
  test("the filters and the profile selector", async ({ page }) => {
    await signIn(page);
    await page.goto("/library/quality");

    await expect(page.getByRole("heading", { name: "Metadata quality" })).toBeVisible();
    await expect(page.getByTestId("quality-table")).toBeVisible();
    const all = await page.getByTestId("quality-row").count();
    expect(all).toBeGreaterThan(0);

    /*
     * A filter is a link, and it narrows: "below 80%" can never hold more than "all".
     *
     * Waited on the **chip**, not on the URL. Two versions of this test guessed at the query
     * string and both were wrong in a different way: `/\/library\/quality/` also matches the
     * page as it stood *before* the click, so the row count read straight after was the old
     * view's; and the replacement waited for a bare path with no query, which never comes,
     * because TanStack Router keeps a search value that happens to equal its zod default —
     * "all" is `?filter=all&profile=global`. `data-active` is the loader's own answer to
     * "which filter am I showing", so there is nothing left to guess.
     */
    await page.getByTestId("quality-filters-below80").click();
    await expect(page.getByTestId("quality-filters-below80")).toHaveAttribute(
      "data-active",
      "true",
      { timeout: 60_000 },
    );
    await expect
      .poll(async () => await page.getByTestId("quality-row").count(), { timeout: 30_000 })
      .toBeLessThanOrEqual(all);

    await page.getByTestId("quality-filters-all").click();
    await expect(page.getByTestId("quality-filters-all")).toHaveAttribute("data-active", "true", {
      timeout: 60_000,
    });
    await expect(page.getByTestId("quality-row")).toHaveCount(all, { timeout: 30_000 });

    // The profile re-scores the same albums; it never changes how many there are, because it
    // changes the view and not the files.
    // A Base UI `Select`, not a native one since owner review C11: click, then pick the option.
    await page.getByTestId("quality-profile").click();
    await page.getByRole("option", { name: /^Navidrome/ }).click();
    await page.waitForURL(/profile=navidrome/, { timeout: 60_000 });
    await expect(page.getByTestId("quality-row")).toHaveCount(all, { timeout: 30_000 });
    await expect(page.getByText("Visible in navidrome")).toBeVisible();
  });

  test("a schema bump, a dry run, and a re-tag that closes it", async ({ page }) => {
    await signIn(page);

    /* ---- before: the library is current ------------------------------------ */

    expect(await filesBehind(page), "the library starts up to date").toBe(0);

    /* ---- bump ------------------------------------------------------------- */

    await setOverride(page, NEXT_SCHEMA);

    const behind = await filesBehind(page);
    expect(behind, "every placed file is now behind the projection").toBeGreaterThan(0);
    await expect(page.getByTestId("retag-all")).toContainText(String(behind));

    /* ---- the dry run: a diff, and not one byte written --------------------- */

    await page.getByTestId("retag-dry-run").click();
    await expect(page.getByText(/dry run queued/i)).toBeVisible({ timeout: 60_000 });
    await waitForRetag(page);

    // A dry run writes nothing, so the count is exactly what it was.
    expect(await filesBehind(page), "a dry run changes no file").toBe(behind);

    /* ---- the real run ------------------------------------------------------ */

    await page.getByTestId("retag-all").click();
    await expect(page.getByText(/re-tag queued/i)).toBeVisible({ timeout: 60_000 });
    await waitForRetag(page);

    await expect
      .poll(async () => await filesBehind(page), { timeout: 180_000, intervals: [3000] })
      .toBe(0);

    // And the album page agrees: nothing is behind there either.
    await page.goto("/library");
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });
    await page.getByTestId("album-tab-metadata").click();
    await expect(
      page.getByText(new RegExp(`MUSICMANAGER_TAGSCHEMA=${String(NEXT_SCHEMA)}`)),
    ).toBeVisible({ timeout: 60_000 });

    /* ---- put the override back --------------------------------------------- */

    await setOverride(page, 0);
  });
});
