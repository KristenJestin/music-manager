/**
 * What every spec needs: signing in, and waiting for a job to stop moving.
 */
import { expect, type Locator, type Page } from "@playwright/test";

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
 * Put text into a Console text field, the way a person does.
 *
 * **`fill()` does not drive these inputs.** `components/ui/input.tsx` wraps Base UI's `Input`,
 * and setting `value` through the native setter — which is what `fill()` does — does not reach
 * React's `onChange`: the DOM shows the new text for an instant, the next render puts the old
 * value back, and the form state never changed. The symptom is a save that quietly writes what
 * was there before, or a button that stays disabled because the field it watches still reads
 * empty. Verified by hand in a real browser: typing and Delete both work, `fill()` does not.
 *
 * Select-all and type **over** the selection rather than deleting first: a numeric field
 * coerces its empty intermediate state to `0`, and the new digits would then land after it.
 */
export async function typeInto(field: Locator, text: string): Promise<void> {
  await field.click();
  await field.press("ControlOrMeta+a");
  if (text === "") await field.press("Delete");
  else await field.pressSequentially(text);
  await expect(field).toHaveValue(text);
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
