import {
  expect,
  test,
  mappingRow,
  pressGlobal,
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
});
