import { expect, test, pasteIntoPage, resolveSource, signIn, uniqueSource } from "./helpers.ts";

/**
 * What the wizard says while it is reading a source.
 *
 * The owner's report: a URL pasted while a download is running leaves the wizard on *"Reading
 * the source… Asking YouTube what is behind this link"* for about a minute, with nothing on
 * screen to say what else the installation is doing. The panel now names it — the import
 * holding the single download slot, what is queued behind it, each one a link — and says, in
 * the same breath, that reading a link is **not** queued behind that download. Both halves are
 * asserted here, because a panel that listed a queue and let the reader infer they were in it
 * would be a more confident version of the same silence.
 *
 * Two runs, and the second is the one that costs something:
 *
 *  - **nothing of ours running.** The list is empty, the copy is different, and it says the
 *    wait belongs to the source alone.
 *  - **a download in flight.** `?slow=<ms>` paces the fixture download of one import so it is
 *    still going while a second URL is pasted; `?extractslow=<ms>` holds `/extract` open long
 *    enough for the pending screen to be read. Without the two switches a fixture resolves in
 *    milliseconds and there is no screen to look at.
 *
 * Two details of *how* it is driven are load-bearing:
 *
 *  - the URL arrives by **paste, Enter** through the palette. That is the owner's gesture, and
 *    it is also the only one that produces the screen: `page.goto("/import/new?url=…")` is a
 *    document request, which the server answers only once the resolve it triggers has
 *    finished. A client-side navigation is what gives the router a pending state to draw.
 *  - the ids carry `-pending`, because this panel is drawn inside the route's **pending** tree
 *    and `components/pending-tree.tsx` suffixes every test id there so that the two trees of
 *    one route never answer to the same name.
 */

/** Long enough for the pending screen to be read, well under the toolbox's 20 s cap. */
const EXTRACT_SLOW_MS = 9000;

test.describe("the wizard while it reads a source", () => {
  test("with nothing of ours running, the list is empty and the copy says so", async ({ page }) => {
    await signIn(page);

    /*
     * The precondition, asserted rather than assumed: this suite is serial and single-worker,
     * but a spec that ran before this one may have left an import in the queue, and "nothing
     * is in the way" is a claim about the whole installation. The sidebar's own counter reads
     * the same `workerSnapshot` the panel does.
     */
    await page.goto("/imports");
    await expect(page.getByTestId("worker-queued")).toHaveText("1 slot · 0 queued", {
      timeout: 120_000,
    });
    await expect(page.getByTestId("worker-idle")).toBeVisible();

    const url = `${uniqueSource("fixture://skinny-love")}&extractslow=${String(EXTRACT_SLOW_MS)}`;
    await pasteIntoPage(page, url);
    await page.getByTestId("palette-input").press("Enter");

    const panel = page.getByTestId("slot-queue-pending");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toHaveAttribute("data-idle", "yes");
    await expect(panel).toHaveAttribute("role", "status");
    // Nothing is named, because there is nothing to name.
    await expect(page.getByTestId("slot-holder-pending")).toHaveCount(0);
    await expect(page.getByTestId("slot-waiting-pending")).toHaveCount(0);
    await expect(page.getByTestId("slot-queue-note-pending")).toContainText(
      "No download is running and nothing is queued",
    );
    // Elapsed time, never a countdown.
    await expect(page.getByTestId("slot-queue-elapsed-pending")).toContainText("Waiting");

    // And the resolve it was waiting on still lands, so the next test starts from a settled app.
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });
  });

  test("with a download in flight, it names the job holding the slot and links to it", async ({
    page,
  }) => {
    await signIn(page);

    /* ---- 1 · put a download in flight, through the wizard, as a person would ---------- */

    const downloading = await resolveSource(page, "fixture://discovery?slow=1200");

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=3/, { timeout: 120_000 });
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    /*
     * Force the re-download. Earlier specs import the same fifteen videos and leave them in
     * the library, and `download` is right to skip a track it already has — which would leave
     * this test watching a slot nobody ever takes.
     */
    await page.getByTestId("option-force").click();
    await expect(page.getByTestId("option-force")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("wizard-start").click();
    await page.waitForURL(new RegExp(`/imports/${downloading}`), { timeout: 120_000 });

    // The slot is genuinely taken: a track is moving bytes, not merely queued.
    await page
      .locator('[data-testid="track-progress"][data-downloading="yes"]')
      .first()
      .waitFor({ state: "attached", timeout: 120_000 });

    /* ---- 2 · paste a second URL, and read what the wizard says while it waits --------- */

    const url = `${uniqueSource("fixture://currents")}&extractslow=${String(EXTRACT_SLOW_MS)}`;
    await pasteIntoPage(page, url);
    await page.getByTestId("palette-input").press("Enter");

    const panel = page.getByTestId("slot-queue-pending");
    await expect(panel).toBeVisible({ timeout: 60_000 });
    await expect(panel).toHaveAttribute("data-idle", "no");

    // The blocking job, named, with a real href to its page.
    const holder = page.getByTestId("slot-holder-pending");
    await expect(holder).toBeVisible();
    await expect(holder).toHaveAttribute("data-import-id", downloading);
    await expect(holder).toHaveAttribute("href", new RegExp(`/imports/${downloading}$`));
    await expect(page.getByTestId("slot-holder-progress-pending")).toContainText("downloading");

    /*
     * And the honest half. The list above is context; the wait itself is not queued behind it,
     * which is what the measurement of this branch established and what the reader has to be
     * told before a list of other people's jobs can mean anything.
     */
    await expect(page.getByTestId("slot-queue-note-pending")).toContainText(
      "does not wait for the download slot",
    );

    // The screen is a waiting state, announced as one.
    await expect(page.getByTestId("wizard-pending")).toHaveAttribute("data-waiting", "source");

    // The resolve still lands: the panel is a companion to the wait, not a replacement for it.
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 60_000 });
  });
});
