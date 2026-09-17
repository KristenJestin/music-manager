import { useEffect, useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { Layers, Plus, RotateCcw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { FilterToolbar } from "#/components/library/filter-toolbar.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { Pager } from "#/components/pager.tsx";
import { PipelineDots } from "#/components/pipeline-dots.tsx";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { RetryMenu } from "#/components/retry-menu.tsx";
import { ImportStatusBadge, ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { cn } from "cn";
import { TimeAgo } from "#/components/time-ago.tsx";
import { SkeletonPage, SkeletonPageHeader, SkeletonTable } from "#/components/skeleton.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { useJobsProgress, type StreamState } from "#/hooks/use-jobs-progress.ts";
import { timeAgo } from "#/lib/format.ts";
import {
  bumpJob,
  collapseParkedImports,
  fetchJobs,
  retryFailedUpstream,
  retryJob,
} from "#/server/functions/jobs.ts";
import type { JobSummary } from "#/server/services/console.queries.ts";

const search = z.object({
  status: z
    .enum([
      "all",
      "active",
      "pending",
      "running",
      "awaiting_confirm",
      "awaiting_review",
      "paused",
      "waiting_upstream",
      "done",
      "failed",
      "cancelled",
    ])
    /*
     * **Active, not All.**
     *
     * The owner's instance holds 388 imports of which 275 are cancelled, so "All" is a page of
     * abandoned rows with the forty-six that are actually working buried underneath — the list
     * was unusable at exactly the size that makes a list worth having. The default is what is
     * alive; "All" and "Cancelled" are one chip away and the chips carry the real totals, so
     * nothing is hidden, it is merely no longer first.
     */
    .default("active"),
  /** Zero-based, in the URL: a reload and a shared link land on the same page. */
  page: z.number().int().min(0).default(0),
});

/**
 * `/imports` — every import is a job, and one track downloads at a time.
 *
 * The filter and the page live in the URL rather than in component state, so "the failed ones,
 * page 2" is a link you can send someone, and so the dashboard's Failed tile can point
 * straight at it.
 *
 * The rows arrive from the loader, ordered by liveness then by recency (`listJobs`), and are
 * then kept moving by `useJobsProgress` without the loader running again: re-sorting the table
 * under someone who is reading it is worse than a number that is half a second old.
 */
export const Route = createFileRoute("/_app/imports/")({
  validateSearch: search,
  loaderDeps: ({ search: { status, page } }) => ({ status, page }),
  loader: async ({ deps }) => await fetchJobs({ data: { status: deps.status, page: deps.page } }),
  staticData: { crumbs: [{ label: "Jobs" }] },
  component: Jobs,
  pendingComponent: JobsPending,
});

/**
 * The Jobs table while `fetchJobs` runs: seven chips, then cover, import, kind, pipeline,
 * progress, status, updated — and the pager, which is part of the bordered card and would
 * otherwise appear from nowhere under the last row.
 */
function JobsPending() {
  return (
    <SkeletonPage name="jobs" label="Loading the jobs table…">
      <SkeletonPageHeader actions={2} />
      {/* The chips are links built from `?status=`, so they render for real; only the totals
          on them are the loader's, and those come in as a dash. */}
      <JobsToolbar counts={null} />
      <SkeletonTable
        pager
        rows={10}
        columns={[{ cover: "sm" }, "w-1/3", "w-12", "w-24", "w-48", "w-20", "w-16"]}
      />
    </SkeletonPage>
  );
}

const FILTERS = [
  // Active first, because it is the default and because it is the question being asked.
  ["active", "Active"],
  ["all", "All"],
  ["awaiting_review", "Needs review"],
  // A source refusing us is a state of its own, and it gets a chip of its own: during an
  // outage the owner's question is "how many are waiting", and the answer used to be
  // indistinguishable from "how many are broken".
  ["waiting_upstream", "Waiting on source"],
  ["failed", "Failed"],
  ["done", "Done"],
  // 275 rows had no chip of their own and could only be reached by scrolling past them.
  ["cancelled", "Cancelled"],
] as const;

type JobFilter = (typeof FILTERS)[number][0];

/**
 * The seven status presets, from `?status=` alone.
 *
 * The counts are the *unfiltered* totals — 388 imports, 70 of them active — so the chips
 * describe the whole table and not the page being looked at. Every chip resets the page:
 * "Failed, page 6" of a set with two pages is an empty table and a puzzled owner.
 */
function JobsToolbar({ counts }: { readonly counts: Record<JobFilter, number> | null }) {
  const { status } = Route.useSearch();
  return (
    <FilterToolbar
      presets={{
        chips: FILTERS.map(([value, label]) => ({
          value,
          label,
          count: counts?.[value] ?? null,
        })),
        active: status,
        testId: "job-filters",
        link: (value) => ({ to: "/imports", search: { status: value, page: 0 } }),
      }}
    />
  );
}

function Jobs() {
  const { jobs, counts, total, page, pageSize, parkedDuplicates } = Route.useLoaderData();
  const { status } = Route.useSearch();
  const router = useRouter();
  const toast = useToast();
  const now = new Date();

  const hydrated = useHydrated();
  const live = useJobsProgress({ ids: jobs.map((entry) => entry.job.id), enabled: hydrated });

  /** A row as it stands now: the loader's copy, with anything the stream has since learned. */
  const shown = (
    entry: JobSummary,
  ): {
    status: JobSummary["job"]["status"];
    done: number;
    total: number;
    at: Date | string;
  } => {
    const fresh = live.rows.get(entry.job.id);
    return {
      status: fresh?.status ?? entry.job.status,
      done: fresh?.tracksDone ?? entry.tracksDone,
      total: fresh?.tracksTotal ?? entry.tracksTotal,
      at: fresh?.updatedAt ?? entry.job.updatedAt,
    };
  };

  const go = (next: number): void => {
    void router.navigate({ to: "/imports", search: { status, page: next } });
  };

  const act = (run: () => Promise<unknown>, message: string): void => {
    void run().then(
      () => {
        toast(message, "ok");
        void router.invalidate();
      },
      (error: unknown) => {
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  const columns: Column<JobSummary>[] = [
    {
      key: "cover",
      header: "",
      className: "w-10",
      cell: (entry) => (
        // The archive front once a release is bound, the YouTube thumbnail before that, and
        // the gradient only when neither exists or loads (owner review B10).
        <Cover
          size="sm"
          src={coverArtFront(entry.job.releaseMbid) ?? entry.thumbnail}
          seed={entry.job.id}
          label={entry.job.title ?? entry.job.url}
        />
      ),
    },
    {
      key: "import",
      header: "Import",
      cell: (entry) =>
        entry.job.title === null ? (
          /*
           * An import that never resolved has no title and no artist, and printing "unknown
           * artist" under a raw playlist URL spent two lines saying nothing twice. One line,
           * the URL in mono because that is all we ever learned about it, and the id beside
           * it — the cancelled rows are then a dense block rather than the bulk of the page.
           */
          <div className="min-w-0 truncate">
            <span className="font-mono text-2xs text-fg-2">{entry.job.url}</span>
            <span className="ml-2 font-mono text-2xs text-fg-3">{entry.job.id}</span>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="truncate font-medium">{entry.job.title}</div>
            <div className="truncate text-2xs text-fg-2">
              {entry.job.artist ?? "unknown artist"} ·{" "}
              <span className="font-mono">{entry.job.id}</span>
            </div>
          </div>
        ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (entry) => <ToneBadge outline>{entry.job.kind}</ToneBadge>,
    },
    {
      key: "pipeline",
      header: "Pipeline",
      cell: (entry) => (
        <PipelineDots steps={entry.steps} headStep={entry.job.step} status={shown(entry).status} />
      ),
    },
    {
      key: "progress",
      header: "Progress",
      className: "w-48",
      cell: (entry) => {
        const row = shown(entry);
        return (
          <div className="flex items-center gap-2" data-testid="job-progress">
            <ProgressBar
              className="flex-1"
              value={row.total === 0 ? 0 : row.done / row.total}
              tone={
                row.status === "failed"
                  ? "danger"
                  : row.status === "done"
                    ? "ok"
                    : row.status === "awaiting_review"
                      ? "warn"
                      : "info"
              }
            />
            <span className="font-mono text-2xs text-fg-2">
              {row.done}/{row.total}
            </span>
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      cell: (entry) => <ImportStatusBadge status={shown(entry).status} />,
    },
    {
      key: "updated",
      header: "Updated",
      cell: (entry) => <TimeAgo at={shown(entry).at} now={now} className="text-fg-2" />,
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (entry) => (
        <div className="flex justify-end gap-1.5">
          {/* The same menu as the job page, and deliberately so: a person who learned that the
              chevron is where "Match again" lives must not have to open a row to find it. It
              stops the click itself, so pressing it does not also navigate into the row. */}
          {entry.job.status === "failed" ? (
            <RetryMenu
              job={entry.job}
              size="xs"
              onRetry={(step) => {
                act(
                  async () =>
                    await retryJob({
                      data: { id: entry.job.id, ...(step === undefined ? {} : { step }) },
                    }),
                  step === undefined ? "Retrying the job." : `Retrying from ${step}.`,
                );
              }}
            />
          ) : null}
          {entry.openItems > 0 ? (
            <Button
              size="xs"
              render={
                <Link
                  to="/review"
                  onClick={(event) => {
                    event.stopPropagation();
                  }}
                />
              }
            >
              Review
            </Button>
          ) : null}
          {entry.job.status === "pending" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                act(
                  async () => await bumpJob({ data: { id: entry.job.id, by: 10 } }),
                  "Moved up the queue.",
                );
              }}
            >
              Bump
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Jobs"
        description="Every import is a job; one track downloads at a time."
        actions={
          <>
            <LiveStatus stream={live.stream} checkedAt={live.checkedAt} />
            {counts.failed > 0 ? (
              // Shown only when there is something to sweep. One press answers an outage that
              // would otherwise be forty-five presses of the per-row Retry beside it, and the
              // rule behind it refuses to pick up a 404 on the way past.
              <Button
                variant="outline"
                data-testid="retry-failed-upstream"
                onClick={() => {
                  act(async () => {
                    const done = await retryFailedUpstream();
                    if (done.requeued === 0) {
                      throw new Error("No import failed on a source; nothing to requeue.");
                    }
                    return done;
                  }, "Requeued the imports a source had refused.");
                }}
              >
                <RotateCcw className="size-4" aria-hidden="true" /> Retry source failures
              </Button>
            ) : null}
            {parkedDuplicates > 0 ? (
              /*
               * The owner's instance held 204 imports parked at "Waiting for the import
               * wizard" for seven URLs, 80 of them for one album, because every visit to the
               * wizard opened a new one. The wizard no longer does that; this is the broom for
               * the rows that are already there. It keeps the newest import of each URL and
               * never touches one whose tracks have done any work.
               */
              <Button
                variant="outline"
                data-testid="collapse-parked"
                onClick={() => {
                  act(
                    async () => {
                      const done = await collapseParkedImports({ data: { apply: true } });
                      if (done.cancelled === 0) {
                        throw new Error("Nothing to collapse: every URL already has one import.");
                      }
                      return done;
                    },
                    `Cancelled ${String(parkedDuplicates)} redundant parked import(s).`,
                  );
                }}
              >
                <Layers className="size-4" aria-hidden="true" /> Collapse {parkedDuplicates}{" "}
                duplicate
                {parkedDuplicates === 1 ? "" : "s"}
              </Button>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                live.refresh();
                void router.invalidate();
                toast("Refreshed.");
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Refresh
            </Button>
            <Button nativeButton={false} render={<Link to="/import/new" />}>
              <Plus className="size-4" aria-hidden="true" /> Import
            </Button>
          </>
        }
      />

      <JobsToolbar counts={counts} />

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="jobs-table"
          columns={columns}
          rows={jobs}
          rowKey={(entry) => entry.job.id}
          rowClassName={(entry) =>
            // A cancelled row is history: readable, and visibly not competing for attention.
            shown(entry).status === "cancelled" ? "text-fg-3" : undefined
          }
          onRowClick={(entry) => {
            void router.navigate({ to: "/imports/$id", params: { id: entry.job.id } });
          }}
          empty={
            status === "active"
              ? "Nothing active. Paste a URL in the box above, or look at All."
              : "No job matches this filter."
          }
        />
        <Pager
          page={page}
          pageSize={pageSize}
          total={total}
          shown={jobs.length}
          onPage={go}
          noun="jobs"
          data-testid="jobs-pager"
        />
      </div>
    </>
  );
}

/**
 * Whether this page is still being told things, and when it last was.
 *
 * Its own component with its own one-second timer, so the clock ticks without re-rendering
 * fifty rows around it. It renders nothing until hydration: the text is derived from
 * `Date.now()` and would differ between the server's reading and the browser's, which React
 * answers by throwing the whole server tree away (see `components/time-ago.tsx`).
 *
 * The three states are words as well as a dot — "Live", "Reconnecting…", "Connecting…" — and
 * `role="status"` so a reader who never sees the dot is told anyway.
 */
function LiveStatus({
  stream,
  checkedAt,
}: {
  readonly stream: StreamState;
  readonly checkedAt: number | null;
}) {
  const hydrated = useHydrated();
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setTick(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  if (!hydrated) return null;

  const label =
    stream === "live" ? "Live" : stream === "reconnecting" ? "Reconnecting…" : "Connecting…";
  const seconds = checkedAt === null ? null : Math.max(0, Math.round((tick - checkedAt) / 1000));

  return (
    <span
      role="status"
      data-testid="jobs-live"
      data-stream={stream}
      className="mr-1 flex items-center gap-1.5 text-2xs text-fg-3"
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          stream === "live" ? "bg-ok" : stream === "reconnecting" ? "bg-warn" : "bg-fg-3",
        )}
      />
      {label}
      {seconds === null ? null : (
        <span suppressHydrationWarning className="font-mono">
          {/* Seconds while it matters, then the ordinary relative time. */}
          {seconds < 60
            ? `· updated ${String(seconds)}s ago`
            : `· updated ${timeAgo(new Date(checkedAt ?? tick), new Date(tick))}`}
        </span>
      )}
    </span>
  );
}
