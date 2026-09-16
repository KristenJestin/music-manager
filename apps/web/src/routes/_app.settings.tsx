/**
 * `/settings` — the frame, and nothing else.
 *
 * A layout route with a tab strip and an `<Outlet/>`. Every knob lives in the child route
 * that owns it, which is what lets two phases fill this page at once without ever editing the
 * same file: the strip is a list (`components/settings/tabs.ts`), a tab is a route.
 */
import { createFileRoute, Link, Outlet, useRouter } from "@tanstack/react-router";
import { cn } from "cn";
import { PageHeader } from "#/components/page-header.tsx";
import { SETTINGS_TABS } from "#/components/settings/tabs.ts";
import {
  Skeleton,
  SkeletonPage,
  SkeletonPageHeader,
  SkeletonSettingsForm,
} from "#/components/skeleton.tsx";

export const Route = createFileRoute("/_app/settings")({
  staticData: { crumbs: [{ label: "System" }, { label: "Settings" }] },
  component: Settings,
  /*
   * This route has no loader, so it settles in a microtask and is essentially never the thing
   * being waited for: a click on a tab leaves the frame mounted and puts the tab's own
   * skeleton in the `<Outlet/>` below. It is declared for the one case that is not that —
   * the first arrival at Settings from elsewhere, where the route chunk itself is in flight.
   */
  pendingComponent: SettingsPending,
});

/** The frame: the title, the tab rail, and the form column beside it. */
function SettingsPending() {
  return (
    <SkeletonPage name="settings" label="Loading Settings…">
      <SkeletonPageHeader actions={0} />
      <div className="settings-grid">
        <nav className="flex flex-row flex-wrap gap-1 lg:flex-col">
          {SETTINGS_TABS.map((tab) => (
            <Skeleton key={tab.id} className="h-7 w-36 rounded-lg" />
          ))}
        </nav>
        <div className="min-w-0">
          <SkeletonSettingsForm rows={[4, 5, 4]} />
        </div>
      </div>
    </SkeletonPage>
  );
}

function Settings() {
  /*
   * Only the tabs whose route actually exists.
   *
   * The registry lists all four so that adding one is a single line, but P07a's two land in a
   * different commit from P07b's — and a tab strip with a link to a route that is not built
   * yet is a 404 waiting for the first person who clicks it.
   */
  const router = useRouter();
  const known = new Set(Object.keys(router.routesByPath));
  const tabs = SETTINGS_TABS.filter((tab) => known.has(tab.to));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Every knob of the pipeline, validated on the way in and read straight back by the services."
      />
      <div className="settings-grid">
        <nav className="flex flex-row flex-wrap gap-1 lg:flex-col" data-testid="settings-nav">
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              to={tab.to}
              title={tab.hint}
              data-testid={`settings-tab-${tab.id}`}
              className={cn(
                "rounded-lg border border-transparent px-2.5 py-1.5 text-xs text-fg-1 hover:bg-surface-2",
              )}
              activeProps={{
                className: "border-line bg-surface-2 text-primary",
              }}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </>
  );
}
