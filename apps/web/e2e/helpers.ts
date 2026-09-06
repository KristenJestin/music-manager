/**
 * What every spec needs: a `test` that lands on hydrated pages, signing in, typing into a
 * Base UI field, and waiting for a job to stop moving.
 */
import { expect, test as base, type Locator, type Page } from "@playwright/test";

/**
 * The Console's `test`, whose `page` is never handed back mid-hydration.
 *
 * Every page here is server-rendered, so the markup — buttons, fields, the drawer — is on
 * screen and clickable a good while before React attaches to any of it. A click in that
 * window is not queued, it is *dropped*: the handler does not exist yet. The suite met this
 * three different ways, and each time it looked like a different bug —
 *
 *  - `api.spec.ts` typed a key name into a controlled Base UI input and the first render
 *    after hydration wrote `""` back over it (`toHaveValue` received `""`);
 *  - `shell.spec.ts` clicked *Open drawer* and the drawer never opened, because the `onClick`
 *    that flips the state was not attached yet (`aria-hidden` stayed `"true"`);
 *  - and anything that clicked a button which calls a server function simply waited out its
 *    timeout on a toast that was never going to come.
 *
 * None of those is a real defect and all of them are load-dependent, which is what made the
 * suite fail four tests on a busy machine and none on an idle one. So rather than sprinkling
 * a wait over the call sites that happened to be caught, the wait belongs to *navigation*:
 * after every `goto` and every `reload`, if the document contains the app shell, wait for the
 * attribute `AppShell` sets from inside the effect that attaches its listeners. Client-side
 * navigations need nothing — the shell stays mounted and hydrated across them.
 *
 * `/login` and `/setup` are outside the shell, so they are recognised and not waited for;
 * their fields are plain uncontrolled `<input>`s, which is why `fill()` is right there and
 * wrong everywhere else.
 */
export const test = base.extend({
  page: async ({ page }: { page: Page }, provide: (ready: Page) => Promise<void>) => {
    const goto = page.goto.bind(page);
    const reload = page.reload.bind(page);
    page.goto = async (url, options) => {
      const response = await goto(url, options);
      await hydrated(page);
      return response;
    };
    page.reload = async (options) => {
      const response = await reload(options);
      await hydrated(page);
      return response;
    };
    // Named `provide` rather than Playwright's usual `use`: the React lint rule reads a call to
    // `use(...)` as the React hook and refuses it outside a component.
    await provide(page);
  },
});

export { expect };

/** Wait for React, but only on the pages that have a shell to hydrate. */
async function hydrated(page: Page): Promise<void> {
  if ((await page.locator('[data-testid="app-shell"]').count()) === 0) return;
  await shellReady(page);
}

/** The administrator `scripts/e2e-web.ts` bootstraps. */
export const ADMIN = {
  email: process.env["MM_ADMIN_EMAIL"] ?? "e2e@music-manager.test",
  password: process.env["MM_ADMIN_PASSWORD"] ?? "e2e-password-01",
};

/**
 * Sign in, and land on the dashboard.
 *
 * A full page load rather than a client navigation: the cookie is set by Better Auth's own
 * response, and every loader above has already cached "there is no session".
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByTestId("login-email").fill(ADMIN.email);
  await page.getByTestId("login-password").fill(ADMIN.password);
  await page.getByTestId("login-submit").click();
  await page.waitForURL(/\/$/, { timeout: 60_000 });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  // The dashboard arrives through a full load, which the patched `goto` above did not make —
  // so the one navigation that escapes the fixture waits for hydration here instead.
  await shellReady(page);
}

/** Paste a URL into the wizard and wait for `resolve` to have produced its videos. */
export async function resolveSource(page: Page, url: string): Promise<string> {
  await page.goto(`/import/new?url=${encodeURIComponent(url)}`);
  await page.waitForURL(/importId=/, { timeout: 120_000 });
  await expect(page.getByTestId("source-count")).toBeVisible();
  const importId = new URL(page.url()).searchParams.get("importId");
  expect(importId, "the wizard should have created an import").toBeTruthy();
  return importId ?? "";
}

/**
 * Wait for the job page to show one of the terminal states.
 *
 * Polls the badge rather than the SSE stream on purpose: the stream is what the *page* uses,
 * and a test that waited on the same mechanism it is meant to be checking would pass even if
 * the page never rendered the result.
 */
export async function waitForStatus(
  page: Page,
  status: "Done" | "Failed" | "Needs review" | "Paused",
  timeout = 150_000,
): Promise<void> {
  await expect(page.getByText(status, { exact: true }).first()).toBeVisible({ timeout });
}

