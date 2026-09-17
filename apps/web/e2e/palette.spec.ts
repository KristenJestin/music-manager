import type { Locator, Page } from "@playwright/test";
import {
  expect,
  test,
  pasteIntoPage,
  pressGlobal,
  shellReady,
  signIn,
  typeInto,
} from "./helpers.ts";

/**
 * ⌘K, the Console's front door.
 *
 * The top bar used to be an input that accepted a YouTube URL and nothing else. It is a button
 * onto the palette now, and the palette decides what the typed string *is* before deciding what
 * to offer. Four things had to stay or become true, and each one is a test here:
 *
 *  - all three doors open the same palette — the button, `⌘K`, and `⌘V` anywhere on the page;
 *  - pasting a link is still **paste, Enter**. It must not have cost a gesture;
 *  - an artist's name reaches that artist's page in your library, locally, with no MusicBrainz;
 *  - a release id reaches an import *pinned* to that release, which is the wizard's own
 *    `options.releaseMbid` door and is asserted all the way to step 2.
 *
 * The keyboard is the subject throughout: nothing below clicks a row. Arrows move the
 * highlight, Enter takes it, and the footer is read to prove the highlight is where the test
 * thinks it is — a palette whose visible hint disagrees with what Enter does is the failure
 * this is written against.
 *
 * It runs after `import-album.spec.ts` by file order (the suite is serial, one worker), so the
 * album that spec places is the library this one searches.
 */

/** The fixture album's release, seeded into `source_cache` — `packages/domain/fixtures`. */
const DISCOVERY_RELEASE = "d073287b-d1bd-4f11-a933-a4386f8cf701";

/**
 * Walk the highlight down to a row with the arrow keys, and stop when it is there.
 *
 * Not a fixed number of presses: how many rows sit above a result depends on what the library
 * holds, which is exactly the thing a test must not assume. `aria-selected` is cmdk's own
 * record of the highlight, so this asserts the state the screen reader and the Enter key both
 * read rather than a position.
 */
async function highlight(page: Page, row: Locator): Promise<void> {
  const input = page.getByTestId("palette-input");
  await expect(row).toBeVisible({ timeout: 30_000 });
  for (let step = 0; step < 30; step += 1) {
    if ((await row.getAttribute("aria-selected")) === "true") return;
    await input.press("ArrowDown");
  }
  throw new Error("the highlight never reached that row after thirty ArrowDowns");
}

