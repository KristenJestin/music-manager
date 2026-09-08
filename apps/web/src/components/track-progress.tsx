/**
 * What one track is doing *right now*, read from the journal rather than from a column.
 *
 * The owner's C2 and C7: "téléchargement lent, aucun détail", "tagging sans info". Everything
 * needed to answer that already travels — `download` emits a `track.progress` line every two
 * seconds carrying yt-dlp's `downloaded` / `total` / `speed` / `eta`, and its `postprocess`
 * sub-steps (`ExtractAudio`, `MoveFiles`) come down the same pipe; `fingerprint`, `tag` and
 * `place` now open each track with a `track.started`. So the live state is a **fold over the
 * events the page already has**, not a new column written four times a second:
 *
 *  - nothing is polled, and nothing is written to Postgres on the hot path;
 *  - a reload is identical to having watched it, because the loader re-reads the same rows;
 *  - the fold is a pure function, so it is unit-testable without a browser.
 *
 * `liveTracks` keeps only the *last* line per track, and a terminal line (`track.done`,
 * `track.failed`, `track.skipped`) removes the track from the map — a finished track shows its
 * state badge, not a stale 87%.
 */
import { cn } from "cn";
import type { JobEventPayload } from "@mm/contracts";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { bytes, mmss } from "#/lib/format.ts";

/** Lines that mean "this track is no longer in flight". */
const TERMINAL = new Set(["track.done", "track.failed", "track.skipped"]);

/** Lines that describe a track in flight. */
const LIVE = new Set(["track.started", "track.progress", "track.waiting"]);

export interface TrackActivity {
  /** `download`, `ExtractAudio`, `tag`, `waiting`… whatever the step called this phase. */
  readonly stage: string | null;
  /** 0–100, only while bytes are moving. */
  readonly percent: number | null;
  /** Bytes per second, from yt-dlp. */
  readonly speed: number | null;
  /** Seconds left, from yt-dlp. */
  readonly eta: number | null;
  /** The journal line itself, which is always a complete sentence. */
  readonly message: string;
  /** True while the track is queueing for the toolbox's single download slot. */
  readonly waiting: boolean;
}

