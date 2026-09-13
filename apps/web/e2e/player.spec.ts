import { expect, test, reloadUntil, signIn } from "./helpers.ts";

/**
 * The mini-player, against the album `import-album.spec.ts` places.
 *
 * What is checked is **the wiring**, not the sound: headless Chromium has no audio output and
 * the fixture file is five seconds of a bundled Opus sample, so asserting that something is
 * audible would be asserting that the container is up. What can go wrong and be invisible is
 * the chain from a click to a loaded source — the queue, the context, the `<audio>` element's
 * `src`, the same-origin `/api/stream` URL — and that is what this drives.
 *
 * `p` sorts after `import-album` and after `library`, so the album is there by the time this
 * runs; the suite is serial and in file-name order (`playwright.config.ts`).
 */
test.describe("the player", () => {
  test("plays a library track from the album page", async ({ page }) => {
    await signIn(page);

    await reloadUntil(page, "/library", async () => {
      await expect(
        page.getByTestId("album-card").first(),
        "the library is empty: import-album.spec.ts places the album this test plays",
      ).toBeVisible({ timeout: 5_000 });
    });
    await page.getByTestId("album-card").first().click();
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });

    const rows = page.getByTestId("album-tracks").locator("tbody tr");
    await expect(rows.first()).toBeVisible();
    const title = await rows.first().locator("td").nth(2).innerText();

    /* ---- the bar is not there until something is loaded -------------------- */

    await expect(page.getByTestId("player-bar")).toHaveCount(0);

    await rows.first().getByTestId("track-play").click();

    /* ---- it names the track and has really loaded a source ----------------- */

    const bar = page.getByTestId("player-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("player-title")).toHaveText(title.trim());
    await expect(page.getByTestId("player-source")).toHaveText("Library");

    const audio = page.getByTestId("player-audio");
    // Same-origin and by row id: the library path is never in a URL (`api.stream.ts`).
    await expect(audio).toHaveAttribute("src", /^\/api\/stream\?track=/);

    /*
     * And the endpoint really answers. `<audio>` in headless Chromium may or may not get as
     * far as decoding, so the proof that the route works is taken from the page's own fetch,
     * with the session cookie it already has — which is the half a screenshot cannot show.
     */
    const status = await page.evaluate(async () => {
      const url = document.querySelector("audio")?.getAttribute("src") ?? "";
      const response = await fetch(url, { headers: { Range: "bytes=0-1023" } });
      return { code: response.status, range: response.headers.get("content-range") };
    });
    expect(status.code).toBe(206);
    expect(status.range).toMatch(/^bytes 0-1023\/\d+$/);

    /* ---- the queue is the album, and Close puts it away --------------------- */

    if ((await rows.count()) > 1) {
      await expect(page.getByTestId("player-queue")).toBeVisible();
    }
    await page.getByTestId("player-close").click();
    await expect(page.getByTestId("player-bar")).toHaveCount(0);
  });

  test("plays a single track from its own page", async ({ page }) => {
    await signIn(page);

    await reloadUntil(page, "/library/tracks", async () => {
      await expect(page.getByTestId("tracks-table").locator("tbody tr").first()).toBeVisible({
        timeout: 5_000,
      });
    });
    await page.getByTestId("tracks-table").locator("tbody tr").first().click();
    await page.waitForURL(/\/library\/tracks\//, { timeout: 60_000 });

    const title = await page.getByTestId("track-title").innerText();
    await page.getByTestId("track-play").click();

    await expect(page.getByTestId("player-title")).toHaveText(title.trim());
    await expect(page.getByTestId("player-audio")).toHaveAttribute("src", /^\/api\/stream\?track=/);
    // One track is a queue of one: no position counter, and both skips are off.
    await expect(page.getByTestId("player-queue")).toHaveCount(0);
  });
});
