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
});
