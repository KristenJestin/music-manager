import { expect, test, mintKey, reloadUntil, signIn } from "./helpers.ts";
import {
  albumWithTracklist,
  detachAlbumTrack,
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
 * Named `library-album-missing` and not `album-missing`: the suite is serial and runs in
 * file-name order, and the album this reads is placed by `import-album.spec.ts`. A name
 * sorting before that one is a test that always finds an empty library.
 *
 * **Every assertion is a delta, never an absolute.** The albums this suite builds are already
 * short of their releases — the fixture playlist does not cover every track of the release the
 * matcher picks — so "the callout is not there to begin with" is simply false here, and a test
 * that asserted it would be asserting something about the fixtures rather than about the
 * feature. What is checked instead is what *this spec's own seed* changes: one more missing
 * row, named, and gone again when the row is put back.
 *
 * The seed detaches one `library_tracks` row from its album — the one column that distinguishes
 * "the playlist never published this" from "it did" — and re-attaches it in a `finally`, because
 * the suite is serial against one database and one library directory and a spec that leaves an
 * album short breaks the ones after it. No file is moved and no row is deleted, so the inverse
 * is exact.
 *
 * **Nothing is adopted for real.** The last thing the page does here is submit a path the server
 * must refuse, which drives the whole chain — dialog, server function, `adoptLibraryTrack`, the
 * slot lookup — and writes nothing. Which refusal comes back depends on the seed, and the
 * assertion accepts either; see the comment at that step for why both are right. The
 * *successful* path is proved where it can be proved without disturbing a shared library:
 * `server/services/album-missing.integration.test.ts` carries one adopted track through
 * `fingerprint`, `tag` and `place` and checks that `present_count` moves by exactly one.
 */
test.describe("an album that is missing tracks", () => {
  test("names them in place, and offers to fill each one", async ({ page }) => {
    await signIn(page);

    const albumId = await albumWithTracklist();
    expect(
      albumId,
      "no album with three placed tracks and a MusicBrainz release: import-album.spec.ts places the album this spec reads, so run the whole suite rather than this file alone",
    ).not.toBeNull();
    if (albumId === null) return;

    /* ---- how short the album is before this spec touches it ---- */

    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId("album-title")).toBeVisible({ timeout: 30_000 });
    // The tracklist is knowable at all: `album-incomplete-unknown` is the other case, and an
    // album in it can say nothing about which tracks it has not got.
    await expect(page.getByTestId("album-incomplete-unknown")).toHaveCount(0);

    const rows = page.getByTestId("album-tracks").locator("tbody tr");
    const missingRows = rows.filter({ has: page.getByTestId("missing-track-badge") });
    const before = await missingRows.count();

    let detached: DetachedTrack | null = null;
    try {
      /* ---- one more of the release's tracks is not in the library ---- */

      detached = await detachAlbumTrack(albumId);
      expect(detached, "an album track was detached").not.toBeNull();
      if (detached === null) return;

      await reloadUntil(page, `/library/albums/${albumId}`, async () => {
        await expect(
          page
            .getByTestId("album-tracks")
            .locator("tbody tr")
            .filter({ has: page.getByTestId("missing-track-badge") }),
        ).toHaveCount(before + 1);
      });

      const callout = page.getByTestId("album-incomplete");
      await expect(callout).toContainText("not in the library");
      // It says what the remedy is in the same breath: a state with no action beside it is the
      // thing this feature exists to stop being.
      await expect(callout).toContainText("that track alone is downloaded, tagged and filed");

      /* ---- and the detached track is a row of the tracklist, by name ---- */

      const seeded = rows.filter({ hasText: detached.title }).filter({
        has: page.getByTestId("missing-track-badge"),
      });
      await expect(seeded).toHaveCount(1);
      await expect(seeded.getByTestId("missing-track-source")).toHaveText("never published");

      /*
       * Interleaved, not appended. The seeded hole is the album's *second* track, so an
       * implementation that listed the missing ones after the present ones would put it last —
       * this is the assertion that tells the two apart.
       */
      const total = await rows.count();
      const index = await seeded.evaluate((row) =>
        Array.from(row.parentElement?.children ?? []).indexOf(row),
      );
      expect(index, "the missing track sits at its own position, not at the end").toBeLessThan(
        total - 1,
      );

      /* ---- the row's own button opens the dialog, with all three ways in ---- */

      await seeded.getByTestId("missing-track-adopt").click();
      const dialog = page.getByTestId("adopt-file-dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(detached.title);
      for (const mode of ["upload", "path", "url"]) {
        await expect(dialog.getByTestId(`adopt-mode-${mode}`)).toBeVisible();
      }

      /*
       * And nothing it holds may be painted outside it.
       *
       * The three ways in are `whitespace-nowrap` buttons — the widest thing this dialog has —
       * and they used to widen the dialog's content column instead of wrapping: the description
       * then wrapped at that wider width and was drawn past the panel, over whatever was behind
       * it. `DialogContent` is a grid whose single column is sized to its widest child's
       * minimum, so this is a property of the *dialog*, not of the row that happened to be
       * guilty: comparing each child's edges to the panel's catches the next too-wide child too.
       * Nothing else can catch it — overflow is invisible to the DOM and to every unit test,
       * and only a browser that has laid the page out can say where the pixels went.
       */
      const escaping = await dialog.evaluate((panel) => {
        const box = panel.getBoundingClientRect();
        return Array.from(panel.children)
          .map((child) => ({ child, rect: child.getBoundingClientRect() }))
          .filter(({ rect }) => rect.right > box.right + 1 || rect.left < box.left - 1)
          .map(
            ({ child, rect }) =>
              `${child.getAttribute("data-testid") ?? child.tagName} is ${String(
                Math.round(rect.right - box.right),
              )}px past the right edge`,
          );
      });
      expect(escaping, "no child of the dialog is painted outside it").toEqual([]);

      /* ---- an address is offered, because there is often no local file ---- */

      await dialog.getByTestId("adopt-mode-url").click();
      await expect(dialog.getByTestId("adopt-url-input")).toBeVisible();

      /* ---- and the whole chain is wired, proved by a refusal that writes nothing ---- */

      await dialog.getByTestId("adopt-mode-path").click();
      await dialog.getByTestId("adopt-path-input").fill("/definitely/not/allowed/track.opus");
      await dialog.getByTestId("adopt-file-confirm").click();
      /*
       * A refusal from the *server*, reaching the browser through the server function — which
       * is what proves the chain, dialog to `adoptLibraryTrack`, without writing anything.
       *
       * Two of them are correct here and which one arrives depends on the seed. This spec
       * detaches a `library_tracks` row, so the track's `import_tracks` row is still there and
       * still filed: the album is short of it only as far as the library is concerned, and
       * `adoptLibraryTrack` says so and points at `repair-orphans` before it ever looks at the
       * path. On a track the playlist genuinely never published there is no row, and the
       * allow-list refuses the path instead. Both are the server talking.
       */
      await expect(page.getByTestId("toaster")).toContainText(
        /already has a row|not allowed|No such file/,
        {
          timeout: 30_000,
        },
      );
      await page.keyboard.press("Escape");

      /* ---- the API answers the same question, for the agent that has no screen ---- */

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
      expect(body.missing).toHaveLength(before + 1);
      /*
       * `presentCount` and `trackCount` are deliberately *not* asserted here.
       *
       * They are `library_albums` columns, and `album-counters.ts` is their only writer — this
       * spec's seed detaches a row and leaves them exactly as they were, on purpose, so that
       * re-attaching is an exact inverse. So the album still reports `14/14` while the
       * tracklist honestly shows fifteen slots, and that disagreement is the seed's, not the
       * feature's: the counters move when `place` files a track, which is the path
       * `album-missing.integration.test.ts` drives and checks.
       */
      // The couple, not a flat index: it is what the adoption route's path takes.
      const slot = body.missing.find((track) => track.title === detached?.title);
      expect(slot, "the API names the same track the page does").toBeDefined();
      expect(slot?.mediumPosition).toBe(detached.discNumber);
      expect(slot?.trackPosition).toBe(detached.trackNumber);
    } finally {
      /* ---- put the album back, for the specs that run after this one ---- */
      if (detached !== null) await reattachAlbumTrack(albumId, detached.id);
    }

    await reloadUntil(page, `/library/albums/${albumId}`, async () => {
      await expect(
        page
          .getByTestId("album-tracks")
          .locator("tbody tr")
          .filter({ has: page.getByTestId("missing-track-badge") }),
      ).toHaveCount(before);
    });
  });
});
