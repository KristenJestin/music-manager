import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { Plus, RotateCcw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PipelineDots } from "#/components/pipeline-dots.tsx";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { ImportStatusBadge, ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { cn } from "cn";
import { TimeAgo } from "#/components/time-ago.tsx";
import { bumpJob, fetchJobs, retryJob } from "#/server/functions/jobs.ts";
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
      "done",
      "failed",
      "cancelled",
    ])
    .default("all"),
});

/**
 * `/imports` — every import is a job, and one track downloads at a time.
 *
 * The filter lives in the URL rather than in component state, so "the failed ones" is a link
 * you can send someone, and so the dashboard's Failed tile can point straight at it.
 */
export const Route = createFileRoute("/_app/imports/")({
  validateSearch: search,
  loaderDeps: ({ search: { status } }) => ({ status }),
  loader: async ({ deps }) => await fetchJobs({ data: { status: deps.status } }),
  staticData: { crumbs: [{ label: "Jobs" }] },
  component: Jobs,
});

const FILTERS = [
  ["all", "All"],
  ["active", "Active"],
  ["awaiting_review", "Needs review"],
  ["failed", "Failed"],
  ["done", "Done"],
] as const;

function Jobs() {
  const { jobs, counts } = Route.useLoaderData();
  const { status } = Route.useSearch();
  const router = useRouter();
  const toast = useToast();
  const now = new Date();

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
      cell: (entry) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{entry.job.title ?? entry.job.url}</div>
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
      cell: (entry) => <PipelineDots step={entry.job.step} status={entry.job.status} />,
    },
    {
      key: "progress",
      header: "Progress",
      className: "w-48",
      cell: (entry) => (
        <div className="flex items-center gap-2">
          <ProgressBar
            className="flex-1"
            value={entry.tracksTotal === 0 ? 0 : entry.tracksDone / entry.tracksTotal}
            tone={
              entry.job.status === "failed"
                ? "danger"
                : entry.job.status === "done"
                  ? "ok"
                  : entry.job.status === "awaiting_review"
                    ? "warn"
                    : "info"
            }
          />
          <span className="font-mono text-2xs text-fg-2">
            {entry.tracksDone}/{entry.tracksTotal}
          </span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (entry) => <ImportStatusBadge status={entry.job.status} />,
    },
    {
      key: "updated",
      header: "Updated",
      cell: (entry) => <TimeAgo at={entry.job.updatedAt} now={now} className="text-fg-2" />,
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (entry) => (
        <div className="flex justify-end gap-1.5">
          {entry.job.status === "failed" ? (
            <Button
              size="xs"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                act(
                  async () => await retryJob({ data: { id: entry.job.id } }),
                  "Retrying the job.",
                );
              }}
            >
              Retry
            </Button>
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
            <Button
              variant="outline"
              onClick={() => {
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

      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="job-filters">
        {FILTERS.map(([key, label]) => (
          <Link
            key={key}
            to="/imports"
            search={{ status: key }}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-xl border border-line-strong bg-surface-2 px-2.5 text-xs text-fg-1",
              status === key && "border-primary bg-primary-soft text-primary",
            )}
          >
            {label}
            <span className="font-mono text-2xs text-fg-3">{counts[key]}</span>
          </Link>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="jobs-table"
          columns={columns}
          rows={jobs}
          rowKey={(entry) => entry.job.id}
          onRowClick={(entry) => {
            void router.navigate({ to: "/imports/$id", params: { id: entry.job.id } });
          }}
          empty="No jobs yet. Paste a URL in the box above to start one."
        />
      </div>
    </>
  );
}
