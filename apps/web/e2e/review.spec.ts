import {
  expect,
  test,
  mappingRow,
  pressGlobal,
  reloadUntil,
  resolveSource,
  signIn,
  waitForStatus,
} from "./helpers.ts";

/**
 * The second scenario of `docs/phases/P06-web-coeur.md`: a release whose tracklist the source
 * does not fully cover raises `uncovered_tracks`, and "accept as partial" lets the job finish.
 *
 * **Deviation from the letter of the spec, and why.** The spec names `fixture://currents`. The
 * toolbox's `currents` fixture is thirteen videos for a thirteen-track release, so it covers
 * the tracklist completely and raises nothing; the *cassette* for that scenario is the one
 * that omits two videos, and cassettes feed the matcher, not `resolve`. Worse, `currents` has
 * no seeded rows in the raw source cache (P04 seeded Discovery and Skinny Love only), so its
 * `tag` step cannot build a document offline and the job cannot reach `done` at all. So the
 * situation is produced the way a person would produce it — by unbinding two videos in step 3,
 * which also exercises the mapping editor — on the fixture whose sources *are* seeded. The
 * behaviour under test is identical: uncovered tracks, an Inbox question, Enter, `done`.
 *
 * `currents.spec.ts` covers the fixture the spec names, as far as it can go offline.
 */
test.describe("the Inbox", () => {
  test("uncovered tracks are asked about, and accepting as partial finishes the job", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");

    await page.goto(`/import/new?importId=${importId}&step=3`);
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 150_000 });
    await expect(page.getByTestId("bound-count")).toHaveText("14");

    /* ---- the group actions of the prototype, which the app shipped without -- */

    await page.getByTestId("mapping-bulk").getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByTestId("bound-count")).toHaveText("0");
    await page.getByTestId("mapping-bulk").getByRole("button", { name: "Auto-assign" }).click();
    await expect(page.getByTestId("bound-count")).toHaveText("14");

    /* ---- unbind two videos: the mapping editor, doing its one job ---------- */

    for (const title of ["Nightvision", "Short Circuit"]) {
      // A listbox now, not a native select (A10): open it, then take the escape hatch.
      await mappingRow(page, title).getByTestId("mapping-select").click();
      await page.getByRole("option", { name: /not on this release/ }).click();
      await expect(mappingRow(page, title)).toHaveAttribute("data-status", "unmatched");
    }
    await expect(page.getByTestId("bound-count")).toHaveText("12");
    await expect(page.getByTestId("uncovered-count")).toHaveText("2");
    await expect(page.getByTestId("uncovered-callout")).toBeVisible();

    /* ---- start, and let it park on the question ---------------------------- */

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    await expect(page.getByTestId("summary-tracks")).toContainText("2 uncovered");
    await page.getByTestId("wizard-start").click();
    await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });

    /* ---- the Inbox has exactly the question we expected -------------------- */

    await page.goto("/review");
    const item = page
      .getByTestId("review-list")
      .getByRole("link")
      .filter({ hasText: "have no video" })
      .first();
    await expect(item).toBeVisible({ timeout: 60_000 });
    await item.click();

    const card = page.getByTestId("review-card");
    await expect(card).toHaveAttribute("data-item-type", "uncovered_tracks");
    // Decision 002: the answer is proposed, with its reason, and it is the one that lets the
    // job carry on.
    const preselected = page
      .getByTestId("review-option")
      .filter({ has: page.getByText("preselected") });
    await expect(preselected).toContainText("Accept as partial");
    await expect(preselected).toHaveAttribute("aria-checked", "true");
    await expect(card).toContainText("2 missing track(s)");

    /* ---- Enter accepts it, and the job resumes ----------------------------- */

    await pressGlobal(page, "Enter");
    await expect(page.getByTestId("toaster")).toContainText(/Decision saved/, { timeout: 60_000 });

    await page.goto(`/imports/${importId}`);
    await waitForStatus(page, "Done");

    // Answered, so it is gone from the queue.
    await page.goto("/review");
    const remaining = page
      .getByTestId("review-list")
      .getByRole("link")
      .filter({ hasText: "have no video" });
    expect(await remaining.count()).toBe(0);
  });

  /**
   * `fingerprint_mismatch`, side by side.
   *
   * The prototype answers this one with two panels — the mapping you confirmed against what
   * AcoustID heard — and the Console answered it with a sentence and three radios
   * (DRIVE-1 §4). It is also the item the previous drive could not exercise at all, because a
   * real album whose thirteen fingerprints all agree cannot be made to disagree honestly; the
   * toolbox has a fixture switch for exactly that, and it is the honest way to see the screen.
   */
  test("a fingerprint disagreement is shown as a comparison, not as a sentence", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery?fp=mismatch");

    await page.goto(`/import/new?importId=${importId}&step=3`);
    await expect(page.getByTestId("mapping-summary")).toBeVisible({ timeout: 150_000 });
    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=4/, { timeout: 120_000 });
    await expect(page.getByTestId("wizard-start")).toBeEnabled({ timeout: 150_000 });
    await page.getByTestId("wizard-start").click();
    await page.waitForURL(new RegExp(`/imports/${importId}`), { timeout: 120_000 });

    // `/review` is a loader page: it reads its rows once. The item appears a good while after
    // Start, so this re-navigates rather than staring at a photograph (see `helpers.ts`).
    const item = page
      .getByTestId("review-list")
      .getByRole("link")
      .filter({ hasText: "Fingerprint disagrees" })
      .first();
    await reloadUntil(page, "/review", async () => {
      await expect(item).toBeVisible({ timeout: 5_000 });
    });
    await item.click();

    const card = page.getByTestId("review-card");
    await expect(card).toHaveAttribute("data-item-type", "fingerprint_mismatch");

    const sides = page.getByTestId("fingerprint-sides");
    await expect(sides).toBeVisible();
    await expect(sides).toContainText("Mapping — what you confirmed");
    await expect(sides).toContainText("AcoustID — what the file sounds like");

    // And the three answers the item has always had, with the safe one preselected.
    await expect(page.getByTestId("review-option")).toHaveCount(3);
    await expect(
      page.getByTestId("review-option").filter({ has: page.getByText("preselected") }),
    ).toContainText("Keep the mapping I confirmed");
  });
});
