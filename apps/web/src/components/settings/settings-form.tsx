/**
 * The hydration gate in front of every Settings form.
 *
 * P06 learned this on `/login` and `/setup`: a server-rendered form is on screen and looks
 * usable well before React has attached anything to it, and what you type in that window is
 * thrown away by the first client render. Rare for a person on a fast machine, **reliable for
 * a test runner**, which types as fast as the DOM allows.
 *
 * The Settings pages reintroduced it, and it cost five E2E failures that all looked like
 * different bugs: a template preview that would not follow the field, a tag-map column that
 * would not switch, and — the nastiest — a save that reported "31 setting(s) saved" while
 * saving the values the loader had put there, because the typed one never reached React state.
 *
 * The fix is a `<fieldset disabled>`, not a disabled submit button. A disabled submit is
 * enough when the form is *submitted* (Playwright's `click()` waits for enabled); it is not
 * enough when the form is *filled*, because `fill()` waits for a control to be editable and a
 * control inside a disabled fieldset is not. So the whole form waits, every control at once,
 * with no per-field prop and no test-only affordance.
 *
 * `display: contents` keeps the fieldset out of the layout: it disables its descendants
 * without becoming a box of its own.
 */
import type { ReactNode } from "react";

export function SettingsForm({
  hydrated,
  testId,
  children,
}: {
  readonly hydrated: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <fieldset
      disabled={!hydrated}
      data-hydrated={hydrated ? "yes" : "no"}
      className="contents"
      aria-busy={!hydrated}
    >
      <div className="flex flex-col gap-3.5" data-testid={testId}>
        {children}
      </div>
    </fieldset>
  );
}
