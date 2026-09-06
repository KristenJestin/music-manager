/**
 * Has this component been hydrated?
 *
 * A server-rendered form is on screen and looks usable before React has attached anything to
 * it. Click its button in that window and one of two things happens, both bad: nothing at all,
 * or a native form submit that reloads the page and throws the typed values away. It is a real
 * race for a person on a slow connection, and a reliable one for a test runner, which clicks
 * as fast as the DOM allows.
 *
 * So the forms disable their submit button until this returns true. Playwright's `click()`
 * waits for a control to be enabled, which means the test waits for hydration without knowing
 * that hydration is what it is waiting for — no sleep, no marker, no test-only affordance.
 *
 * `useSyncExternalStore` rather than an effect: it is the one hook whose whole purpose is
 * "return one value on the server and another on the client", and it does so without a
 * render-then-correct flash and without a `setState` inside an effect.
 */
import { useSyncExternalStore } from "react";

/** Nothing ever changes, so the subscribe callback has nothing to do. */
const subscribe = (): (() => void) => () => undefined;

export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
