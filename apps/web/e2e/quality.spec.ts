import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers.ts";

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

/** Read the "files behind" number out of the schema callout. */
async function filesBehind(page: Page): Promise<number> {
  await page.goto("/library/quality");
  await expect(page.getByTestId("schema-callout")).toBeVisible({ timeout: 60_000 });
  const badge = page.getByTestId("files-behind");
  if ((await badge.count()) === 0) return 0;
  return Number.parseInt((await badge.innerText()).trim(), 10);
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
  await field.fill(String(value));
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
        const bar = page.getByTestId("retag-progress");
        if ((await bar.count()) === 0) return "idle";
        return (await bar.innerText()).includes("running") ? "running" : "idle";
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

    // A filter is a link, and it narrows: "below 80%" can never hold more than "all".
    await page.getByTestId("quality-filters-below80").click();
    await page.waitForURL(/filter=below80/, { timeout: 60_000 });
    expect(await page.getByTestId("quality-row").count()).toBeLessThanOrEqual(all);

    // Not `/\/library\/quality/`: that pattern also matches the *current* URL, which still
    // carries `?filter=below80` — a substring match, not an exact one — so `waitForURL` was
    // returning immediately against the page as it stood before this click's navigation, and
    // the row count read straight after was the below80 view's, not "all"'s. `filter=all` is
    // the search schema's default, so TanStack Router omits it: bare path, no query at all.
    await page.getByTestId("quality-filters-all").click();
    await page.waitForURL((url) => url.pathname === "/library/quality" && url.search === "", {
      timeout: 60_000,
    });
    expect(await page.getByTestId("quality-row").count()).toBe(all);

    // The profile re-scores the same albums; it never changes how many there are, because it
    // changes the view and not the files.
    await page.getByTestId("quality-profile").selectOption("navidrome");
    await page.waitForURL(/profile=navidrome/, { timeout: 60_000 });
    expect(await page.getByTestId("quality-row").count()).toBe(all);
    await expect(page.getByText("Visible in navidrome")).toBeVisible();
  });

  test("a schema bump, a dry run, and a re-tag that closes it", async ({ page }) => {
    await signIn(page);

    /* ---- before: the library is current ------------------------------------ */

    expect(await filesBehind(page), "the library starts up to date").toBe(0);

    /* ---- bump ------------------------------------------------------------- */

    await setOverride(page, 2);

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
    await expect(page.getByText(/MUSICMANAGER_TAGSCHEMA=2/)).toBeVisible({ timeout: 60_000 });

    /* ---- put the override back --------------------------------------------- */

    await setOverride(page, 0);
  });
});
