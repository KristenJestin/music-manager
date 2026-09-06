import { Outlet, createFileRoute, redirect, useMatches } from "@tanstack/react-router";
import { AppShell } from "#/components/shell/app-shell.tsx";
import { ShellProvider } from "#/components/shell/shell-context.tsx";
import type { Crumb } from "#/components/shell/topbar.tsx";
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
});

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
