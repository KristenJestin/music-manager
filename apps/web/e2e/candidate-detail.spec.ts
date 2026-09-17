import { expect, test, resolveSource, signIn, typeInto } from "./helpers.ts";

/**
 * Step 2, driven against the one complaint under the owner's three: *"impossible for me to
 * know what to choose here."*
 *
 * A row gave a title, an artist, a year, a count of releases and a best track count, and two
 * pressings of one record agree on all five. Everything asserted here is a fact that was
 * already in the payload and was not on the card — plus the two links that let somebody go and
 * read the page themselves, and the search an artist's name alone now performs.
 *
 * All of it replays the Discovery cassette, which holds twenty-three pressings of one album:
 * the case the feature exists for, and not a synthetic pair.
 */

/** The release group Discovery belongs to, as MusicBrainz files it. */
const GROUP = "48117b90-a16e-34ca-a514-19c702df1158";
/** The 2001 French CD — what the matcher preselects on this cassette. */
const FRENCH_CD = "d073287b-d1bd-4f11-a933-a4386f8cf701";

test.describe("choosing a pressing on step 2", () => {
  test("links every candidate and its group to the right MusicBrainz page", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    /* ---- the group header ------------------------------------------------------------- */

    const group = page.locator(`[data-testid="candidate-group"][data-group-id="${GROUP}"]`);
    await expect(group).toBeVisible();
    await expect(group.getByTestId("group-mb-link")).toHaveAttribute(
      "href",
      `https://musicbrainz.org/release-group/${GROUP}`,
    );

    /* ---- the collapsed row of a card, without opening anything ------------------------- */

    const card = page.locator(`[data-candidate-id="${FRENCH_CD}"]`);
    await expect(card.getByTestId("candidate-mb-release")).toHaveAttribute(
      "href",
      `https://musicbrainz.org/release/${FRENCH_CD}`,
    );
    await expect(card.getByTestId("candidate-mb-group")).toHaveAttribute(
      "href",
      `https://musicbrainz.org/release-group/${GROUP}`,
    );
    // A reference you consult beside the Console, never a page you navigate away to.
    await expect(card.getByTestId("candidate-mb-release")).toHaveAttribute("target", "_blank");

    /* ---- and expanded, with the ids in full -------------------------------------------- */

    await card.getByTestId("why-toggle").click();
    const full = card.getByTestId("candidate-mb-release-full");
    await expect(full).toBeVisible();
    await expect(full).toHaveAttribute("href", `https://musicbrainz.org/release/${FRENCH_CD}`);
    await expect(full).toContainText(FRENCH_CD);
    await expect(card.getByTestId("candidate-mb-group-full")).toHaveAttribute(
      "href",
      `https://musicbrainz.org/release-group/${GROUP}`,
    );
  });

  /**
   * The facts, and the rule that decides which of them are on the row.
   *
   * Twenty-three pressings of Discovery differ on the catalogue number and agree on nothing
   * much else, so what this proves is the *mechanism*: a fact that is not the same on every
   * pressing is printed on every pressing, with its value, including the ones MusicBrainz has
   * no value for.
   */
  test("shows what tells two pressings apart, and the rest on expand", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    const card = page.locator(`[data-candidate-id="${FRENCH_CD}"]`);
    const row = card.getByTestId("candidate-facts");

    // The full date, not its year: a 2001-02-26 French CD and a 2001-03-12 British one are two
    // records to choose between and one number to look at.
    await expect(row).toContainText("2001-02-26");
    await expect(row).toContainText("FR");
    await expect(row).toContainText("14 tracks");
    // The catalogue number and the barcode are on the row *because* they differ inside this
    // group, and they are marked as the reason.
    await expect(row.locator('[data-fact="catalogue"][data-distinguishing="true"]')).toContainText(
      "8496062",
    );
    await expect(row.locator('[data-fact="barcode"][data-distinguishing="true"]')).toBeVisible();

    /* ---- the same fact, read off two cards, must differ -------------------------------- */

    const catalogues = await page
      .locator('[data-testid="candidate-facts"] [data-fact="catalogue"]')
      .allInnerTexts();
    expect(catalogues.length).toBeGreaterThan(1);
    expect(new Set(catalogues).size).toBeGreaterThan(1);
    // Including the pressings MusicBrainz has no catalogue number for: an omitted line is not
    // an answer to "how do these two differ?".
    expect(catalogues.some((text) => text.includes("no catalogue number"))).toBe(true);

    /* ---- and the whole sheet, one disclosure away -------------------------------------- */

    await expect(card.getByTestId("candidate-details")).toHaveAttribute("data-state", "closed");
    await card.getByTestId("details-toggle").click();
    const sheet = card.getByTestId("candidate-facts-table");
    await expect(card.getByTestId("candidate-details")).toHaveAttribute("data-state", "open");
    // The facts the compact row keeps off the card: packaging, status, the comment, the cover.
    await expect(sheet.locator('[data-fact="packaging"]')).toContainText("Jewel Case");
    await expect(sheet.locator('[data-fact="status"]')).toContainText("Official");
    await expect(sheet.locator('[data-fact="comment"]')).toBeVisible();
    await expect(sheet.locator('[data-fact="cover"]')).toBeVisible();
  });

  /**
   * The artist field, alone.
   *
   * It used to be inert: the button stayed disabled with the title box empty, so somebody who
   * knows the band and not the album title had nothing to type. The assertion is that the
   * search **adds rows** — the automatic match of this fixture finds one group, and listing
   * Daft Punk's records brings back a second the ranking never held.
   */
  test("searches an artist on its own, and says so", async ({ page }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://discovery");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    const groups = page.getByTestId("candidate-group");
    const before = await groups.count();
    expect(before).toBeGreaterThan(0);

    // Empty the title, leave the artist the wizard prefilled.
    await typeInto(page.getByTestId("mb-search"), "");
    await expect(page.getByTestId("mb-search-artist")).toHaveValue("Daft Punk");

    // The button says what it is about to do — "Search MusicBrainz" over an empty title field
    // does not say what it would search for.
    const submit = page.getByTestId("mb-search-submit");
    await expect(submit).toBeEnabled();
    await expect(submit).toContainText("List records by this artist");
    await expect(page.getByTestId("mb-search-artist-only")).toContainText(
      "Searching everything by “Daft Punk”",
    );

    await submit.click();

    // Rows, not an empty answer and not an error.
    await expect(groups).toHaveCount(before + 1, { timeout: 120_000 });
    await expect(page.getByTestId("mb-search-empty")).toHaveCount(0);
    await expect(
      page.locator(
        '[data-testid="candidate-group"][data-group-id="1ed45c8c-9abd-4ec3-9ff6-43d264f0e6b7"]',
      ),
    ).toBeVisible();
  });

  /**
   * The same question in a dropdown, which is where the owner met it worst.
   *
   * His screenshot is eighteen *Arcane: League of Legends* soundtrack variants with one
   * truncated title between them. Skinny Love is on twenty-five releases here, so the control
   * is the select rather than the list, and every option has to be distinguishable at a glance.
   */
  test("gives each of a single's twenty-odd borrow options the facts that tell it apart", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, "fixture://skinny-love");
    await page.goto(`/import/new?importId=${importId}&step=2`);
    await expect(page.getByTestId("candidate-list")).toBeVisible({ timeout: 150_000 });

    const borrow = page.getByTestId("borrow");
    await expect(borrow).toHaveAttribute("data-shape", "select");
    // The chosen release has a page of its own, outside the control: the option is a button,
    // and an anchor inside a button is invalid HTML.
    await expect(page.getByTestId("borrow-mb")).toHaveAttribute(
      "href",
      /^https:\/\/musicbrainz\.org\/release\//,
    );

    await page.getByTestId("borrow-select").click();
    const details = page.getByTestId("borrow-detail");
    await expect(details.first()).toBeVisible();
    const lines = await details.allInnerTexts();
    expect(lines.length).toBeGreaterThan(4);
    // Not twenty-five copies of one line: the barcode and the catalogue number are what these
    // pressings differ on, and they are printed.
    expect(new Set(lines).size).toBeGreaterThan(1);
  });
});
