/**
 * One line of the 1:1 mapping: a video on the left, a MusicBrainz track on the right.
 *
 * The selector in the middle is the point of the whole screen. The engine proposes a binding
 * and shows what it was worth (Δ and a confidence bar); you can change it to any track of the
 * release, or to "not on this release", and the row's tone follows immediately. Nothing here
 * is written anywhere until Start.
 *
 * The selector is the shadcn/Base UI `Select`, not the browser's own (A10 of the owner review).
 * A native `<select>` cannot be styled to match the rest of the Console, and on a fourteen-track
 * release its popup is the one piece of the screen that looks like a different application. The
 * escape hatch — "not on this release" — stays first in the list, because it is the answer to
 * "this video is a bonus track" and that is the common correction.
 */
import { AlertTriangle, Check, Info, X } from "lucide-react";
import type { MappingLine, MappingSignals } from "@mm/domain";
import { cn } from "cn";
import { Cover } from "#/components/cover.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "#/components/ui/select.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "#/components/ui/tooltip.tsx";
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

/** The sentinel the Select uses for "not on this release": a value, because `null` is not one. */
const SKIP = "skip";

/** What the engine weighed for this pair, as label/value pairs a tooltip can lay out. */
function signalPairs(signals: MappingSignals | null): readonly { name: string; value: number }[] {
  if (signals === null) return [];
  return Object.entries(signals)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([name, value]) => ({ name, value }));
}

/** One option's label, used both in the popup and on the closed trigger. */
function trackLabel(track: MappingCandidateTrack): string {
  return `${String(track.position).padStart(2, "0")} · ${track.title} · ${mmss(track.lengthSeconds)}`;
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
  const pairs = signalPairs(line?.signals ?? null);

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
        <Cover
          size="xs"
          src={video.thumbnail}
          seed={video.videoId}
          label={video.title}
          className="h-6.5 w-11 rounded-xs"
        />
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

      <div className="min-w-0">
        <Select
          value={bound === null ? SKIP : String(bound)}
          onValueChange={(next) => {
            onChange(next === SKIP ? null : Number(next));
          }}
        >
          <SelectTrigger
            size="sm"
            data-testid="mapping-select"
            disabled={!hydrated}
            aria-label={`MusicBrainz track for ${video.title}`}
            className="w-full rounded-md border-line-strong bg-background text-xs"
          >
            <span data-slot="select-value" className="truncate">
              {track === null ? "not on this release (skip / extra)" : trackLabel(track)}
            </span>
          </SelectTrigger>
          <SelectContent className="text-xs">
            {/* First, deliberately: "this video is not on the release" is the usual correction. */}
            <SelectItem value={SKIP} className="text-xs">
              not on this release (skip / extra)
            </SelectItem>
            <SelectSeparator />
            {tracks.map((option) => (
              <SelectItem
                key={option.absoluteIndex}
                value={String(option.absoluteIndex)}
                className="text-xs"
              >
                {trackLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

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

      {/*
        A real tooltip, not the browser's (A11). `title` truncated the signals to "title 10…"
        after a fraction of a second of hover and could not be read at all on a touch screen;
        this one is a focusable button with the numbers laid out one per line.
      */}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-testid="mapping-signals"
              aria-label={`Why video ${String(index + 1)} was bound this way`}
              className="grid size-6 cursor-help place-items-center rounded-md text-fg-3 hover:bg-surface-3 hover:text-foreground focus-visible:bg-surface-3 focus-visible:text-foreground focus-visible:outline-none"
            >
              <Info className="size-3.5" aria-hidden="true" />
            </button>
          }
        />
        <TooltipContent className="max-w-64 flex-col items-start gap-1">
          {pairs.length === 0 ? (
            <span>No release track was within tolerance, so nothing was bound.</span>
          ) : (
            <>
              <span className="font-medium">Why this binding</span>
              <span className="grid w-full grid-cols-[auto_1fr] gap-x-2.5 font-mono">
                {pairs.map((pair) => (
                  <span key={pair.name} className="contents">
                    <span>{pair.name}</span>
                    <span className="text-right">{pct(pair.value)}</span>
                  </span>
                ))}
              </span>
            </>
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
