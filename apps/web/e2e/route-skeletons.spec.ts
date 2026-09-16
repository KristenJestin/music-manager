/**
 * Clicking a page shows *that page*, immediately, as its own shape.
 *
 * The behaviour this covers: TanStack Router leaves the previous screen on the glass until the
 * next route's loader resolves, and its stock `defaultPendingMs` is a full second — so on a
 * real library the Console answered a click by doing nothing visible for seconds. Every route
 * now declares a `pendingComponent`, and `router.tsx` cuts the threshold to 150 ms.
 *
 * The slowness is **manufactured here, not waited for**. Every one of these loaders calls a
 * server function, so holding `/_serverFn/*` for a second and a half makes any navigation slow
 * on demand, in the browser, with no test-only branch in the app and no dependence on how big
 * the fixture library happens to be. The assertions are then ordinary ones — the skeleton is
 * visible, then the content is — and never a race on a millisecond nobody controls.
 */
import type { Page } from "@playwright/test";
import { expect, signIn, test } from "./helpers.ts";

/** How long every server function is held. Comfortably past `defaultPendingMs` (150 ms). */
const DELAY_MS = 1_500;

/**
 * Make navigation slow, and hand back the switch that stops it.
 *
 * `route.continue()` rather than a canned body: the page must still get its real data, because
 * the second half of every assertion below is that the content arrives and replaces the
 * skeleton. Preloading (`defaultPreload: "intent"`) goes through the same handler, so a link
 * hovered on the way to being clicked is held too and cannot resolve the navigation early.
 */
async function slowLoaders(page: Page): Promise<() => Promise<void>> {
  await page.route("**/_serverFn/**", async (route) => {
    await new Promise((resolve) => {
      setTimeout(resolve, DELAY_MS);
    });
    await route.continue();
  });
  return async () => {
    await page.unroute("**/_serverFn/**");
  };
}

/** A sidebar entry. Scoped, because "Albums" and "Jobs" are also breadcrumbs. */
function navLink(page: Page, label: string) {
  return page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: label });
}

const skeleton = (page: Page) => page.getByTestId("page-skeleton");

test.describe("a slow page paints itself first", () => {
  test("the album grid's skeleton stands in for it, then the grid arrives", async ({ page }) => {
    await signIn(page);
    const fast = await slowLoaders(page);

    await navLink(page, "Albums").click();

    // The target page's own shape — and the page we left is gone, which is the whole point.
    await expect(skeleton(page)).toBeVisible();
    await expect(skeleton(page)).toHaveAttribute("data-skeleton", "library-albums");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toHaveCount(0);

    await fast();
    await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
    await expect(
      page.getByTestId("album-grid").or(page.getByTestId("library-empty")),
    ).toBeVisible();
    await expect(skeleton(page)).toHaveCount(0);
  });

  test("and so does every other page reached from the sidebar", async ({ page }) => {
    await signIn(page);
    const fast = await slowLoaders(page);

    for (const [label, name, heading] of [
      ["Tracks", /^library-tracks$/, "Tracks"],
      ["Jobs", /^jobs$/, "Jobs"],
      ["Quality", /^library-quality$/, "Metadata quality"],
      // `/settings` redirects to its first tab, so either the frame's skeleton or the tab's is
      // a correct answer — both are `settings*` and both keep the tab rail in place.
      ["Settings", /^settings/, "Settings"],
      ["Sources", /^sources$/, "Watched sources"],
      ["Tools", /^tools$/, "Tools & diagnostics"],
      ["Discover", /^discover$/, "Discover"],
      ["Review", /^review$/, "Review queue"],
      ["Artists", /^library-artists$/, "Artists"],
    ] as const) {
      await navLink(page, label).click();
      await expect(skeleton(page), `${label} should paint its own skeleton`).toHaveAttribute(
        "data-skeleton",
        name,
      );
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(skeleton(page)).toHaveCount(0);
    }

    await fast();
  });

  test("a settings tab replaces the form and leaves the rail alone", async ({ page }) => {
    await signIn(page);
    await page.goto("/settings/library");
    const fast = await slowLoaders(page);

    await page.getByTestId("settings-tab-metadata").click();

    // The child route is what goes pending, so the frame it is nested in stays on screen —
    // which is the difference between "this tab is loading" and "the app went away".
    await expect(skeleton(page)).toHaveAttribute("data-skeleton", "settings-metadata");
    await expect(page.getByTestId("settings-nav")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await fast();
    await expect(page.getByTestId("settings-metadata")).toBeVisible();
  });
});

test.describe("what the skeleton says, and to whom", () => {
  test("it announces itself once and hides the placeholders", async ({ page }) => {
    await signIn(page);
    const fast = await slowLoaders(page);

    await navLink(page, "Jobs").click();
    const region = skeleton(page);
    await expect(region).toBeVisible();

    // One polite announcement for the whole region…
    await expect(region).toHaveAttribute("role", "status");
    await expect(region).toHaveAttribute("aria-busy", "true");
    await expect(region.locator(".sr-only")).toHaveCount(1);
    await expect(region.locator(".sr-only")).toHaveText(/loading/i);

    // …and not one word from the dozens of grey cells under it.
    const placeholders = region.locator("> [aria-hidden='true'] [data-slot='skeleton']");
    expect(await placeholders.count()).toBeGreaterThan(10);

    await fast();
    await expect(page.getByTestId("jobs-table")).toBeVisible();
  });

  test("prefers-reduced-motion gets the tint without the shimmer", async ({ page }) => {
    await signIn(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const fast = await slowLoaders(page);

    await navLink(page, "Jobs").click();
    const block = skeleton(page).locator("[data-slot='skeleton']").first();
    await expect(block).toBeVisible();
    expect(
      await block.evaluate((node) => getComputedStyle(node).animationName),
      "a reader who asked for stillness must not get a pulsing page",
    ).toBe("none");

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await fast();
  });
});
