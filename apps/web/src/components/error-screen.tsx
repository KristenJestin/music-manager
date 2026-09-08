/**
 * What a failed route looks like. Never a blank document.
 *
 * TanStack Router's default boundary replaces the whole tree — sidebar, top bar, breadcrumbs
 * and all — with a white panel reading *"Something went wrong!"* and the raw message. On
 * 2026-09-08 that is what a transient MusicBrainz 503 did to the Console in the middle of an
 * import: the wizard, the URL's meaning and every way out of the page went with it.
 *
 * The rule this component encodes is that **a source failing is a region of the page failing**
 * (decision 165). So:
 *
 *  - it renders *inside* the shell, because `_app.tsx` mounts it as the layout route's
 *    `errorComponent` and a child's error is caught by the nearest boundary above it — the
 *    layout, whose own `component` has already drawn the chrome;
 *  - it says the three things `MMError` carries and the default panel throws away: the code
 *    and status, the `hint`, and the `action`;
 *  - **Retry re-runs the loader** through `router.invalidate()` rather than reloading the
 *    document, so the URL, the history entry and the wizard's place in it survive;
 *  - it links to the journal, because the second question after "what broke" is always "what
 *    was it doing".
 */
import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { CircleAlert, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { failureLabel, readFailure } from "#/lib/errors.ts";

export interface ErrorScreenProps {
  readonly error: unknown;
  /** Overrides the failure's own message — the heading of the panel. */
  readonly title?: string;
  /** `false` on a boundary where retrying cannot help. Defaults to on. */
  readonly retryable?: boolean;
  readonly testId?: string;
}

export function ErrorScreen({
  error,
  title,
  retryable = true,
  testId = "error-screen",
}: ErrorScreenProps) {
  const router = useRouter();
  const failure = readFailure(error);
  const [busy, setBusy] = useState(false);

  const retry = (): void => {
    setBusy(true);
    /*
     * `invalidate`, not `window.location.reload()`. The loader is the thing that failed, so
     * the loader is the thing to run again; a document reload would also work and would cost
     * the client-side state of every *other* route in the tree, plus a round trip for a
     * bundle the browser already has. `finally` rather than `then`, because a second failure
     * re-renders this same component and the button has to come back either way.
     */
    void router.invalidate().finally(() => {
      setBusy(false);
    });
  };

  return (
    <section
      data-testid={testId}
      data-error-code={failure.code}
      className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface-1 px-6 py-8"
    >
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-danger" aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight" data-testid="error-title">
            {title ?? "This page could not be loaded"}
          </h1>
          <p className="mt-1 text-xs text-fg-2" data-testid="error-message">
            {failure.message}
          </p>
          <p className="mt-1 font-mono text-2xs text-fg-3" data-testid="error-code">
            {failureLabel(failure)}
          </p>
        </div>
      </div>

      {failure.hint === null ? null : (
        <Callout tone={failure.transient ? "warn" : "danger"} data-testid="error-hint" role="alert">
          {failure.hint}
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {retryable ? (
          <Button data-testid="error-retry" disabled={busy} onClick={retry}>
            <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} aria-hidden="true" />
            {failure.action ?? "Retry"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/tools" />}
          data-testid="error-journal"
        >
          <ScrollText className="size-4" aria-hidden="true" /> Open the journal
        </Button>
        <span className="text-2xs text-fg-3">
          {failure.transient
            ? "Nothing was lost: the address bar still holds where you were, and Retry re-runs only this page's data."
            : "Retry re-runs this page's data without leaving it."}
        </span>
      </div>
    </section>
  );
}

/**
 * The same panel for a route that does not exist, which is a different sentence and the same
 * shell. `_app.imports.$id.tsx` has thrown `notFound()` since P06 with nothing to catch it.
 */
export function NotFoundScreen() {
  return (
    <section
      data-testid="not-found-screen"
      className="flex flex-col gap-3.5 rounded-xl border border-line bg-surface-1 px-6 py-8"
    >
      <div className="flex items-start gap-3">
        <CircleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true" />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold tracking-tight">There is nothing at this address</h1>
          <p className="mt-1 text-xs text-fg-2">
            The import, album or track this URL names is not in the database. It may have been
            removed, or the link may be from another installation.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link to="/" />}
          data-testid="not-found-home"
        >
          Back to the dashboard
        </Button>
      </div>
    </section>
  );
}
