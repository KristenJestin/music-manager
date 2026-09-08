/**
 * The incident of 2026-09-08, as a test that would have caught it.
 *
 * What the owner saw: an import in the wizard, MusicBrainz answering 503 for a second, and the
 * **entire Console** replaced by TanStack Router's default panel — *"Something went wrong!
 * musicbrainz answered HTTP 503."* No sidebar, no breadcrumb, no way back, and a URL whose
 * meaning had just been thrown away. Nothing in the app was broken; a transient refusal from a
 * metadata service had been allowed to become a fatal render error.
 *
 * Three claims, in the order they matter (decision 165):
 *
 *  1. a source outage keeps the wizard on screen, with a Retry that works;
 *  2. an outage the cache can cover degrades to cached candidates instead of an empty screen;
 *  3. an error that is *not* a source outage still reaches a boundary, and that boundary is
 *     inside the shell — which is the general property, of which (1) is the special case.
 *
 * The 503 is produced offline. `fixture://discovery?mb=503` is the same convention as the
 * toolbox's own `fixture://discovery?fp=mismatch`: the recorded scenario carries the fault, so
 * there is no stub server, no network and no mock inside the app — the error that reaches the
 * page is the one `integrations/http.ts` builds for a real 503.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { expect, test, resolveSource, signIn } from "./helpers.ts";

/**
 * Where the evidence goes: `orchestration/reports/mb503/`, outside the repository.
 *
 * `CLAUDE.md` keeps everything that is not code, tests, configuration or operations
 * documentation out of `v2/`, so the screenshots this file takes are written next to the
 * report that cites them — the same arrangement `wizard-feedback.spec.ts` uses.
 */
const SHOTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../orchestration/reports/mb503",
);

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

/** The wizard URL for one outage, with a marker so each test arms an outage of its own. */
function outageUrl(marker: string, times = 1): string {
  return `fixture://discovery?mb=503&mbtimes=${String(times)}&case=${marker}`;
}

test.describe("a MusicBrainz outage never blanks the Console", () => {
  test("step 2 stays on screen when MusicBrainz refuses, and Retry brings it back", async ({
    page,
  }) => {
    await signIn(page);
    // Two refusals: enough to defeat the live ranking *and* the cached second attempt, which
    // is the only way to reach the "unavailable" screen rather than the degraded one.
    const importId = await resolveSource(page, outageUrl("unavailable", 2));

    await page.getByTestId("wizard-next").click();
    await page.waitForURL(/step=2/, { timeout: 120_000 });

    // 1. The shell survived. This is the whole point: the default boundary replaces it.
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText("Something went wrong!")).toHaveCount(0);
    await expect(page.getByTestId("wizard")).toBeVisible();

    // 2. The step says what happened, with the status, and offers Retry.
    const banner = page.getByTestId("mb-unavailable");
    await expect(banner).toBeVisible({ timeout: 120_000 });
    // The status is asserted through the sentence a reader actually sees, not a data attribute:
    // `Callout` is a shared component and does not spread unknown props onto its element.
    await expect(page.getByTestId("mb-unavailable-label")).toHaveText(
      "MusicBrainz is unavailable (HTTP 503)",
    );
    await expect(banner).toContainText("musicbrainz answered HTTP 503");
    // The escape hatch is still reachable without leaving the page.
    await expect(page.getByTestId("import-without-mb")).toBeVisible();
    await shot(page, "01-step2-unavailable");

    // 3. The URL — and therefore the user's place in the wizard — is untouched.
    expect(page.url()).toContain(`importId=${importId}`);
    expect(page.url()).toContain("step=2");

    // 4. Retry re-runs the loader in place. The outage is spent, so the candidates arrive.
    await page.getByTestId("mb-retry").click();
    await expect(page.getByTestId("preselection")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("mb-unavailable")).toHaveCount(0);
    await expect(page.getByTestId("candidate-list")).toBeVisible();
    expect(page.url()).toContain(`importId=${importId}`);
    await shot(page, "02-step2-after-retry");
  });

  test("a single refusal degrades to the cached candidates rather than to nothing", async ({
    page,
  }) => {
    await signIn(page);
    const importId = await resolveSource(page, outageUrl("degraded", 1));

    /*
     * Straight to a step 2 that already names its release, rather than clicking through.
     *
     * With `release` absent the loader redirects to the preselected one as soon as the ranking
     * succeeds, and that redirect re-runs the loader — by which time the single refusal has
     * been spent and there is nothing degraded left to look at. Naming the release is what the
     * redirect would have produced anyway, and it makes the screen a pure function of the URL,
     * which is the wizard's own rule.
     */
    await page.goto(
      `/import/new?importId=${importId}&step=2&release=d073287b-d1bd-4f11-a933-a4386f8cf701`,
    );

    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 120_000 });
    // The list is there, and it says where it came from.
    await expect(page.getByTestId("mb-degraded")).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId("candidate-list")).toBeVisible();
    await expect(page.getByTestId("preselection")).toBeVisible();
    await shot(page, "03-step2-degraded-from-cache");
  });

  test("an error that is not an outage renders in the shell, not over it", async ({ page }) => {
    await signIn(page);

    /*
     * A well-formed URL naming an import that does not exist: a genuine failure of the loader,
     * which must reach a boundary rather than be swallowed into a banner.
     *
     * A full page load, deliberately, because that is the harsher of the two paths. The router
     * inlines a rejected loader's error into the HTML as its **message alone** — `mm`, `name`
     * and every other property are gone by the time the boundary re-renders on the client — so
     * what is asserted here is what genuinely survives: the shell, the sentence, and the two
     * ways out. The code is only claimed where it is really available, which is the reason the
     * wizard carries its outage in loader *data* rather than reading a rejection.
     */
    await page.goto("/import/new?importId=00000000-0000-4000-8000-000000000000&step=1");

    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Something went wrong!")).toHaveCount(0);

    const screen = page.getByTestId("error-screen");
    await expect(screen).toBeVisible();
    await expect(page.getByTestId("error-message")).toHaveText(
      "No import with id 00000000-0000-4000-8000-000000000000.",
    );
    await expect(page.getByTestId("error-retry")).toBeVisible();
    await expect(page.getByTestId("error-journal")).toBeVisible();
    await shot(page, "04-error-boundary-in-shell");
  });

  test("an address with nothing behind it lands in the shell too", async ({ page }) => {
    await signIn(page);
    await page.goto("/imports/00000000-0000-4000-8000-000000000000");

    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("not-found-screen")).toBeVisible();
    await expect(page.getByText("Something went wrong!")).toHaveCount(0);
    await shot(page, "05-not-found-in-shell");
  });
});
