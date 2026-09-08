/**
 * One release **group** on step 2 — a record, with its pressings folded inside it.
 *
 * Third owner review, D3. The flat list of releases asked the wrong question. Faced with "Bad
 * Ideas", it offered one card and the person had to work out for themselves that MusicBrainz
 * holds a 2019 album of eleven tracks *and* a 2020 single of one, filed apart, with the same
 * name and the same artist. What they are actually choosing is the **record**; which of its
 * pressings to import is a second, smaller question the engine is allowed to answer for them
 * (`docs/decisions.md` 151).
 *
 * So the screen is groups, and inside each group its releases, best first:
 *
 *  - the best group is **open**, with its best release preselected — the common case is one
 *    glance and Continue;
 *  - every other group is **shut**, showing its identity, its score and one line saying what
 *    is inside, because a collapsed group still has to be legible enough to be worth opening;
 *  - opening a group does not select anything. Selection stays what it was: a radio on a
 *    release card. Nothing on this screen commits (decision 002).
 */
import { useState } from "react";
import { ChevronRight, Disc3, Layers } from "lucide-react";
import type { ReleaseGroupCandidate } from "@mm/domain";
import { cn } from "cn";
import { ReleaseCandidateCard } from "#/components/candidate-card.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { pct } from "#/lib/format.ts";

const BIG_TONE = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  muted: "text-fg-1",
  primary: "text-primary",
} as const;

export interface ReleaseGroupCardProps {
  readonly group: ReleaseGroupCandidate;
  /** The currently chosen release MBID, across every group. */
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  /** Open on mount. True for the best group, false for the rest. */
  readonly defaultOpen: boolean;
}

export function ReleaseGroupCard({
  group,
  selected,
  onSelect,
  defaultOpen,
}: ReleaseGroupCardProps) {
  /*
   * `null` means "follow the default", so a group that becomes the one holding the selection
   * opens without arguing with a reader who shut it on purpose.
   */
  const [open, setOpen] = useState<boolean | null>(null);
  const holdsSelection = group.releases.some((release) => release.id === selected);
  const isOpen = open ?? (defaultOpen || holdsSelection);
  const best = group.releases[0];

  const years = group.year === null ? null : String(group.year);
  const facts = [
    group.primaryType,
    years,
    `${String(group.releases.length)} release${group.releases.length === 1 ? "" : "s"}`,
    best === undefined ? null : `best: ${String(best.tracks)} tracks`,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  return (
    <div
      data-testid="candidate-group"
      data-group-id={group.id ?? "ungrouped"}
      data-preselected={group.preselected}
      data-state={isOpen ? "open" : "closed"}
      className={cn(
        "relative isolate rounded-xl border border-line bg-background",
        group.preselected && "border-primary-soft",
      )}
    >
      <button
        type="button"
        data-testid="group-toggle"
        aria-expanded={isOpen}
        onClick={() => {
          setOpen(!isOpen);
        }}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 text-left",
          "transition-colors duration-100 hover:bg-surface-1",
          "focus-visible:ring-1 focus-visible:ring-primary focus-visible:outline-none",
        )}
      >
        <ChevronRight
          className={cn(
            "mt-1 size-4 shrink-0 text-fg-2 transition-transform duration-150",
            isOpen && "rotate-90",
          )}
          aria-hidden="true"
        />
        {/* Same rule as the card: a pressing MusicBrainz says has no front is not requested,
            so a group header never spends a 404 to draw the gradient it already knows about. */}
        <Cover
          size="sm"
          src={best?.coverArt?.front === false ? null : coverArtFront(best?.id)}
          seed={group.id ?? group.title}
          label={group.title}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {group.title}
            <span className="font-normal text-fg-2">by {group.artist}</span>
            {group.preselected ? (
              <ToneBadge tone="primary">
                <Layers className="size-3" aria-hidden="true" /> best match
              </ToneBadge>
            ) : null}
            {group.secondaryTypes.map((type) => (
              <ToneBadge key={type} tone="danger">
                {type}
              </ToneBadge>
            ))}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-2.5 text-xs text-fg-2">
            {facts.map((part, index) => (
              <span key={`${part}-${String(index)}`}>{part}</span>
            ))}
          </div>
          {isOpen ? null : (
            <p data-testid="group-summary" className="mt-1 text-2xs text-fg-2">
              {best === undefined
                ? "No release scored in this group."
                : `${best.title}${best.year === null ? "" : ` (${String(best.year)})`} — ` +
                  (best.detailed
                    ? `${String(best.videos - best.leftOver)} of your ${String(best.videos)} videos would find a track here`
                    : "no tracklist was read for this group")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span
            data-testid="group-score"
            className={cn("font-mono text-lg font-semibold", BIG_TONE[scoreTone(group.score)])}
          >
            {pct(group.score)}
          </span>
          <span className="flex items-center gap-1 text-3xs text-fg-3">
            <Disc3 className="size-3" aria-hidden="true" /> group score
          </span>
        </div>
      </button>

      <div className={cn("disclosure", isOpen && "disclosure-open")}>
        <div className="disclosure-body">
          <div
            data-testid="group-releases"
            className="flex flex-col gap-2 border-t border-line px-3 pt-2.5 pb-3"
          >
            {group.releases.map((candidate) => (
              <ReleaseCandidateCard
                key={candidate.id}
                candidate={candidate}
                selected={selected === candidate.id}
                onSelect={onSelect}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