test.describe("the command palette", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("opens from the top bar, from ⌘K, and closes on Escape", async ({ page }) => {
    await shellReady(page);

    // The bar itself. It is a button and it says what it takes.
    await expect(page.getByTestId("open-palette")).toContainText("paste a link or an MBID");
    await page.getByTestId("open-palette").click();
    await expect(page.getByTestId("palette-input")).toBeVisible();
    await pressGlobal(page, "Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();

    // And the shortcut, from the same page, with no click in between.
    await pressGlobal(page, "ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toBeVisible();
    // The combobox wiring the palette has always had, still in place.
    const input = page.getByTestId("palette-input");
    await expect(input).toHaveAttribute("role", "combobox");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("listbox")).toBeVisible();
    await pressGlobal(page, "Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();
  });

  test("a pasted YouTube URL is one Enter from the import", async ({ page }) => {
    await page.goto("/imports");

    // ⌘V on a page that is not a form: the palette opens already holding the link.
    await pasteIntoPage(page, "fixture://discovery");

    // The first row is the import, it is already highlighted, and the footer says so. That is
    // the whole claim: paste, Enter — no click, no second field, no extra step.
    const row = page.getByTestId("palette-import");
    await expect(row).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("palette-hint")).toContainText("Resolve this URL");

    await page.getByTestId("palette-input").press("Enter");
    await page.waitForURL(/\/import\/new/, { timeout: 120_000 });
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 120_000 });
  });

  /**
   * A pasted link belongs to the paste, not to the palette.
   *
   * The clipboard's text is held in the shell so that `⌘V` can put it there before the palette
   * exists, and held state is state that can outlive its reason. `⌘K` clears it, so the
   * shortcut opens the empty box it promises rather than the link somebody pasted, looked at
   * and dismissed.
   */
  test("⌘K after a paste opens empty", async ({ page }) => {
    await page.goto("/");
    await pasteIntoPage(page, "fixture://discovery");
    await pressGlobal(page, "Escape");
    await expect(page.getByTestId("palette-input")).toBeHidden();

    await pressGlobal(page, "ControlOrMeta+k");
    await expect(page.getByTestId("palette-input")).toHaveValue("");
    await pressGlobal(page, "Escape");
  });

  test("an artist's name reaches that artist's page, without asking MusicBrainz", async ({
    page,
  }) => {
    await page.goto("/");
    await pressGlobal(page, "ControlOrMeta+k");
    await typeInto(page.getByTestId("palette-input"), "Daft Punk");

    /*
     * The library group is local SQL and arrives on a 150 ms debounce. MusicBrainz is offered
     * beside it and is *not* searched: the row says so, and that assertion is the one that
     * would fail the day somebody makes the free-text search automatic — which the shared
     * one-per-second gate cannot afford.
     */
    await expect(page.getByTestId("palette-mb-ask")).toContainText("Not searched yet");

    const artist = page.getByTestId("palette-artist").first();
    await highlight(page, artist);
    await expect(page.getByTestId("palette-hint")).toContainText("Daft Punk");
    await page.getByTestId("palette-input").press("Enter");

    await page.waitForURL(/\/library\/artists\//, { timeout: 60_000 });
    await expect(page.getByTestId("artist-name")).toHaveText("Daft Punk", { timeout: 60_000 });
  });

  test("an album in the library is reachable by its title", async ({ page }) => {
    await page.goto("/");
    await pressGlobal(page, "ControlOrMeta+k");
    await typeInto(page.getByTestId("palette-input"), "Discovery");

    const album = page.getByTestId("palette-album").first();
    await highlight(page, album);
    await page.getByTestId("palette-input").press("Enter");
    await page.waitForURL(/\/library\/albums\//, { timeout: 60_000 });
  });

  test("a pasted release id starts an import pinned to that release", async ({ page }) => {
    await page.goto("/");
    await pasteIntoPage(page, DISCOVERY_RELEASE);

    /*
     * The id is looked up **before** anything is offered — that is what `mb-resolve.ts` exists
     * for. The row names what the id turned out to be, and the footer says what Enter will do
     * with it, so "that is a release, not a recording" is never a refusal.
     */
    const reference = page.getByTestId("palette-reference");
    await expect(reference).toBeVisible({ timeout: 60_000 });
    await expect(reference).toContainText("Start an import pinned to this release");
    await expect(reference).toContainText("Discovery");
    await highlight(page, reference);
    await expect(page.getByTestId("palette-hint")).toContainText("tracklist");

    await page.getByTestId("palette-input").press("Enter");
    await page.waitForURL(new RegExp(`pin=${DISCOVERY_RELEASE}`), { timeout: 60_000 });

    // Step 1 with no source yet, and the pin visible rather than implied: the wizard's order
    // of events is reversed here, so the person has to be told what is already decided.
    await expect(page.getByTestId("wizard-pinned")).toContainText(DISCOVERY_RELEASE);

    // And it is a real pin, not a decoration: it goes onto the import as
    // `options.releaseMbid` at creation, and step 2 selects it.
    await typeInto(page.getByTestId("wizard-url"), "fixture://discovery");
    await page.getByTestId("wizard-resolve").click();
    await page.waitForURL(/importId=/, { timeout: 120_000 });
    await expect(page.getByTestId("source-count")).toBeVisible({ timeout: 120_000 });

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(new RegExp(`release=${DISCOVERY_RELEASE}`), { timeout: 150_000 });
  });
});
