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

export const Route = createFileRoute("/_app/settings")({
  staticData: { crumbs: [{ label: "System" }, { label: "Settings" }] },
  component: Settings,
});

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
      <div className="grid gap-3.5 lg:grid-cols-[13.5rem_1fr]">
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
