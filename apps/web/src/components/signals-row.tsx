/**
 * The signals behind a score.
 *
 * `docs/decisions.md` 002: the algorithm proposes and explains, it never chooses. A score on
 * its own is an opinion; the nine little squares next to it are the argument. Each one is a
 * named signal in [0, 1], coloured on a red→green ramp, and titled with its exact value —
 * so "why is this 74%?" is answered by hovering rather than by reading the source.
 */
import { cn } from "cn";
import { pct } from "#/lib/format.ts";

/** The names `docs/04` uses, in the order the Console lists them. */
const SIGNAL_LABELS: Record<string, string> = {
  title: "Title",
  artist: "Artist",
  trackCount: "Tracks",
  durations: "Durations",
  duration: "Duration",
  year: "Year",
  label: "Label",
  format: "Format",
  status: "Status",
  country: "Country",
  position: "Position",
  ytTags: "YT tags",
  ytTrackTag: "YT tags",
  isrc: "ISRC",
  acoustid: "AcoustID",
};

export interface SignalsRowProps {
  /** Any of the signal objects of `@mm/domain` — release, recording or mapping. */
  readonly signals: Readonly<Record<string, number | undefined>> | null | undefined;
  readonly className?: string;
}

export function SignalsRow({ signals, className }: SignalsRowProps) {
  if (signals === null || signals === undefined) return null;
  const entries = Object.entries(signals).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );
  if (entries.length === 0) return null;

  return (
    <div data-slot="signals" className={cn("flex flex-wrap gap-1", className)}>
      {entries.map(([key, value]) => {
        const label = SIGNAL_LABELS[key] ?? key;
        return (
          <span
            key={key}
            title={`${label}: ${pct(value)}`}
            className="inline-flex items-center gap-1 rounded-sm border border-line bg-surface-2 py-px pr-1.5 pl-1 text-3xs text-fg-2"
          >
            <i
              aria-hidden="true"
              className="size-2 rounded-xs"
              style={{
                background: `color-mix(in oklab, var(--color-danger) ${String(Math.round((1 - value) * 100))}%, var(--color-ok))`,
              }}
            />
            <b className="font-medium">{label}</b>
          </span>
        );
      })}
    </div>
  );
}
