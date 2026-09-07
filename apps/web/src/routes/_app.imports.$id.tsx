import { useCallback, useMemo, useRef, useState } from "react";
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
import { liveTracks, TrackProgress } from "#/components/track-progress.tsx";
import { useJobEvents } from "#/hooks/use-job-events.ts";
import { dateTime, mmss, short } from "#/lib/format.ts";
import type { ImportStatus } from "#/server/db/schema/enums.vocab.ts";
import type { ImportTrack } from "#/server/db/schema/index.ts";
import {
  bumpJob,
  cancelJob,
  fetchJob,
  pauseJob,
  retryJob,
  retryTrack,
} from "#/server/functions/jobs.ts";

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
    // **Every** line is a reason to re-read the rows, not only the step boundaries (owner
    // review C5). A 28-track download emits nothing but `track.*` for twenty minutes, so the
    // old filter left the Tracks table, the "n/m placed" counter and the Steps block frozen at
    // whatever they said when the page loaded — which is precisely "le détail d'un job ne se
    // met pas à jour tout seul". `refetch` already collapses a burst into one query per 700 ms,
    // so the cost of widening this is one query per second at the very worst.
    onEvent: refetch,
    onTerminal: () => {
      void router.invalidate();
    },
  });

  /** What each track is doing right now, folded out of the journal. */
  const activity = useMemo(() => liveTracks(events), [events]);

  // The controls are disabled while their own call is in flight, so a page that has not
  // refreshed yet cannot be clicked "plein de fois" into a queue of duplicate retries (C5).
  const [busy, setBusy] = useState<string | null>(null);

  const act = (key: string, run: () => Promise<unknown>, message: string): void => {
    if (busy !== null) return;
    setBusy(key);
    void run().then(
      () => {
        toast(message, "ok");
        setBusy(null);
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  /** True while the worker owns this job: retrying now would only queue a second run. */
  const running = ACTIVE.includes(job.status);

  /** The newest live sentence, for the step that is currently running. */
  const currentStage = useMemo(() => {
    const last = [...activity.values()].at(-1);
    return last === undefined ? null : last.message;
  }, [activity]);

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
      // The title and **the duration**, and nothing else. Everything that is a *state* — the
      // live sub-step, the percentage, the error — belongs to Status now (owner review D4):
      // it used to be here, where it took the duration's place and moved the whole table on
      // every progress line.
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
        // Narrower than it was: Status is a fixed 224 px now, and the seven columns have to
        // fit beside each other before the table starts scrolling sideways. The whole path is
        // one hover away.
        <span
          className="block max-w-40 truncate font-mono text-2xs text-fg-2"
          title={track.libraryPath ?? undefined}
        >
          {track.libraryPath ?? "not placed"}
        </span>
      ),
    },
    {
      key: "state",
      header: "Status",
      /*
       * **Fixed width, fixed height** (owner review D4).
       *
       * This is the one column whose content changes four times a second, so it is the one
       * column that must not be allowed to resize anything. `w-56` on both the header and the
       * cell pins it; `TrackProgress` reserves its three lines whether or not a track is in
       * flight, so a row does not grow when a download starts; and everything inside truncates,
       * so no yt-dlp figure can push the column wider than the number next to it.
       */
      className: "w-56",
      headClassName: "w-56",
      cell: (track) => (
        <div data-testid="track-status" className="flex w-56 min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <TrackStateBadge state={track.state} />
            {/* One track, one retry. Re-running the whole album to fetch a single video that
                lost a bot check is what the owner had to do until now (C6). */}
            {track.role === "mapped" && (track.state === "failed" || track.error !== null) ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="track-retry"
                disabled={busy !== null}
                onClick={() => {
                  act(
                    `track:${track.id}`,
                    async () => await retryTrack({ data: { id: job.id, trackId: track.id } }),
                    "Track queued for another download.",
                  );
                }}
              >
                <RotateCcw className="size-3" aria-hidden="true" /> Retry track
              </Button>
            ) : null}
          </div>
          <TrackProgress activity={activity.get(track.id)} />
          {/* The API has carried `tracks[].error` since MCP-FIX-1; the page never showed it,
              so a track sat at `failed` with no reason and no way out (owner review C6). */}
          {track.error === null ? null : (
            <div
              data-testid="track-error"
              className="flex min-w-0 items-center gap-1.5 text-2xs text-danger"
            >
              <b className="shrink-0 font-mono">{track.error.code}</b>
              <span className="min-w-0 truncate" title={track.error.message}>
                {track.error.hint ?? track.error.message}
              </span>
            </div>
          )}
        </div>
      ),
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
            {/* Named, because "Done" is also what a *step* badge says a few sections lower,
                and a test that looks for the word finds whichever comes first. */}
            <span data-testid="job-status">
              <ImportStatusBadge status={job.status} />
            </span>
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
          {/* Shown for every job a worker could still do something with, and **disabled while
              it runs**: the owner's C5 was "j'ai le temps de cliquer plein de fois sur Retry",
              and every one of those clicks used to start a step. A retry is only meaningful
              once the worker has let go.

              A `done` job keeps the button on purpose. Retrying one re-runs `verify` — the
              resume point of a job whose every step finished — which is exactly "check this
              album again", and the one gesture that repairs a file deleted from under the
              library (C6). A cancelled job is the only one with nothing to offer. */}
          {job.status === "cancelled" ? null : (
            <Button
              data-testid="job-retry"
              disabled={busy !== null || running}
              title={running ? "The worker is running this job." : undefined}
              onClick={() => {
                act("retry", async () => await retryJob({ data: { id: job.id } }), "Queued.");
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" />{" "}
              {busy === "retry" ? "Queueing…" : running ? "Running…" : "Retry"}
            </Button>
          )}
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
                disabled={busy !== null}
                onClick={() => {
                  act("pause", async () => await pauseJob({ data: { id: job.id } }), "Paused.");
                }}
              >
                <Pause className="size-4" aria-hidden="true" /> Pause
              </Button>
              <Button
                variant="outline"
                data-testid="job-bump"
                disabled={busy !== null}
                onClick={() => {
                  act(
                    "bump",
                    async () => await bumpJob({ data: { id: job.id, by: 10 } }),
                    "Moved up the queue.",
                  );
                }}
              >
                <ArrowUpNarrowWide className="size-4" aria-hidden="true" /> Bump
              </Button>
            </>
          ) : null}
          {["done", "cancelled"].includes(job.status) ? null : (
            <Button
              variant="destructive"
              data-testid="job-cancel"
              disabled={busy !== null}
              onClick={() => {
                act("cancel", async () => await cancelJob({ data: { id: job.id } }), "Cancelled.");
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
                        {/* A running step has no message yet — its row is only written when it
                            ends. The live sub-step is the one thing worth showing there, and
                            it is exactly what C2/C7 asked for.

                            **Only for the head step**, since the steps overlap (decision 147):
                            `fingerprint`, `tag` and `place` are all `running` while `download`
                            still holds the slot, and the newest live sentence belongs to one of
                            them. Printing it beside all four said "Face to Face: downloading
                            22%" next to `tag`. The other three carry their own derived
                            sentence — `11/14 track(s)` — which is the true one. */}
                        {entry.row.status === "running" &&
                        entry.step === job.step &&
                        currentStage !== null ? (
                          <span data-testid="step-stage" className="text-fg-2">
                            {currentStage}
                          </span>
                        ) : entry.row.message === null ? null : (
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
