/**
 * The live worker card at the foot of the sidebar.
 *
 * It answers "is anything happening right now?" on every page, which is the question a
 * single-slot downloader makes you ask constantly. When nothing is running it says so rather
 * than disappearing: an empty card is information, a missing card is doubt.
 */
import { Link } from "@tanstack/react-router";
import { cn } from "cn";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";

export function WorkerCard() {
  const { data } = useShell();
  const current = data?.current ?? null;
  const queued = data?.queued ?? 0;
  const running = current !== null;

  return (
    <div
      data-testid="worker-card"
      className="rounded-lg border border-line bg-surface-2 p-2.5 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={cn("size-2 rounded-full", running ? "animate-pulse-ring bg-ok" : "bg-fg-3")}
          />
          <b className="font-medium">Worker</b>
        </span>
        <span className="font-mono text-3xs text-fg-3">1 slot · {queued} queued</span>
      </div>

      {current === null ? (
        <p className="mt-1.5 text-fg-3">Idle: nothing downloading.</p>
      ) : (
        <>
          <Link
            to="/imports/$id"
            params={{ id: current.importId }}
            className="mt-1.5 block truncate hover:text-primary"
          >
            <span className="text-fg-3">↓ </span>
            {current.title}
            {current.artist === null ? null : (
              <span className="text-fg-3"> by {current.artist}</span>
            )}
          </Link>
          <ProgressBar
            className="mt-2 mb-1.5"
            label="Tracks placed"
            value={current.tracksTotal === 0 ? 0 : current.tracksDone / current.tracksTotal}
          />
          <div className="flex items-center justify-between text-3xs text-fg-3">
            <span>
              {current.tracksDone}/{current.tracksTotal} tracks
            </span>
            <span className="font-mono">{current.step}</span>
          </div>
        </>
      )}
    </div>
  );
}
