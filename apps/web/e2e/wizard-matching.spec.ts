/**
 * The owner's bug of 2026-09-17, as the behaviour that replaced it.
 *
 * What he saw: step 2 of the wizard reporting `2/2 searches, 0/12 tracklist lookups`, and then
 * the page dying under an error panel reading *"This page could not be loaded / Invariant
 * failed / UNKNOWN"*. The server had logged `status: 500, ms: 11316` for the server function
 * behind it. The cause was not MusicBrainz and not the proxy: the production runtime closes a
 * connection on which nothing has moved for ten seconds, the match needed fourteen, and the
 * abort escaped as a 500 (`server/http/abort.ts` carries the reproduction).
 *
 * The match therefore no longer lives inside that request. It is started, the request returns
 * immediately, and the screen follows `/api/match-progress` until the ranking lands.
 *
 * **This spec only exists because `MM_MATCH_GRACE_MS=0` is set for the suite**
 * (`scripts/e2e-web.ts`). Offline, step 2 is answered from a cassette in milliseconds, so the
 * request would linger its two seconds, get the answer, and never draw the waiting screen at
 * all — the slow path, the one every real installation takes, would go untested in a browser.
 * With the grace at zero the first request always answers "pending", which is exactly the shape
 * production has, and what is measured below is the whole of it: the page that appears, the
 * progress channel that feeds it, the candidates that arrive on their own, and a reload in the
 * middle that resumes rather than restarts.
 */
import { expect, test, resolveSource, signIn } from "./helpers.ts";

test.describe("wizard step 2 does not hold an HTTP request open", () => {
  test("shows the match running, then the candidates, and a reload resumes it", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });

    /* ---- 1. the wait is a screen, inside the shell, with real counters ----- */

    // The shell is the whole point of the original incident: the default boundary replaces it.
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Something went wrong!")).toHaveCount(0);
    await expect(page.getByText("Invariant failed")).toHaveCount(0);

    const waiting = page.locator('[data-waiting="musicbrainz"]');
    await expect(waiting).toBeVisible({ timeout: 120_000 });
    /*
     * The identifiers *inside* the panel are read with the `-pending` suffix allowed, for the
     * same reason the panel itself is found by `data-waiting`. The router's copy sits in a
     * `PendingTree` and the settled one does not, so its ids are suffixed
     * (`components/pending-tree.tsx`) — and a bare name here would be asserting on the same
     * race one level down. Scoped to the panel already found, so it is still this title and no
     * other; the assertion itself is unchanged.
     */
    await expect(waiting.getByTestId(/^pending-title(-pending)?$/)).toContainText(
      "Searching MusicBrainz",
    );
    await expect(waiting.getByTestId(/^pending-counters(-pending)?$/)).toContainText("searches");

    /* ---- 2. the estimate is arithmetic, not a constant --------------------- */

    // It used to say "about ten seconds" whatever the plan was — wrong for the owner's twelve
    // lookups, and silent about the limit being shared with everything else running.
    const estimate = waiting.getByTestId(/^pending-estimate(-pending)?$/);
    await expect(estimate).toContainText("one request per second");
    await expect(estimate).not.toContainText("about ten seconds");
    await expect(estimate).toContainText("shared");

    /* ---- 3. nobody has to press anything: the candidates arrive ------------ */

    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("candidate-list")).toBeVisible();
    expect(page.url()).toContain(`importId=${importId}`);

    /* ---- 4. a reload lands on the answer, not on a second search ----------- */

    /*
     * The half of the complaint that raising a timeout would not have fixed. The old handler
     * ran the match in the request, so a reload ran it *again* from zero — nine seconds of work
     * thrown away and fifteen more started. The run is now keyed by import: a request arriving
     * while one is in flight joins it, and one arriving after it has finished reads the ranking
     * it left behind (`services/match-runs.test.ts` proves both directly).
     */
    await page.reload();
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("candidate-list")).toBeVisible();
  });
});
