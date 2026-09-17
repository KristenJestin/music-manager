import { expect, test, resolveSource, signIn, typeInto } from "./helpers.ts";

/**
 * Step 2's box, driven the way the owner drove it.
 *
 * Four of his five complaints are observable here without a network: the box says what an id
 * *is* before anything is pressed, the result lands at the top of the list rather than under
 * four irrelevant candidates, nonsense is refused in words, and an empty search reads back what
 * it searched for instead of "Nothing found for that".
 *
 * The fifth — a pasted **release** id on a single, which is the id he actually had — needs a
 * release document this cassette does not hold, so its dispatch is proved in
 * `server/services/mb-resolve.test.ts` where the lookups can be supplied. Everything asserted
 * here goes through the page.
 */

/** A recording on the Skinny Love cassette, so pasting it is answered offline. */
const RECORDING = "5463ed3a-5fc1-49b6-8260-3b5bb36ee047";
/** A release on the Discovery cassette — the Japanese pressing. */
const RELEASE = "51467269-3122-3d7e-92b2-0f0a694d30c1";

test.describe("the wizard's MusicBrainz box", () => {
  test("names a pasted recording before any button is pressed, and puts it on top when chosen", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://skinny-love");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    /* ---- the two fields, prefilled, and the copy that no longer promises one entity --- */

    await expect(page.getByTestId("mb-search")).toBeVisible();
    await expect(page.getByTestId("mb-search-artist")).toBeVisible();

    /* ---- resolve as you paste: no button, and it says what it found ------------------- */

    await typeInto(page.getByTestId("mb-search"), RECORDING);
    const preview = page.getByTestId("mb-search-preview");
    await expect(preview).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("mb-search-entity")).toHaveText("recording");
    await expect(page.getByTestId("mb-search-title")).toContainText("Skinny Love");
    // The artist field is out of the way while the box holds an id: an id names one thing.
    await expect(page.getByTestId("mb-search-artist")).toHaveCount(0);

    /* ---- and the button says what pressing it will do --------------------------------- */

    const submit = page.getByTestId("mb-search-submit");
    await expect(submit).toContainText("Use this recording");
    await submit.click();

    /* ---- the result is the first card, selected, and marked as chosen by hand --------- */

    const first = page.getByTestId("candidate").first();
    await expect(first).toHaveAttribute("data-candidate-id", RECORDING, { timeout: 60_000 });
    await expect(first).toHaveAttribute("data-selected", "true");
    await expect(first).toHaveAttribute("data-by-hand", "true");
    await expect(first.getByTestId("candidate-by-hand")).toContainText("chosen by id");
    // Said out loud too, for the reader who is not watching the list move.
    await expect(page.getByTestId("candidate-live")).toContainText("top of the list");
  });

  test("names what a pasted id is when this app cannot use it, rather than calling it wrong", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://skinny-love");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    // A well-formed id nothing knows. The refusal says the id is unknown — never "no recording
    // with id X", which is what it used to say about a perfectly good release.
    await typeInto(page.getByTestId("mb-search"), "00000000-0000-4000-8000-000000000000");
    const unknown = page.getByTestId("mb-search-unknown");
    await expect(unknown).toBeVisible({ timeout: 60_000 });
    await expect(unknown).toContainText("MusicBrainz does not know");
    await expect(page.getByTestId("mb-search-submit")).toBeDisabled();
  });

  test("reads the artist off a dash, and an empty answer says what it searched for", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://skinny-love");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    // Free text with a separator: the artist goes in its own clause instead of being folded
    // into the title, which is what made `bewitched Laufey` match nothing.
    await typeInto(page.getByTestId("mb-search"), "Nobody At All - Nothing Like This");
    await page.getByTestId("mb-search-submit").click();

    const empty = page.getByTestId("mb-search-empty");
    await expect(empty).toBeVisible({ timeout: 120_000 });
    // The sentence that would have explained his bug instantly.
    await expect(empty).toContainText("“Nothing Like This” by “Nobody At All”");
  });

  test("resolves a pasted release on an album import as a pin", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    await typeInto(page.getByTestId("mb-search"), `https://musicbrainz.org/release/${RELEASE}`);
    await expect(page.getByTestId("mb-search-entity")).toHaveText("release", { timeout: 60_000 });
    await expect(page.getByTestId("mb-search-title")).toContainText("Discovery");
    await expect(page.getByTestId("mb-search-submit")).toContainText("Pin this release");

    await page.getByTestId("mb-search-submit").click();
    // The group holding it opens and comes first; the release inside wears the flag.
    const chosen = page.locator(`[data-candidate-id="${RELEASE}"]`);
    await expect(chosen).toBeVisible({ timeout: 120_000 });
    await expect(chosen).toHaveAttribute("data-by-hand", "true");
  });
});