function numberOf(data: Record<string, unknown> | null, key: string): number | null {
  const value = data?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(data: Record<string, unknown> | null, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Fold a journal into "what is each track doing", newest line wins.
 *
 * Deliberately tolerant: an event whose `data` the orchestrator has not filled in yet still
 * produces an entry with its message, because a sentence with no percentage is still infinitely
 * more than the blank cell the owner was looking at.
 */
export function liveTracks(events: readonly JobEventPayload[]): ReadonlyMap<string, TrackActivity> {
  const live = new Map<string, TrackActivity>();
  for (const event of events) {
    const trackId = event.trackId;
    if (trackId === null) continue;
    if (TERMINAL.has(event.type)) {
      live.delete(trackId);
      continue;
    }
    if (!LIVE.has(event.type)) continue;
    const data = event.data;
    /*
     * The album's tag pass reports on tracks that are already **placed**.
     *
     * `tagAlbum` rewrites a settled file when the album-scope answer differs from the
     * recording's, and it says so with a `track.progress` line carrying `rewritten: true` —
     * which arrives *after* that track's `track.done` and `place`, and so put the track back
     * into the live map. The row then showed the word "tag" under a `Placed` badge for ever:
     * a report about a finished track read as a track in flight. It is a terminal line in
     * everything but its name (owner review 5, G2).
     */
    if (data?.["rewritten"] === true) {
      live.delete(trackId);
      continue;
    }
    const previous = live.get(trackId);
    const percent = numberOf(data, "percent");
    live.set(trackId, {
      // A `postprocess` line carries no percentage; keeping the previous one would freeze the
      // bar at 98% under the word "ExtractAudio", which reads like a stall.
      stage: stringOf(data, "stage") ?? (event.type === "track.waiting" ? "waiting" : null),
      percent: percent ?? (event.type === "track.progress" ? null : (previous?.percent ?? null)),
      speed: numberOf(data, "speed"),
      eta: numberOf(data, "eta"),
      message: event.message,
      waiting: event.type === "track.waiting",
    });
  }
  return live;
}

/** `1.4 MB/s`, or nothing when yt-dlp did not say. */
function speedLabel(speed: number | null): string | null {
  return speed === null || speed <= 0 ? null : `${bytes(speed)}/s`;
}

export interface TrackProgressProps {
  /** `undefined` for a track that is not in flight: the block keeps its space, empty. */
  readonly activity: TrackActivity | undefined;
  readonly className?: string;
}

/**
 * Is there a real download percentage to draw?
 *
 * Three conditions, and all three are the point. `stage === "download"` because that is the
 * only phase yt-dlp reports bytes for — `ExtractAudio` and `MoveFiles` come down the same pipe
 * with no figure, and freezing the bar at 98 % under them is what made it read as a stall.
 * `percent !== null` because `track.started` opens the phase before the first progress line
 * arrives, and a bar at zero is a claim. And not `waiting`, because a track queueing for the
 * single download slot has not started: the row says so in words, in warn, on the line above.
 */
export function downloadPercent(activity: TrackActivity | undefined): number | null {
  if (activity === undefined || activity.waiting) return null;
  if (activity.stage !== "download") return null;
  const percent = activity.percent;
  return percent === null || !Number.isFinite(percent) ? null : Math.min(100, Math.max(0, percent));
}

/**
 * The live detail of one track — the phase, the percentage, the speed, the ETA and the bar.
 *
 * **It lives in the Status column, and it reserves its space** (owner review D4). It used to
 * be rendered under the video's title, where it displaced the duration and made the whole
 * table jump on every one of the four progress lines a second: the row grew by a line when a
 * track started, shrank again when it finished, and the column widths were re-measured each
 * time because a `1.4 MB/s` is wider than a `32.0 KB/s`. Three rules fix that, and all three
 * are in this component rather than in the page:
 *
 *  - the block is **always rendered**, with the same height whether or not anything is
 *    happening, so a row never changes height;
 *  - the stage and the figures are on **two lines**, each `min-w-0` and truncating, so no
 *    string inside can widen the column that holds it;
 *  - the third line always occupies the bar's height — but only *contains* a bar while bytes
 *    are moving.
 *
 * That last clause is the fifth owner review's G2, and it is the correction of how D4 was
 * first read. "Reserve the space" was implemented as "draw the bar at zero", so every row of
 * a finished import carried a grey track under `Placed` and `Queued` that would never move
 * again — a progress bar for something that is not in progress. The space is still reserved,
 * by an empty spacer of the same height; the bar itself now exists only for a track that is
 * downloading *and* has a real percentage from yt-dlp. A queued track, a track waiting for the
 * download slot, a track being tagged and a placed track all show nothing there.
 */

export function TrackProgress({ activity, className }: TrackProgressProps) {
  const speed = speedLabel(activity?.speed ?? null);
  // `mmss`, not `delta`: an ETA is a duration, and `delta` prints the sign of an offset.
  const eta =
    activity?.eta === undefined || activity.eta === null || activity.eta <= 0
      ? null
      : mmss(activity.eta);
  const percent = downloadPercent(activity);
  const parts = [
    activity?.percent === undefined || activity.percent === null
      ? null
      : `${String(activity.percent)}%`,
    speed,
    eta === null ? null : `${eta} left`,
  ].filter((part): part is string => part !== null);

  return (
    <div
      data-testid="track-progress"
      data-active={activity === undefined ? "no" : "yes"}
      data-downloading={percent === null ? "no" : "yes"}
      className={cn("min-w-0 space-y-0.5", className)}
    >
      <div className="flex h-3.5 min-w-0 items-center text-2xs">
        <span
          className={cn(
            "min-w-0 truncate font-mono",
            activity?.waiting === true ? "text-warn" : "text-fg-2",
          )}
          title={activity?.message ?? ""}
        >
          {activity === undefined ? "" : (activity.stage ?? "working")}
        </span>
      </div>
      <div className="flex h-3.5 min-w-0 items-center text-2xs">
        <span className="min-w-0 truncate font-mono text-fg-3">{parts.join(" · ")}</span>
      </div>
      {/* The reserved third line. `h-1.5` is `ProgressBar`'s own height, so swapping one for
          the other cannot move a row by a pixel — which is the whole of decision 150. */}
      {percent === null ? (
        <div data-testid="track-progress-spacer" aria-hidden="true" className="h-1.5" />
      ) : (
        <ProgressBar value={percent / 100} tone="info" label={activity?.message ?? "downloading"} />
      )}
    </div>
  );
}
