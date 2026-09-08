import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { AppShell } from "#/components/shell/app-shell.tsx";
import { ShellProvider } from "#/components/shell/shell-context.tsx";
import type { Crumb } from "#/components/shell/topbar.tsx";
import { ErrorScreen } from "#/components/error-screen.tsx";
import { fetchShell } from "#/server/functions/dashboard.ts";
import { currentSession, setupState } from "#/server/functions/session.ts";

/**
 * The Console shell, and the gate in front of it.
 *
 * A pathless layout route: every page of the app is a child of this one, so the session check
 * and the chrome are declared once. `beforeLoad` rather than `loader` on purpose — it runs on
 * client-side navigation too, so a session that expires while a tab is open sends the next
 * click to `/login` rather than to a page full of failed requests.
 *
 * Breadcrumbs are collected from the matched routes' `staticData`, so a page says what it is
 * called next to its component rather than in a table somewhere else.
 *
 * It carries **one of the three error boundaries** of decision 165, and specifically the one a
 * child route cannot provide: the failure of *this* loader. `errorComponent` is per route in
 * TanStack Router — a route without one falls back to `router.tsx`'s `defaultErrorComponent`,
 * not to its parent's — so the general net lives there, and what is left here is the case
 * where `fetchShell` is what broke and there is no shell data to draw the chrome from.
 */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ location }) => {
    const session = await currentSession();
    if (session === null) {
      if ((await setupState()).needsSetup) throw redirect({ to: "/setup" });
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }
    return { session };
  },
  loader: async () => ({ shell: await fetchShell() }),
  component: AppLayout,
  errorComponent: AppError,
  /*
   * No `notFoundComponent` here, and that is the result of trying it both ways.
   *
   * `notFound()` does not behave like an error. An error is caught by the failing route's own
   * boundary; `notFound()` **bubbles** to the nearest ancestor that *declares* a
   * `notFoundComponent` (`defaultNotFoundComponent` does not stop it) and then renders **in
   * place of that route's own component**. Declared here, a missing import therefore replaced
   * the shell — sidebar, top bar and all — which is the shape of the bug this change exists to
   * remove; declared on `__root`, it replaced the whole page. So it belongs on the leaf that
   * throws it, `_app.imports.$id.tsx`, where it lands inside the chrome. Measured in
   * `e2e/mb-outage.spec.ts`, twice, rather than reasoned about.
   */
});

/**
 * A child route's failure, drawn inside the chrome.
 *
 * `Route.useLoaderData()` is not available here — this boundary also catches a failure of
 * *its own* loader, when `fetchShell` is what broke — so the shell is rendered from nothing.
 * `ShellProvider` takes the same `null` it takes before the first fetch resolves, which keeps
 * the sidebar and the top bar navigable while the counters are simply absent.
 */
function AppError({ error }: { readonly error: unknown }) {
  return (
    <ShellProvider initial={null}>
      <AppShell crumbs={[{ label: "Music Manager" }]}>
        <ErrorScreen error={error} />
      </AppShell>
    </ShellProvider>
  );
}

/** What a page contributes to the breadcrumb trail. */
export interface RouteCrumbs {
  readonly crumbs?: readonly Crumb[];
}

function AppLayout() {
  const { shell } = Route.useLoaderData();
  const matches = useMatches();
  const crumbs = matches.flatMap(
    (match) => (match.staticData as RouteCrumbs | undefined)?.crumbs ?? [],
  );

  return (
    <ShellProvider initial={shell}>
      <AppShell crumbs={crumbs.length === 0 ? [{ label: "Music Manager" }] : crumbs}>
        <Outlet />
      </AppShell>
    </ShellProvider>
  );
}
