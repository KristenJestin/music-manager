/**
 * "N files are behind the database", where the owner already is.
 *
 * `AGENTS.md`'s first guiding fact is that the database is the source of truth and the files
 * are a regenerable projection of it. When that stops being true — a release re-confirmed, a
 * field corrected — the only thing that ever said so was a library scan the owner had to think
 * to ask for, and the only remedy was a re-tag he had to know existed and remember to run.
 *
 * This spec is the other end of that: the state is on the album's own page, it names its cause,
 * and there is one button beside it. The situation is seeded by writing the two columns
 * `applySupplied` writes when a different edition is confirmed (`seed.swapTrackBindings`) and
 * nothing else; every assertion goes through the Console.
 *
 * The swap is its own inverse and is undone at the end, because the suite is serial against one
 * database and one library directory — a spec that leaves an album mis-tagged breaks the next
 * four. `scripts/e2e-fixture.ts` §8 is the same claim proved at the other level, by reading the
 * tags back out of the file.
 */
import { expect, test, reloadUntil, signIn } from "./helpers.ts";
import { firstAlbumId, swapTrackBindings } from "./seed.ts";

test.describe("files behind the database", () => {
  test("say so on the album page, and one button fixes them", async ({ page }) => {
    await signIn(page);

    const albumId = await firstAlbumId();
    expect(
      albumId,
      "no album with two placed tracks: import-album.spec.ts places the album this spec reads, so run the whole suite rather than this file alone",
    ).not.toBeNull();
    if (albumId === null) return;

    /* ---- nothing is wrong yet, and the page says nothing ---- */

    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId("album-title")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("album-adrift")).toHaveCount(0);

    /* ---- a different edition is confirmed over files that are already placed ---- */

    const swapped = await swapTrackBindings(albumId);
    expect(swapped, "two bindings were swapped").toBe(2);

    await reloadUntil(page, `/library/albums/${albumId}`, async () => {
      await expect(page.getByTestId("album-adrift")).toBeVisible();
    });

    const callout = page.getByTestId("album-adrift");
    await expect(callout).toContainText("2 file(s) are behind the database");
    // It names the cause rather than leaving the reader to guess at it.
    await expect(callout).toContainText("previous edition's identifiers");

    /* ---- one button, and it is the runner the Quality page already has ---- */

    await callout.getByTestId("album-adrift-retag").click();
    // Scoped to the toaster: the activity feed prints `createRun`'s own journal line, which says
    // "Re-tag queued: 2 file(s)" — near enough to this sentence to fail strict mode.
    await expect(
      page.getByTestId("toaster").getByText(/Re-tag queued for 2 file\(s\)/),
    ).toBeVisible({ timeout: 30_000 });

    /* ---- and the state clears itself once the worker has been round ---- */

    await reloadUntil(page, `/library/albums/${albumId}`, async () => {
      await expect(page.getByTestId("album-adrift")).toHaveCount(0);
    });

    /* ---- put the album back, for the four specs that run after this one ---- */

    expect(await swapTrackBindings(albumId)).toBe(2);
    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId("album-adrift")).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("album-adrift-retag").click();
    await reloadUntil(page, `/library/albums/${albumId}`, async () => {
      await expect(page.getByTestId("album-adrift")).toHaveCount(0);
    });
  });
});
