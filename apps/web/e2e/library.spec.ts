import type { Page } from "@playwright/test";
import { expect, test, reloadUntil, signIn, typeInto } from "./helpers.ts";

/**
 * The library screens, against a library that really has files in it.
 *
 * The album that `import-album.spec.ts` places is the subject, and this spec **does not
 * import one of its own**. The suite is single-worker and serial against one database
 * (`playwright.config.ts`), specs run in file-name order, and `import-album` sorts before
 * `library` — so the album is there by the time this runs.
 *
 * An earlier version drove the wizard itself when the library looked empty. It was worse in
 * every way: it started a second import of the same source while the first one's job was
 * still settling, it duplicated the coverage `import-album.spec.ts` already owns, and when it
 * failed it failed *in the wizard*, which is not what this file is about. Waiting is honest
 * and the failure message says exactly what is missing.
 */

/**
 * Wait for the album `import-album.spec.ts` placed.
 *
 * **Re-navigating, not polling one render.** `/library` is a loader page: it reads its rows
 * once, when it is opened. An earlier version opened it and then waited two minutes on the
 * locator, which is a wait that can never end — and did not, the one time this spec started
 * five seconds before the worker finished writing the album row. `data-testid="album-card"`
 * was never going to appear in a document that had already been rendered without it.
 */
async function ensureLibrary(page: Page): Promise<void> {
  await reloadUntil(page, "/library", async () => {
    await expect(
      page.getByTestId("album-card").first(),
      "the library is empty: import-album.spec.ts places the album these tests read, so run the whole suite rather than this file alone",
    ).toBeVisible({ timeout: 5_000 });
  });
}

