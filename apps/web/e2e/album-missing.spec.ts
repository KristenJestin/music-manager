import { expect, test, mintKey, reloadUntil, signIn } from "./helpers.ts";
import {
  albumReleaseMbid,
  detachAlbumTrack,
  firstAlbumId,
  reattachAlbumTrack,
  type DetachedTrack,
} from "./seed.ts";

/**
 * "16 of 20" was a number with no remedy behind it.
 *
 * When a playlist does not publish every track of a record, the album is created anyway and is
 * then incomplete for ever: adoption lived only on the page of an *import*, and a finished
 * import does not re-open. `mm library show` said `16/20` and nothing anywhere said **which
 * four**, so the owner's only recourse was to open MusicBrainz in another tab and diff the
 * tracklist against the album page by eye.
 *
 * This is the other end of that. The missing tracks are rows of the album's own tracklist —
 * greyed, at their own positions, among the ones that are there — and each carries the button
 * that fills it. Every assertion here goes through the Console, except the last, which asks
 * `/api/v1` the same question with a real API key: the rule the whole feature is built to is
 * that a gesture exists in the interface *and* in the API, and a test that only drove the page
 * would prove half of it.
 *
 * The situation is seeded by detaching one `library_tracks` row from its album — the one
 * column that distinguishes "the playlist never published this" from "it did" — and it is
 * re-attached at the end, because the suite is serial against one database and one library
 * directory and a spec that leaves an album short breaks the ones after it. No file is moved
 * and no row is deleted, so the inverse is exact.
 *
 * **Nothing is adopted for real.** The last thing the page does here is submit a path the
 * server's allow-list must refuse, which drives the whole chain — dialog, server function,
 * `adoptLibraryTrack`, the slot lookup, `resolveSourcePath` — and writes nothing. The
 * *successful* path is proved where it can be proved without disturbing a shared library:
 * `server/services/album-missing.integration.test.ts` carries one adopted track through
 * `fingerprint`, `tag` and `place` and checks that `present_count` moves by exactly one.
 */
test.describe("an album that is missing tracks", () => {
  test("names them in place, and offers to fill each one", async ({ page }) => {
    await signIn(page);

    const albumId = await firstAlbumId();
    expect(
      albumId,
      "no album with two placed tracks: import-album.spec.ts places the album this spec reads, so run the whole suite rather than this file alone",
    ).not.toBeNull();
    if (albumId === null) return;

    /* ---- nothing is missing yet, and the page says nothing ---- */

    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId("album-title")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("album-missing")).toHaveCount(0);
    await expect(page.getByTestId("album-missing-adopt")).toHaveCount(0);

    const releaseMbid = await albumReleaseMbid(albumId);
    expect(releaseMbid, "the album was matched against a release").not.toBeNull();

    let detached: DetachedTrack | null = null;
    try {
      /* ---- one of the release's tracks is not in the library ---- */

      detached = await detachAlbumTrack(albumId);
      expect(detached, "an album track was detached").not.toBeNull();
      if (detached === null) return;

      await reloadUntil(page, `/library/albums/${albumId}`, async () => {
        await expect(page.getByTestId("album-missing")).toBeVisible();
      });

      const callout = page.getByTestId("album-missing");
      await expect(callout).toContainText("1 track(s) of this release are not in the library");
      // It says what the remedy is, in the same breath: a state with no action beside it is
      // the thing this feature exists to stop being.
      await expect(callout).toContainText("that track alone is downloaded, tagged and filed");

      /* ---- and it is a row of the tracklist, at its own position ---- */

      const rows = page.getByTestId("album-tracks").locator("tbody tr");
      const missingRow = rows.filter({ has: page.getByTestId("album-missing-badge") });
      await expect(missingRow).toHaveCount(1);
      // The release's own title for it, which is the whole point: the number said how many
      // were absent and never which.
      await expect(missingRow).toContainText(detached.title);
      await expect(missingRow.getByTestId("album-missing-source")).toHaveText("never published");

      /*
       * Interleaved, not appended. The seeded hole is the album's *second* track, so an
       * implementation that listed the missing ones after the present ones would put it last —
       * this is the assertion that tells the two apart.
       */
      const all = await rows.count();
      expect(all).toBeGreaterThan(2);
      const index = await missingRow.evaluate((row) =>
        Array.from(row.parentElement?.children ?? []).indexOf(row),
      );
      expect(index, "the missing track sits at its own position, not at the end").toBeLessThan(
        all - 1,
      );

      /* ---- the row's own button opens the dialog, with all three ways in ---- */

      await missingRow.getByTestId("album-missing-adopt").click();
      const dialog = page.getByTestId("adopt-file-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(detached.title);
      for (const mode of ["upload", "path", "url"]) {
        await expect(dialog.getByTestId(`adopt-mode-${mode}`)).toBeVisible();
      }

      /* ---- an address is offered, because there is often no local file ---- */

      await dialog.getByTestId("adopt-mode-url").click();
      await expect(dialog.getByTestId("adopt-url-input")).toBeVisible();

      /* ---- and the whole chain is wired, proved by a refusal that writes nothing ---- */

      await dialog.getByTestId("adopt-mode-path").click();
      await dialog.getByTestId("adopt-path-input").fill("/definitely/not/allowed/track.opus");
      await dialog.getByTestId("adopt-file-confirm").click();
      // The server's own refusal, reaching the browser through the server function: the
      // allow-list is empty by default and this path is outside the library.
      await expect(page.getByTestId("toaster")).toContainText(/not allowed|No such file/, {
        timeout: 30_000,
      });

      /* ---- the API answers the same question, for the agent that has no screen ---- */

      await page.keyboard.press("Escape");
      const key = await mintKey(page, `missing-${String(Date.now())}`, ["library:read"]);
      const answer = await page.request.get(`/api/v1/library/albums/${albumId}/missing`, {
        headers: { "x-api-key": key },
      });
      expect(answer.status()).toBe(200);
      const body = (await answer.json()) as {
        missing: { mediumPosition: number; trackPosition: number; title: string }[];
        unavailable: string | null;
        presentCount: number;
        trackCount: number;
      };
      expect(body.unavailable).toBeNull();
      expect(body.missing).toHaveLength(1);
      // The couple, not a flat index: it is what the adoption route's path takes.
      expect(body.missing[0]?.mediumPosition).toBe(detached.discNumber);
      expect(body.missing[0]?.trackPosition).toBe(detached.trackNumber);
      expect(body.missing[0]?.title).toBe(detached.title);
      expect(body.presentCount).toBeLessThan(body.trackCount);
    } finally {
      /* ---- put the album back, for the specs that run after this one ---- */
      if (detached !== null) await reattachAlbumTrack(albumId, detached.id);
    }

    await reloadUntil(page, `/library/albums/${albumId}`, async () => {
      await expect(page.getByTestId("album-missing")).toHaveCount(0);
    });
  });
});