/**
 * Load a page again and again until an assertion about it holds.
 *
 * The Console's list pages are **loader-rendered, not live**: `/library`, `/tools` and the
 * rest fetch their rows once, when they are navigated to. Waiting on a locator inside one of
 * them therefore waits on a photograph — if the row was not there when the page loaded, no
 * amount of `toBeVisible({ timeout })` will make it appear, and the test spends its whole
 * budget looking at a document that cannot change.
 *
 * That is precisely how `library.spec.ts` failed a run: it opened `/library` five seconds
 * before the worker wrote the album row, then stared at the empty grid for two minutes. The
 * album was in the database the whole time. Re-navigating is what a person does, and it is
 * the only thing that can actually observe a change.
 *
 * Not a sleep: each attempt is a real assertion with a short budget, so it returns the moment
 * the page says what it should, and the failure it finally raises is the assertion's own.
 */
export async function reloadUntil(
  page: Page,
  path: string,
  check: () => Promise<void>,
  timeout = 120_000,
): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await check();
  }).toPass({ timeout, intervals: [500, 1000, 2000] });
}

/**
 * Wait until the shell is listening to the keyboard.
 *
 * The server-rendered HTML is on screen well before React attaches the shortcut handler, and a
 * key pressed in between is simply lost. `AppShell` sets `data-shortcuts` on `<html>` from
 * inside the very effect that adds the listener, so this waits on the listener itself rather
 * than on something that merely correlates with it.
 */
export async function shellReady(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-shortcuts", "on", { timeout: 60_000 });
}

/**
 * Press a key that the *window* listens for.
 *
 * `page.keyboard.press` dispatches to whatever the page considers focused, and after a
 * cross-document navigation that is not reliably anything at all — the key then goes nowhere
 * and the test waits sixty seconds for a navigation that was never asked for. Pressing through
 * an element puts the event in the DOM, where it bubbles to the window handler exactly as a
 * real keystroke does. (Verified by hand first: the shortcuts do work in a real browser.)
 */
export async function pressGlobal(page: Page, key: string): Promise<void> {
  await shellReady(page);
  await page.locator("body").press(key);
}

/**
 * Put text into a Console text field, the way a person does — **the only supported way**.
 *
 * Two distinct traps live here, and every spec that typed by hand met one of them.
 *
 * **`fill()` does not drive these inputs.** `components/ui/input.tsx` wraps Base UI's `Input`,
 * and setting `value` through the native setter — which is what `fill()` does — does not reach
 * React's `onChange`: the DOM shows the new text for an instant, the next render puts the old
 * value back, and the form state never changed. The symptom is a save that quietly writes what
 * was there before, or a button that stays disabled because the field it watches still reads
 * empty. Verified by hand in a real browser: typing and Delete both work, `fill()` does not.
 *
 * **And typing too early is thrown away.** Every Console page is server-rendered, so the field
 * is on screen — visible, focusable, and perfectly willing to accept keystrokes — a good while
 * before React attaches to it. A Base UI `Input` is *controlled*: the first render after
 * hydration writes the state value, `""`, back over whatever the keyboard put in the DOM. The
 * text is not merely late, it is gone, and the failure reads `toHaveValue("e2e-readonly")
 * received ""` on a field the trace clearly shows was typed into. That is the "input race"
 * P09 recorded, and it is why `api.spec.ts` failed a run out of three.
 *
 * So: wait for hydration first (`shellReady`, which watches the very effect that attaches the
 * shell's listeners), then type, then **re-type if the value did not stick**. The retry is not
 * a sleep in disguise — it re-does the whole gesture and asserts the outcome, so it costs
 * nothing when the first attempt worked and it names the field when nothing ever works.
 *
 * Select-all and type **over** the selection rather than deleting first: a numeric field
 * coerces its empty intermediate state to `0`, and the new digits would then land after it.
 */
export async function typeInto(field: Locator, text: string): Promise<void> {
  await shellReady(field.page());
  await expect(field).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    await field.click();
    await field.press("ControlOrMeta+a");
    if (text === "") await field.press("Delete");
    else await field.pressSequentially(text);
    await expect(field).toHaveValue(text, { timeout: 3_000 });
  }).toPass({ timeout: 60_000, intervals: [250, 500, 1000] });
}

/**
 * The mapping row for a video, by its title.
 *
 * By attribute, not by text: every row contains a `<select>` whose options list *all* the
 * release’s track titles, so `filter({ hasText })` matches every row on the page.
 */
export function mappingRow(page: Page, title: string) {
  return page.locator(`[data-testid="mapping-row"][data-video-title="${title}"]`);
}
