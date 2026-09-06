import { Link, createFileRoute } from "@tanstack/react-router";
import { Activity, AlertTriangle, Disc3, FolderOpen, Inbox, Plus, Shield } from "lucide-react";
import { Callout } from "#/components/callout.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PipelineDots } from "#/components/pipeline-dots.tsx";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { ImportStatusBadge, ToneBadge } from "#/components/status-badge.tsx";
import { TimeAgo } from "#/components/time-ago.tsx";
import { Button } from "#/components/ui/button.tsx";
import { bytes, humanise, pct, timeAgo } from "#/lib/format.ts";
import { fetchDashboard } from "#/server/functions/dashboard.ts";

/**
 * `/` — the dashboard of `docs/phases/P06-web-coeur.md`.
 *
 * Six tiles, then the two things that need you (jobs in flight, decisions waiting) beside the
 * two things that tell you the machine is healthy (versions, the journal). The metadata
 * quality tile shows `—` until P07 computes completeness, and says so, rather than showing a
 * zero that would read as "every tag is missing".
 */
export const Route = createFileRoute("/_app/")({
  loader: async () => await fetchDashboard({ data: {} }),
  staticData: { crumbs: [{ label: "Dashboard" }] },
  component: Dashboard,
});

function Dashboard() {
  const { stats, active, review, system, activity } = Route.useLoaderData();
  const now = new Date();

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={
          <>
            {stats.inProgress} job{stats.inProgress === 1 ? "" : "s"} in flight · {stats.needsYou}{" "}
            decision{stats.needsYou === 1 ? "" : "s"} waiting · one download at a time
          </>
        }
        actions={
          <Button
            nativeButton={false}
            render={<Link to="/import/new" />}
            data-testid="dashboard-import"
          >
            <Plus className="size-4" aria-hidden="true" /> Import
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile
          label="Needs you"
          value={stats.needsYou}
          sub="decisions waiting"
          tone={stats.needsYou > 0 ? "warn" : "muted"}
          icon={<Inbox className="size-3.5" aria-hidden="true" />}
          to="/review"
        />
        <StatTile
          label="In progress"
          value={stats.inProgress}
          sub="queued or running"
          tone={stats.inProgress > 0 ? "info" : "muted"}
          icon={<Activity className="size-3.5" aria-hidden="true" />}
          to="/imports"
        />
        <StatTile
          label="Failed"
          value={stats.failed}
          sub={stats.failed === 0 ? "nothing broken" : "needs a look"}
          tone={stats.failed > 0 ? "danger" : "muted"}
          icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}
          to="/imports"
        />
        <StatTile
          label="Library"
          value={stats.albums}
          sub={`${String(stats.tracks)} tracks · ${String(stats.artists)} artists`}
          icon={<Disc3 className="size-3.5" aria-hidden="true" />}
          to="/library"
        />
        <StatTile
          label="Metadata quality"
          value={stats.metadataQuality === null ? "n/a" : pct(stats.metadataQuality)}
          sub="computed in P07"
          tone={stats.metadataQuality === null ? "muted" : "ok"}
          icon={<Shield className="size-3.5" aria-hidden="true" />}
        />
        <StatTile
          label="Storage"
          value={bytes(stats.storageBytes)}
          sub={stats.complete === null ? "no albums yet" : `${pct(stats.complete)} albums complete`}
          icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
        />
      </div>

      <div className="split-grid">
        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Active jobs</h2>
              <Button
                variant="ghost"
                size="sm"
                nativeButton={false}
                render={<Link to="/imports" />}
              >
                All jobs
              </Button>
            </header>
            <div className="flex flex-col">
              {active.length === 0 ? (
                <p className="px-3.5 py-8 text-center text-fg-2">
                  Nothing running. Paste a URL in the box above to start one.
                </p>
              ) : (
                active.map((entry) => (
                  <Link
                    key={entry.job.id}
                    to="/imports/$id"
                    params={{ id: entry.job.id }}
                    className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
                  >
                    <Cover
                      size="sm"
                      src={coverArtFront(entry.job.releaseMbid) ?? entry.thumbnail}
                      seed={entry.job.id}
                      label={entry.job.title ?? entry.job.url}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">
                        {entry.job.title ?? entry.job.url}
                        {entry.job.artist === null ? null : (
                          <span className="text-fg-2"> by {entry.job.artist}</span>
                        )}
                        <ToneBadge outline className="ml-2">
                          {entry.job.kind}
                        </ToneBadge>
                      </div>
                      <div className="text-xs text-fg-2">
                        {entry.tracksDone}/{entry.tracksTotal} tracks · step {entry.job.step}
                      </div>
                    </div>
                    <div className="w-36 shrink-0">
                      <PipelineDots step={entry.job.step} status={entry.job.status} />
                      <ProgressBar
                        className="mt-1.5"
                        value={entry.tracksTotal === 0 ? 0 : entry.tracksDone / entry.tracksTotal}
                        tone={entry.job.status === "awaiting_review" ? "warn" : "info"}
                      />
                    </div>
                    <ImportStatusBadge status={entry.job.status} />
                  </Link>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Review queue</h2>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/review" />}>
                Open
              </Button>
            </header>
            <div className="flex flex-col" data-testid="dashboard-review">
              {review.length === 0 ? (
                <p className="px-3.5 py-8 text-center text-fg-2">
                  Nothing to decide. The Inbox is empty.
                </p>
              ) : (
                review.map((item) => (
                  <Link
                    key={item.id}
                    to="/review/$id"
                    params={{ id: item.id }}
                    className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0 hover:bg-surface-2"
                  >
                    <Cover size="sm" seed={item.id} label={item.title} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{item.title}</div>
                      <div className="truncate text-xs text-fg-2">{item.summary ?? ""}</div>
                    </div>
                    <ToneBadge tone="warn">{humanise(item.type)}</ToneBadge>
                    <TimeAgo at={item.createdAt} now={now} className="text-2xs text-fg-3" />
                  </Link>
                ))
              )}
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">System</h2>
            </header>
            <div className="flex flex-col">
              {system.map((check) => (
                <div
                  key={check.name}
                  className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
                >
                  <span
                    aria-hidden="true"
                    className={
                      check.tone === "ok"
                        ? "size-2.5 rounded-full bg-ok"
                        : check.tone === "warn"
                          ? "size-2.5 rounded-full bg-warn"
                          : "size-2.5 rounded-full bg-danger"
                    }
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{check.name}</div>
                    <div className="truncate font-mono text-2xs text-fg-2">{check.detail}</div>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Activity</h2>
            </header>
            <div className="flex flex-col">
              {activity.length === 0 ? (
                <p className="px-3.5 py-6 text-center text-fg-2">Nothing yet.</p>
              ) : (
                activity.map((event) => (
                  <div
                    key={event.id}
                    className="border-b border-line px-3.5 py-2 last:border-b-0 text-xs"
                  >
                    <div className="truncate">{event.message}</div>
                    {/* A relative time inside a sentence: see components/time-ago.tsx. */}
                    <div suppressHydrationWarning className="text-2xs text-fg-3">
                      {event.step ?? event.type} · {timeAgo(event.at, now)}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <Callout tone="info">
            The library, quality and settings screens arrive in P07. Everything the importer needs
            is here.
          </Callout>
        </div>
      </div>
    </>
  );
}
