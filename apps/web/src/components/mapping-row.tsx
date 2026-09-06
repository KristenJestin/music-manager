/**
 * One line of the 1:1 mapping: a video on the left, a MusicBrainz track on the right.
 *
 * The selector in the middle is the point of the whole screen. The engine proposes a binding
 * and shows what it was worth (Δ and a confidence bar); you can change it to any track of the
 * release, or to "not on this release", and the row's tone follows immediately. Nothing here
 * is written anywhere until Start.
 */
import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { MappingLine, MappingSignals } from "@mm/domain";
import { cn } from "cn";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { delta, mmss, pct } from "#/lib/format.ts";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import type { MappingCandidateTrack, SourceVideo } from "#/server/functions/wizard.ts";

export interface MappingRowProps {
  readonly index: number;
  readonly video: SourceVideo;
  readonly line: MappingLine | null;
  /** Every track of the release, for the selector. */
  readonly tracks: readonly MappingCandidateTrack[];
  /** The chosen track's `absoluteIndex`, or `null` for "not on this release". */
  readonly bound: number | null;
  readonly onChange: (absoluteIndex: number | null) => void;
}

/** Why the engine bound this pair, as one hoverable sentence. */
function signalsTitle(signals: MappingSignals | null): string {
  if (signals === null) return "No release track was within tolerance.";
  return Object.entries(signals)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => `${name} ${pct(value)}`)
    .join(" · ");
}

export function MappingRow({ index, video, line, tracks, bound, onChange }: MappingRowProps) {
  // Changing a selector before hydration sets the DOM value and tells React nothing.
  const hydrated = useHydrated();
  const track =
    bound === null ? null : (tracks.find((entry) => entry.absoluteIndex === bound) ?? null);
  const status = track === null ? "unmatched" : (line?.status ?? "check");
  const difference =
    track === null || track.lengthSeconds === null || video.durationSeconds === null
      ? null
      : video.durationSeconds - track.lengthSeconds;

  const Arrow = status === "unmatched" ? X : status === "check" ? AlertTriangle : Check;

  return (
    <div
      data-testid="mapping-row"
      data-video-id={video.videoId}
      data-video-title={video.title}
      data-status={status}
      className="map-grid items-center gap-2.5 border-b border-line px-3 py-2 last:border-b-0"
    >
      <span className="font-mono text-fg-3">{index + 1}</span>

      <div className="flex min-w-0 items-center gap-2.5">
        <span aria-hidden="true" className="h-6.5 w-11 shrink-0 rounded-xs bg-cover-1" />
        <span className="min-w-0">
          <span className="block truncate font-medium">{video.title}</span>
          <span className="block font-mono text-2xs text-fg-2">
            {mmss(video.durationSeconds)} · {video.uploader ?? "unknown channel"}
          </span>
        </span>
      </div>

      <span
        aria-hidden="true"
        className={cn(
          "grid place-items-center",
          status === "confident" && "text-ok",
          status === "check" && "text-warn",
          status === "unmatched" && "text-danger",
        )}
      >
        <Arrow className="size-4" />
      </span>

      <label className="min-w-0">
        <span className="sr-only">MusicBrainz track for {video.title}</span>
        <select
          data-testid="mapping-select"
          disabled={!hydrated}
          value={bound === null ? "" : String(bound)}
          onChange={(event) => {
            onChange(event.target.value === "" ? null : Number(event.target.value));
          }}
          className="h-7 w-full rounded-md border border-line-strong bg-background px-2 text-xs outline-none focus:border-primary"
        >
          <option value="">— not on this release (skip / extra) —</option>
          {tracks.map((option) => (
            <option key={option.absoluteIndex} value={String(option.absoluteIndex)}>
              {String(option.position).padStart(2, "0")} · {option.title} ·{" "}
              {mmss(option.lengthSeconds)}
            </option>
          ))}
        </select>
      </label>

      <div className="text-2xs">
        {track === null ? (
          <ToneBadge tone="warn">extra video</ToneBadge>
        ) : (
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "font-mono",
                difference !== null && Math.abs(difference) > 2 ? "text-warn" : "text-ok",
              )}
            >
              Δ {delta(difference)}
            </span>
            <ScoreBar value={line?.confidence ?? null} hideNumber />
          </span>
        )}
      </div>

      <span
        title={signalsTitle(line?.signals ?? null)}
        className="grid size-6 cursor-help place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-foreground"
      >
        <Info className="size-3.5" aria-hidden="true" />
      </span>
    </div>
  );
}
