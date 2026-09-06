import { useCallback, useRef } from "react";
import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import {
  ArrowRight,
  ArrowUpNarrowWide,
  ExternalLink,
  Fingerprint,
  Inbox,
  Pause,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { LogViewer } from "#/components/log-viewer.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { PipelineStepper } from "#/components/pipeline-dots.tsx";
import {
  ImportStatusBadge,
  STEP_STATUS_META,
  ToneBadge,
  TrackStateBadge,
} from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useJobEvents } from "#/hooks/use-job-events.ts";
import { dateTime, mmss, short } from "#/lib/format.ts";
import type { ImportStatus } from "#/server/db/schema/enums.vocab.ts";
import type { ImportTrack } from "#/server/db/schema/index.ts";
import { bumpJob, cancelJob, fetchJob, pauseJob, retryJob } from "#/server/functions/jobs.ts";

/**
 * `/imports/:id` — one job, live.
 *
 * The page is rendered from the database and then *kept* current by the SSE stream: the log
 * appends line by line, and a terminal event triggers one refetch, because "done" is a
 * statement about rows the stream does not carry. That split — journal over the stream, state
 * over a refetch — is what makes a reload indistinguishable from having watched the whole run.
 */
export const Route = createFileRoute("/_app/imports/$id")({
  loader: async ({ params }) => {
    const detail = await fetchJob({ data: { id: params.id } });
    if (detail === null) throw notFound();
    return detail;
  },
  staticData: { crumbs: [{ label: "Jobs", to: "/imports" }] },
  component: JobPage,
});

const ACTIVE: readonly ImportStatus[] = ["pending", "running"];