test.describe("the library", () => {
  test("the grid, an album, and the metadata tab's profile switch", async ({ page }) => {
    await signIn(page);
    await ensureLibrary(page);

    /* ---- the grid ---------------------------------------------------------- */

    await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
    const cards = page.getByTestId("album-card");
    await expect(cards.first()).toBeVisible();

    // The filters are links, so a filtered view is a URL. "All" must hold every album.
    // `data-active` rather than the query string: the router keeps a search value that equals
    // its default, so "all" is `?filter=all…` and not the bare path (see quality.spec.ts).
    const total = await cards.count();
    await page.getByTestId("library-filters-all").click();
    await expect(page.getByTestId("library-filters-all")).toHaveAttribute("data-active", "true", {
      timeout: 60_000,
    });
    await expect(cards).toHaveCount(total);

    // Searching for something that cannot match empties the grid rather than erroring.
    await typeInto(page.getByTestId("library-search"), "zzz-no-such-album");
    await page.getByTestId("library-search").press("Enter");
    await expect(page.getByTestId("library-empty")).toBeVisible();
    await page.goto("/library");

    /* ---- one album --------------------------------------------------------- */

    const title = await cards.first().getAttribute("data-album-title");
    await cards.first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });
    await expect(page.getByTestId("album-title")).toHaveText(title ?? "");
    await expect(page.getByTestId("album-tracks")).toBeVisible();
    await expect(page.getByTestId("album-tracks").locator("tbody tr").first()).toBeVisible();

    /* ---- the metadata tab, and the profile switch -------------------------- */

    await page.getByTestId("album-tab-metadata").click();
    await page.waitForURL(/tab=metadata/, { timeout: 60_000 });
    const tagMap = page.getByTestId("tag-map");
    await expect(tagMap).toBeVisible();

    /*
     * The superset is the whole map; a profile is a strict subset of it. That is the entire
     * claim of §5, and it is visible as a row count.
     *
     * **Polled, not read once.** `waitForURL` resolves on the address bar, and the address bar
     * changes before the loader's answer is rendered: a `count()` taken straight after it is
     * the *previous* profile's, and the assertion then reads `expect(103).toBeLessThan(103)` —
     * which is exactly how this failed, once, on a loaded machine. The row count is the thing
     * the profile is supposed to change, so it is the thing to wait on.
     */
    const rows = tagMap.locator("tbody tr[data-testid^='tag-row-']");
    const supersetRows = await rows.count();
    expect(supersetRows).toBeGreaterThan(50);

    await page.getByTestId("profile-navidrome").click();
    await page.waitForURL(/profile=navidrome/, { timeout: 60_000 });
    await expect
      .poll(async () => await rows.count(), { timeout: 30_000 })
      .toBeLessThan(supersetRows);
    expect(await rows.count()).toBeGreaterThan(0);

    // Plex ignores MusicBrainz identifiers entirely, so that row must disappear for it —
    // and reappear for the superset, because a profile changes the view and not the files.
    await page.getByTestId("profile-plex").click();
    await page.waitForURL(/profile=plex/, { timeout: 60_000 });
    await expect(tagMap.getByTestId("tag-row-musicbrainz_recordingid")).toHaveCount(0);
    await page.getByTestId("profile-global").click();
    await expect(tagMap.getByTestId("tag-row-musicbrainz_recordingid")).toHaveCount(1);

    /* ---- the format-key columns ------------------------------------------- */

    await page.getByTestId("format-keys-toggle").click();
    await page.waitForURL(/keys=true/, { timeout: 60_000 });
    await expect(tagMap.getByRole("columnheader", { name: "Vorbis" })).toBeVisible();
    await expect(tagMap.getByRole("columnheader", { name: "ID3v2.4" })).toBeVisible();
    await expect(tagMap.getByRole("columnheader", { name: "MP4" })).toBeVisible();
  });

  test("DB vs files opens every file and finds no drift on a freshly tagged album", async ({
    page,
  }) => {
    await signIn(page);
    await ensureLibrary(page);
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });

    await page.getByTestId("album-tab-tags").click();
    await page.waitForURL(/tab=tags/, { timeout: 60_000 });
    // One toolbox round trip per file, so it is given room.
    await expect(page.getByTestId("db-vs-files")).toBeVisible({ timeout: 120_000 });
    await expect(
      page.getByText("The file holds exactly what the database says.").first(),
    ).toBeVisible({ timeout: 120_000 });
  });

  test("the MusicBrainz tab shows the identifiers and the decision that chose them", async ({
    page,
  }) => {
    await signIn(page);
    await ensureLibrary(page);
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });

    await page.getByTestId("album-tab-mb").click();
    await page.waitForURL(/tab=mb/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Identifiers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Matching decision" })).toBeVisible();

    await page.getByTestId("album-tab-history").click();
    await page.waitForURL(/tab=history/, { timeout: 60_000 });
    await expect(page.getByTestId("album-history")).toBeVisible();
  });

  test("tracks and artists list what is on disk", async ({ page }) => {
    await signIn(page);
    await ensureLibrary(page);

    // Same loader page, same rule: open it again until it holds a row, rather than watching
    // one render of it and hoping.
    const rows = page.getByTestId("tracks-table").locator("tbody tr");
    await reloadUntil(page, "/library/tracks", async () => {
      await expect(page.getByTestId("tracks-table")).toBeVisible({ timeout: 5_000 });
      await expect(rows.first()).toBeVisible({ timeout: 5_000 });
    });

    // A track page is one file: the document, its provenance, and where it came from.
    await rows.first().click();
    await page.waitForURL(/\/library\/tracks\//, { timeout: 60_000 });
    await expect(page.getByTestId("track-title")).toBeVisible();
    await expect(page.getByTestId("track-document")).toBeVisible();

    await page.goto("/library/artists");
    await expect(page.getByTestId("artists-table")).toBeVisible();
    await expect(page.getByTestId("artists-table").locator("tbody tr").first()).toBeVisible();
  });

  /**
   * The manual override, end to end — the clean equivalent of v1's forced metadata.
   *
   * `ALBUM` on purpose, even though it is the most disruptive field to pick: it is of **album
   * scope**, so the value has to land on every track of the album, and it is one of the names
   * the path template renders, so the answer has to *offer* a relocate rather than quietly
   * renaming thirteen files behind a person's back. A safer field would have tested neither.
   *
   * The test puts the album back by **unlocking** it, which is the other half of the feature
   * and the only honest way to leave the library as it was found: the console field is removed
   * and the document re-resolved offline, so MusicBrainz owns `ALBUM` again and the files stay
   * where they already are. Specs that run after this one (`quality`, `relocate`) would
   * otherwise inherit an album whose folder no longer matches its title.
   */
  test("an album field can be typed by hand, and unlocking gives it back", async ({ page }) => {
    await signIn(page);
    await ensureLibrary(page);
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });
    const albumUrl = page.url();

    await page.getByTestId("album-tab-metadata").click();
    await page.waitForURL(/tab=metadata/, { timeout: 60_000 });

    const row = page.getByTestId("album-field-album");
    await expect(row).toBeVisible();
    const original = (await row.getByTestId("field-edit-album").innerText()).trim();

    /* ---- type a value ------------------------------------------------------ */

    await row.getByTestId("field-edit-album").click();
    const input = row.getByTestId("field-input-album");
    await expect(input).toBeVisible();
    await input.fill(`${original} (Deluxe)`);
    await row.getByTestId("field-save-album").click();

    // The toast is the evidence a re-tag run was opened: the service only says so when
    // `createRun` came back with files in scope.
    await expect(page.getByTestId("toaster")).toContainText(/re-tag queued/i, { timeout: 60_000 });

    /*
     * A name the path template uses changed, so a relocate is *offered* and not done. Closing
     * it is a perfectly good answer — the tags are right, only the filenames are stale — and
     * it is the answer this test gives, because moving a file costs it its Navidrome play
     * count.
     */
    const offerDialog = page.getByTestId("relocate-offer");
    await expect(offerDialog).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
    await expect(offerDialog).toBeHidden();

    await expect(row.getByTestId("field-edit-album")).toContainText("(Deluxe)");
    await expect(row.getByTestId("field-source-badge")).toHaveText("console");

    /* ---- the value is on the track's document, locked, from the console ----- */

    // `/library/tracks` is a loader page like `/library`: open it again until it holds a row,
    // rather than watching one render of it and hoping (see `ensureLibrary`).
    const rows = page.getByTestId("tracks-table").locator("tbody tr");
    await reloadUntil(page, "/library/tracks", async () => {
      await expect(rows.first()).toBeVisible({ timeout: 5_000 });
    });
    /*
     * The `#` cell, not the row: the Album column carries a link to the album and it sits near
     * the middle of the row, which is exactly where a `row.click()` lands. That click navigates
     * to the album and the wait for a track URL never ends.
     */
    await rows.first().locator("td").first().click();
    await page.waitForURL(/\/library\/tracks\/ltr_/, { timeout: 60_000 });
    const documentRow = page.getByTestId("document-row-album");
    await expect(documentRow).toContainText("(Deluxe)");
    await expect(documentRow).toContainText("console");
    await expect(documentRow).toContainText("locked");

    /* ---- unlock: the resolvers own it again, and the library is as it was --- */

    await page.goto(`${albumUrl.split("?")[0] ?? albumUrl}?tab=metadata`);
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.getByTestId("field-unlock-album").click();
    await expect(page.getByTestId("toaster")).toContainText(/ALBUM/, { timeout: 60_000 });

    await reloadUntil(page, `${albumUrl.split("?")[0] ?? albumUrl}?tab=metadata`, async () => {
      await expect(row.getByTestId("field-edit-album")).toHaveText(original, { timeout: 5_000 });
    });
    await expect(row.getByTestId("field-source-badge")).toHaveCount(0);
  });
});
