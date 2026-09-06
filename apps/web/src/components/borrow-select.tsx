/**
 * "Borrow album context from" — where a lone recording gets filed.
 *
 * A single video has no album. It still has to land in a folder, carry album tags and get a
 * track number, so `docs/04` § Recording makes the matcher choose a release to *borrow* that
 * from: album > single > EP > compilation/live, same artist, coherent year. That choice
 * decides the folder name, the `ALBUM`/`ALBUMARTIST` tags and the track index of the file, so
 * it is not an implementation detail — it is a decision, and the prototype
 * (`prototypes/A-console`, `wizStep2Single`) shows it as a field on the selected card.
 *
 * Ordered by the engine, never re-sorted here: the first entry is the one it preferred, and
 * every entry says which kind of release it is so the ladder is readable rather than implied.
 */
import type { BorrowRelease } from "@mm/domain";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";

/** `Klangsberg — single, 2018, XW (track 1/1)`. */
export function borrowLabel(release: BorrowRelease): string {
  const parts = [
    release.type ?? "release",
    release.date === null ? null : release.date.slice(0, 4),
    release.country,
    release.trackPosition === null
      ? null
      : `track ${String(release.trackPosition)}${release.trackCount === null ? "" : `/${String(release.trackCount)}`}`,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return `${release.title} — ${parts.join(", ")}`;
}

export function BorrowSelect({
  releases,
  value,
  onChange,
  disabled = false,
}: {
  readonly releases: readonly BorrowRelease[];
  /** The chosen release MBID, or `null` to follow the engine's preference. */
  readonly value: string | null;
  readonly onChange: (releaseMbid: string) => void;
  readonly disabled?: boolean;
}) {
  const hydrated = useHydrated();
  const chosen =
    (value === null ? undefined : releases.find((release) => release.id === value)) ??
    releases.find((release) => release.preferred) ??
    releases[0] ??
    null;

  if (releases.length === 0) {
    return (
      <p data-testid="borrow-empty" className="text-2xs text-warn">
        MusicBrainz knows this recording but puts it on no release, so there is no album context to
        borrow. Pick another candidate, or import without MusicBrainz.
      </p>
    );
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-fg-2">Borrow album context from</span>
      <Select
        value={chosen?.id ?? ""}
        onValueChange={(next) => {
          // Base UI hands back `null` when the selection is cleared; "no release at all" is
          // not one of the answers here, so it is simply ignored.
          if (typeof next === "string" && next !== "") onChange(next);
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="borrow-select"
          disabled={disabled || !hydrated}
          aria-label="Borrow album context from"
          className="w-full max-w-borrow rounded-md border-line-strong bg-background text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {chosen === null ? "none" : borrowLabel(chosen)}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {releases.map((release) => (
            <SelectItem key={release.id} value={release.id} className="text-xs">
              {borrowLabel(release)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-2xs text-fg-3">
        This is the album folder, the album tags and the track number the file ends up with.
      </span>
    </label>
  );
}