function JobPage() {
  const detail = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const { job, tracks, steps, inbox, tracksDone, match, events: initial } = detail;

  // One refetch per burst: a download emits a line per track, and re-reading the job on each
  // would be a query per second for no new information.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refetch = useCallback(() => {
    if (pending.current !== null) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void router.invalidate();
    }, 700);
  }, [router]);

  // A finished job has nothing left to say; opening a stream for it would hold a Postgres
  // LISTEN open and put a misleading "live" badge next to a job that ended yesterday.
  const finished = ["done", "failed", "cancelled"].includes(job.status);

  const { events, live } = useJobEvents({
    importId: job.id,
    initial,
    enabled: !finished,
    onEvent: (event) => {
      if (event.type.startsWith("step.") || event.type.startsWith("inbox.")) refetch();
    },
    onTerminal: () => {
      void router.invalidate();
    },
  });

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

  const release = (match ?? {}) as { releaseMbid?: string; mapped?: number; extras?: number };

  const columns: Column<ImportTrack>[] = [
    {
      key: "n",
      header: "#",
      numeric: true,
      cell: (track) => (
        <span className="text-fg-3">{String(track.position + 1).padStart(2, "0")}</span>
      ),
    },
    {
      key: "youtube",
      header: "YouTube",
      cell: (track) => (
        <div className="min-w-0">
          <div className="truncate">{track.sourceTitle}</div>
          <div className="font-mono text-2xs text-fg-2">{mmss(track.sourceDuration)}</div>
        </div>
      ),
    },
    {
      key: "recording",
      header: (
        <span className="inline-flex items-center gap-1">
          <ArrowRight className="size-3" aria-hidden="true" /> MusicBrainz recording
        </span>
      ),
      cell: (track) =>
        track.trackTitle === null ? (
          <span className="text-fg-3">not bound</span>
        ) : (
          <div className="min-w-0">
            <div className="truncate">{track.trackTitle}</div>
            <div className="font-mono text-2xs text-fg-2">
              track {track.trackPosition ?? "?"} · {short(track.recordingMbid)}…
            </div>
          </div>
        ),
    },
    {
      key: "confidence",
      header: "Conf.",
      cell: (track) =>
        track.confidence === null ? (
          <span className="text-fg-3">not scored</span>
        ) : (
          <ScoreBar value={track.confidence} />
        ),
    },
    {
      key: "fingerprint",
      header: "FP",
      cell: (track) =>
        track.fingerprintOk === true ? (
          <ToneBadge tone="ok">
            <Fingerprint className="size-3" aria-hidden="true" /> ok
          </ToneBadge>
        ) : track.fingerprintOk === false ? (
          <ToneBadge tone="danger">
            <Fingerprint className="size-3" aria-hidden="true" /> differs
          </ToneBadge>
        ) : (
          <span className="text-fg-3">not checked</span>
        ),
    },
    {
      key: "file",
      header: "File",
      cell: (track) => (
        <span className="block max-w-64 truncate font-mono text-2xs text-fg-2">
          {track.libraryPath ?? "not placed"}
        </span>
      ),
    },
    {
      key: "state",
      header: "Status",
      cell: (track) => <TrackStateBadge state={track.state} />,
    },
  ];

  return (
    <>
      <div className="mb-4 flex items-start gap-4">
        {/* Cover Art Archive once `match` bound a release, the YouTube thumbnail before
            that, the gradient only if neither loads (owner review B10). */}
        <Cover
          size="lg"
          src={coverArtFront(job.releaseMbid, 500) ?? detail.thumbnail}
          seed={job.id}
          label={job.title ?? job.url}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold tracking-tight">{job.title ?? job.url}</h1>
            {job.artist === null ? null : <span className="text-fg-2">by {job.artist}</span>}
            <ImportStatusBadge status={job.status} />
            <ToneBadge outline>{job.kind}</ToneBadge>
            {live ? (
              <ToneBadge tone="info" title="Receiving server-sent events">
                live
              </ToneBadge>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-fg-2">
            <span className="truncate">{job.url}</span>
            {job.url.startsWith("fixture://") ? null : (
              <a href={job.url} target="_blank" rel="noreferrer" aria-label="Open the source">
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            )}
          </div>
          <PipelineStepper className="mt-2.5" step={job.step} status={job.status} />
        </div>
        <div className="flex shrink-0 gap-2">
          {job.status === "failed" ? (
            <Button
              data-testid="job-retry"
              onClick={() => {
                act(async () => await retryJob({ data: { id: job.id } }), "Retrying.");
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Retry
            </Button>
          ) : null}
          {inbox.length > 0 ? (
            <Button
              nativeButton={false}
              render={<Link to="/review/$id" params={{ id: inbox[0]?.id ?? "" }} />}
            >
              <Inbox className="size-4" aria-hidden="true" /> Resolve
            </Button>
          ) : null}
          {ACTIVE.includes(job.status) ? (
            <>
              <Button
                variant="outline"
                data-testid="job-pause"
                onClick={() => {
                  act(async () => await pauseJob({ data: { id: job.id } }), "Paused.");
                }}
              >
                <Pause className="size-4" aria-hidden="true" /> Pause
              </Button>
              <Button
                variant="outline"
                data-testid="job-bump"
                onClick={() => {
                  act(
                    async () => await bumpJob({ data: { id: job.id, by: 10 } }),
                    "Moved up the queue.",
                  );
                }}
              >
                <ArrowUpNarrowWide className="size-4" aria-hidden="true" /> Bump
              </Button>
            </>
          ) : null}
          {job.status === "paused" ? (
            <Button
              onClick={() => {
                act(async () => await retryJob({ data: { id: job.id } }), "Resumed.");
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Resume
            </Button>
          ) : null}
          {["done", "cancelled"].includes(job.status) ? null : (
            <Button
              variant="destructive"
              data-testid="job-cancel"
              onClick={() => {
                act(async () => await cancelJob({ data: { id: job.id } }), "Cancelled.");
              }}
            >
              <XCircle className="size-4" aria-hidden="true" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {job.error === null ? null : (
        <Callout tone="danger" className="mb-3.5">
          <b>{job.error.code}</b>: {job.error.hint ?? job.error.message}
          <div className="mt-1.5 font-mono text-2xs opacity-80">{job.error.message}</div>
        </Callout>
      )}
      {inbox.map((item) => (
        <Callout key={item.id} tone="warn" className="mb-3.5">
          <b>{item.title}</b> {item.summary ?? ""}{" "}
          <Link to="/review/$id" params={{ id: item.id }} className="text-primary hover:underline">
            Resolve it
          </Link>
        </Callout>
      ))}

      <div className="split-grid">
        <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
          <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <h2 className="text-sm font-semibold">Tracks</h2>
            <span className="text-xs text-fg-2">
              {tracksDone}/{tracks.length} placed
            </span>
          </header>
          <DataTable
            data-testid="job-tracks"
            columns={columns}
            rows={tracks}
            rowKey={(track) => track.id}
            empty="No videos resolved yet."
          />
        </section>

        <div className="flex flex-col gap-4">
          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Release</h2>
              {job.releaseMbid === null ? null : (
                <a
                  href={`https://musicbrainz.org/release/${job.releaseMbid}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-2xs text-primary hover:underline"
                >
                  <ExternalLink className="size-3" aria-hidden="true" /> MB
                </a>
              )}
            </header>
            <div className="px-3.5 py-3">
              {job.releaseMbid === null ? (
                <p className="text-fg-2">Not resolved yet.</p>
              ) : (
                <KeyValueList
                  items={[
                    { label: "Title", value: job.title ?? "not resolved" },
                    { label: "Artist", value: job.artist ?? "not resolved" },
                    { label: "Year", value: job.year ?? "not resolved" },
                    {
                      label: "MBID",
                      value: <span className="font-mono text-2xs">{job.releaseMbid}</span>,
                    },
                    {
                      label: "Mapping",
                      value: `${String(release.mapped ?? tracks.filter((t) => t.role === "mapped").length)} bound · ${String(release.extras ?? tracks.filter((t) => t.role === "extra").length)} extra`,
                    },
                  ]}
                />
              )}
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Options</h2>
            </header>
            <div className="px-3.5 py-3">
              <KeyValueList
                items={[
                  {
                    label: "Fingerprint",
                    value: job.options.fingerprint === false ? "off" : "verify, pause on mismatch",
                  },
                  {
                    label: "Lyrics",
                    value: job.options.lyrics === false ? "off" : "LRCLIB synced",
                  },
                  {
                    label: "ReplayGain",
                    value: job.options.replaygain === false ? "off" : "track + album",
                  },
                  { label: "Force", value: job.options.force === true ? "on" : "off" },
                  { label: "Priority", value: job.priority },
                  { label: "Created", value: dateTime(job.createdAt) },
                  { label: "Finished", value: dateTime(job.finishedAt) },
                ]}
              />
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Steps</h2>
            </header>
            <div className="px-3.5 py-3">
              <KeyValueList
                items={steps.map((entry) => ({
                  label: entry.step,
                  value:
                    entry.row === null ? (
                      <span className="text-fg-3">not run</span>
                    ) : (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <ToneBadge tone={STEP_STATUS_META[entry.row.status].tone}>
                          {STEP_STATUS_META[entry.row.status].label}
                        </ToneBadge>
                        {entry.row.message === null ? null : (
                          <span className="text-fg-2">{entry.row.message}</span>
                        )}
                      </span>
                    ),
                }))}
              />
            </div>
          </section>
        </div>
      </div>

      <section className="mt-4 overflow-hidden rounded-xl border border-line bg-surface-1">
        <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
          <h2 className="text-sm font-semibold">Log</h2>
          <span className="text-2xs text-fg-2">
            {events.length} lines · {live ? "streaming" : "closed"}
          </span>
        </header>
        <LogViewer events={events} className="rounded-none border-0" />
      </section>
    </>
  );
}
