/**
 * What the single download slot is busy with, while a screen is waiting for something else.
 *
 * ## What it is for
 *
 * Pasting a URL while a download runs leaves the wizard on *"Reading the source…"* for up to
 * a minute with nothing on screen but a spinner. This is the panel that says what the
 * installation is doing in the meantime: the import holding the slot, what is queued behind
 * it, and — when it has one — this import's own place in that line. Every entry is a link to
 * the job it names, because "something is downloading" is only useful if you can go and look.
 *
 * ## What it must not say
 *
 * **It is not a queue for the thing you are waiting on.** Measured end to end: a
 * `POST /extract` issued while a download is in flight is *not* serialised behind it. The
 * toolbox's download slot (`services/toolbox/src/toolbox/lock.py`) is taken by `/download`
 * and by nothing else, and the FastAPI process serves the other routes while it is held —
 * `/errors` 2.1 ms idle against 2.6 ms during a real yt-dlp download, `/probe` 96 ms against
 * 100 ms, and no worse under a sixteen-way ffmpeg burn. So the wait is the source's, and the
 * copy here says exactly that rather than implying a line we manage and could shorten.
 *
 * For the same reason there is **no countdown**. What is honest is the elapsed time and the
 * name of what is being waited on; a remaining time for a yt-dlp extraction of a playlist
 * nobody has listed yet would be invented.
 *
 * ## Where the numbers come from
 *
 * `workerSnapshot` — the slot holder is the `download` step row that is `running`, the depth
 * is every import waiting on the worker, and the order is the worker's own (priority, then
 * age). It arrives on the shell payload, which already refreshes on its interval *and* on
 * every journal event, so this panel is live without a poll of its own. Re-running a loader
 * to learn the same five rows is the defect `fix-wizard-reuse` removed.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";
import { useTestId } from "#/components/pending-tree.tsx";
import { mmss } from "#/lib/format.ts";

export interface SlotQueueProps {
  /**
   * The import this screen belongs to, when it has one, so the list can point at the reader's
   * own row. `null` on the first paste: the import is being created as this renders, and it is
   * parked for the wizard rather than queued, so it has no position and is not claimed to.
   */
  readonly importId: string | null;
  /**
   * The URL this screen is resolving, when there is one.
   *
   * The other half of "do not list the reader against themselves": between the paste and the
   * first frame of the wizard the import exists, is `running` at `resolve`, and has no id
   * the browser knows. It does have this URL, which is the one the reader typed.
   */
  readonly sourceUrl: string | null;
  /** What the screen is waiting for, in the sentence "Waiting 0:12 on …". */
  readonly waitingOn: string;
}

/** Seconds since this component was mounted, ticking once a second, zero on the server. */
function useElapsedSeconds(): number {
  const [mounted] = useState(() => Date.now());
  const [now, setNow] = useState(mounted);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return Math.max(0, Math.floor((now - mounted) / 1000));
}

export function SlotQueue({ importId, sourceUrl, waitingOn }: SlotQueueProps) {
  const testId = useTestId();
  const { data } = useShell();
  const waiting = data?.waiting ?? [];
  const queued = data?.queued ?? 0;
  const elapsed = useElapsedSeconds();

  /*
   * Only a job that actually **holds the slot** is named here.
   *
   * `workerSnapshot.current` falls back to "the most recently moved running import" when no
   * download is in flight, which is right for the sidebar card and wrong for this panel: the
   * most recently moved running import, while the wizard is reading a URL, is *the import the
   * wizard just created*. The question this answers is "what is in the way", and the answer to
   * that is the slot or nothing.
   */
  const holder = data?.current?.holdsSlot === true ? data.current : null;
  /** The same rule for the queue: the reader is never listed behind themselves. */
  const mine = (job: { importId: string; url: string }): boolean =>
    job.importId === importId || (sourceUrl !== null && job.url === sourceUrl);
  const others = waiting.filter((job) => !mine(job));
  const idle = holder === null && others.length === 0;
  const unnamed = Math.max(0, queued - waiting.length);

  return (
    <section
      role="status"
      data-testid={testId("slot-queue")}
      data-idle={idle ? "yes" : "no"}
      className="mx-auto w-full max-w-md rounded-lg border border-line bg-surface-2 p-3 text-left"
    >
      <h3 className="text-2xs font-semibold text-fg-2" data-testid={testId("slot-queue-title")}>
        {idle
          ? "Nothing of ours is in the way"
          : holder === null
            ? "Nothing is downloading, and these are waiting for the slot"
            : "The download slot is taken"}
      </h3>

      {holder === null ? null : (
        <div className="mt-2">
          <Link
            to="/imports/$id"
            params={{ id: holder.importId }}
            data-testid={testId("slot-holder")}
            data-import-id={holder.importId}
            className="block truncate text-xs hover:text-primary"
          >
            <span className="text-fg-3" aria-hidden="true">
              {holder.holdsSlot ? "↓ " : "· "}
            </span>
            {holder.title}
            {holder.artist === null ? null : <span className="text-fg-3"> by {holder.artist}</span>}
          </Link>
          <ProgressBar
            className="mt-1.5 mb-1"
            label="Tracks placed"
            value={holder.tracksTotal === 0 ? 0 : holder.tracksDone / holder.tracksTotal}
          />
          <p className="flex items-center justify-between text-3xs text-fg-3">
            <span data-testid={testId("slot-holder-progress")}>
              {holder.tracksDone}/{holder.tracksTotal} tracks ·{" "}
              {holder.holdsSlot ? "downloading" : "finishing up"}
            </span>
            <span className="font-mono">{holder.step}</span>
          </p>
        </div>
      )}

      {others.length === 0 ? null : (
        <ol className="mt-2 flex flex-col gap-1" data-testid={testId("slot-waiting")}>
          {others.map((job, index) => (
            <li key={job.importId} className="flex items-baseline gap-2 text-3xs">
              <span className="font-mono text-fg-3">{index + 1}.</span>
              <Link
                to="/imports/$id"
                params={{ id: job.importId }}
                data-testid={testId(`slot-waiting-${String(index)}`)}
                data-import-id={job.importId}
                className="truncate hover:text-primary"
              >
                {job.title}
                {job.artist === null ? null : <span className="text-fg-3"> by {job.artist}</span>}
              </Link>
              {job.importId === importId ? (
                <span className="text-primary" data-testid={testId("slot-waiting-mine")}>
                  this import
                </span>
              ) : null}
            </li>
          ))}
          {unnamed === 0 ? null : (
            <li className="text-3xs text-fg-3" data-testid={testId("slot-waiting-more")}>
              and {unnamed} more
            </li>
          )}
        </ol>
      )}

      {/*
       * The honest sentence, and the reason this panel exists at all: the list above is
       * context, not a queue the reader is standing in. Reading a link takes the toolbox's
       * ordinary path and is never refused or delayed by the slot; what it does share with a
       * running download is YouTube's patience and the line to it.
       */}
      <p className="mt-2 text-3xs text-fg-3" data-testid={testId("slot-queue-note")}>
        {idle
          ? "No download is running and nothing is queued, so this wait is the source's alone."
          : "Reading a link does not wait for the download slot — the slot is for downloads. YouTube is simply slower to answer a client that is already pulling a file."}
      </p>
      <p className="mt-0.5 text-3xs text-fg-3" data-testid={testId("slot-queue-elapsed")}>
        Waiting <span className="font-mono">{mmss(elapsed)}</span> on {waitingOn}.
      </p>
    </section>
  );
}
