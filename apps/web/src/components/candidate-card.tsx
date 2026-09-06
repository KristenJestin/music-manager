/**
 * One scored candidate, release or recording.
 *
 * The card is the whole of decision 002 made visible: the score is large, the preselection is
 * labelled as a *proposal*, and "why?" opens the signals and the sentences that produced the
 * number. Selecting is a radio; the algorithm ordered the list, you pick from it.
 *
 * The reasons are open by default on the selected card. Somebody comparing two candidates is
 * doing so on the evidence, and making them click twice to see it would be making the
 * argument harder to read than the conclusion.
 *
 * "Tracklist fit" is the second disclosure, and it answers the question the owner asked of the
 * first real import: *the album is chosen from the tracks, but the mapping comes after.* It
 * does not — the fit is computed per candidate before anything is preselected, which is why one
 * pressing beats another. Step 3 is where you **change** that assignment; this is where you see
 * the one that already decided the ranking.
 */
import { useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, ListChecks, Sparkles } from "lucide-react";
import type { FitLine, RecordingCandidate, ReleaseCandidate } from "@mm/domain";
import { cn } from "cn";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { SignalsRow } from "#/components/signals-row.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { delta, mmss, pct, short } from "#/lib/format.ts";

const BIG_TONE = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  muted: "text-fg-1",
  primary: "text-primary",
} as const;

interface CommonProps {
  readonly selected: boolean;
  readonly onSelect: (id: string) => void;
}

/**
 * The "preselected" flag.
 *
 * Wrapped in an opaque backdrop rather than placed straight on the card: the badge's own
 * `bg-primary-soft` is translucent, so the card's border ran visibly through the middle of it.
 * `z-10` puts it over the border rather than under (A6 of the owner review).
 */
function PreselectedFlag() {
  return (
    <span className="absolute -top-2 left-3 z-10 rounded-sm bg-background">
      <ToneBadge tone="primary">
        <Sparkles className="size-3" aria-hidden="true" /> preselected
      </ToneBadge>
    </span>
  );
}

/**
 * "why?" and "tracklist fit" — the two disclosures, as real buttons.
 *
 * They used to be bare text with a hover tint and no cursor, so hovering "why?" looked like it
 * did nothing at all (A7). A bordered control with a pressed state says both that it can be
 * clicked and whether it currently is.
 */
function DisclosureButton({
  open,
  label,
  testId,
  icon,
  onToggle,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly testId: string;
  readonly icon?: ReactNode;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-expanded={open}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1 rounded-md border border-line-strong bg-surface-2 px-1.5 py-0.5 text-2xs text-fg-1",
        "hover:border-primary hover:bg-surface-3 hover:text-foreground",
        "focus-visible:border-primary focus-visible:outline-none",
        open && "border-primary bg-primary-soft text-primary",
      )}
    >
      {icon}
      {label}
      <ChevronDown className={cn("size-3", open && "rotate-180")} aria-hidden="true" />
    </button>
  );
}

/** The per-candidate assignment, video by video. */
function TracklistFit({ lines }: { readonly lines: readonly FitLine[] }) {
  if (lines.length === 0) {
    return (
      <p className="mt-2 text-2xs text-fg-2">
        This candidate's tracklist was not fetched, so there is no fit to show. Only the first few
        candidates get a lookup.
      </p>
    );
  }
  return (
    <div data-testid="candidate-fit" className="mt-2 overflow-hidden rounded-md border border-line">
      <table className="w-full text-2xs">
        <thead>
          <tr className="bg-surface-2 text-fg-2">
            <th className="px-2 py-1 text-left font-medium">YouTube video</th>
            <th className="px-2 py-1 text-left font-medium">Track on this release</th>
            <th className="px-2 py-1 text-right font-medium">Δ</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr
              key={`${String(line.videoIndex)}-${line.videoTitle}`}
              className="border-t border-line"
            >
              <td className="max-w-56 truncate px-2 py-1">
                <span className="font-mono text-fg-3">{line.videoIndex + 1}</span> {line.videoTitle}
              </td>
              <td
                className={cn(
                  "max-w-56 truncate px-2 py-1",
                  line.status === "unmatched" && "text-warn",
                )}
              >
                {line.trackPosition === null ? (
                  "not on this release"
                ) : (
                  <>
                    <span className="font-mono text-fg-3">
                      {String(line.trackPosition).padStart(2, "0")}
                    </span>{" "}
                    {line.trackTitle ?? ""}
                  </>
                )}
              </td>
              <td
                className={cn(
                  "px-2 py-1 text-right font-mono",
                  line.delta !== null && Math.abs(line.delta) > 2 ? "text-warn" : "text-fg-2",
                )}
              >
                {delta(line.delta)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* release                                                             */
/* ------------------------------------------------------------------ */

export interface ReleaseCandidateCardProps extends CommonProps {
  readonly candidate: ReleaseCandidate;
}

export function ReleaseCandidateCard({ candidate, selected, onSelect }: ReleaseCandidateCardProps) {
  const [open, setOpen] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const showWhy = open || selected;

  return (
    <div
      data-testid="candidate"
      data-candidate-id={candidate.id}
      data-selected={selected}
      data-preselected={candidate.preselected}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={() => {
        onSelect(candidate.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(candidate.id);
        }
      }}
      className={cn(
        "candidate-grid relative isolate cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3",
        "hover:border-line-strong hover:bg-surface-2",
        selected && "border-primary bg-primary-soft hover:border-primary hover:bg-primary-soft",
      )}
    >
      {candidate.preselected ? <PreselectedFlag /> : null}

      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-full border border-line-strong",
          selected && "border-primary",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>

      {/* The Cover Art Archive's front for this exact release, gradient when it has none. */}
      <Cover
        size="md"
        src={coverArtFront(candidate.id)}
        seed={candidate.id}
        label={candidate.title}
      />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {candidate.title}
          <span className="font-normal text-fg-2">by {candidate.artist}</span>
          {candidate.disambiguation === "" ? null : (
            <ToneBadge outline>{candidate.disambiguation}</ToneBadge>
          )}
          {candidate.secondary.map((secondary) => (
            <ToneBadge key={secondary} tone="danger">
              {secondary}
            </ToneBadge>
          ))}
          {candidate.detailed ? null : (
            <ToneBadge tone="muted" title="No tracklist was fetched, so the fit is unknown.">
              fit not checked
            </ToneBadge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-2.5 text-xs text-fg-2">
          {[
            candidate.date,
            candidate.country,
            candidate.format,
            `${String(candidate.tracks)} tracks`,
            candidate.label,
            candidate.status,
          ]
            .filter((part): part is string => typeof part === "string" && part !== "")
            .map((part, index) => (
              <span key={`${part}-${String(index)}`}>{part}</span>
            ))}
          <span className="font-mono text-fg-3">{short(candidate.id)}…</span>
        </div>

        {showWhy ? (
          <div data-testid="candidate-why" className="mt-2">
            <SignalsRow signals={candidate.signals as unknown as Record<string, number>} />
            <ul className="mt-1.5 list-disc pl-4 text-xs text-fg-1">
              {candidate.why.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
              {candidate.penalties.map((penalty) => (
                <li key={penalty.reason} className="text-warn">
                  {penalty.reason} (−{pct(penalty.amount)})
                </li>
              ))}
            </ul>
            <a
              href={`https://musicbrainz.org/release/${candidate.id}`}
              target="_blank"
              rel="noreferrer"
              onClick={(event) => {
                event.stopPropagation();
              }}
              className="mt-2 inline-flex items-center gap-1 text-2xs text-primary hover:underline"
            >
              <ExternalLink className="size-3" aria-hidden="true" /> Open on MusicBrainz
            </a>
          </div>
        ) : null}

        {fitOpen ? <TracklistFit lines={candidate.fitLines} /> : null}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span
          data-testid="candidate-score"
          className={cn("font-mono text-xl font-semibold", BIG_TONE[scoreTone(candidate.score)])}
        >
          {pct(candidate.score)}
        </span>
        <span className="text-2xs text-fg-2">
          fit{" "}
          <b className="font-mono">
            {candidate.fit}/{candidate.fitOf}
          </b>
          {candidate.durDelta === null ? null : <> · Δ {candidate.durDelta.toFixed(1)}s</>}
        </span>
        <div className="flex flex-wrap justify-end gap-1">
          <DisclosureButton
            testId="fit-toggle"
            label="tracklist fit"
            open={fitOpen}
            icon={<ListChecks className="size-3" aria-hidden="true" />}
            onToggle={() => {
              setFitOpen((current) => !current);
            }}
          />
          <DisclosureButton
            testId="why-toggle"
            label="why?"
            open={showWhy}
            onToggle={() => {
              setOpen((current) => !current);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* recording                                                           */
/* ------------------------------------------------------------------ */

export interface RecordingCandidateCardProps extends CommonProps {
  readonly candidate: RecordingCandidate;
  /** The video's length, so the card can show the difference rather than two numbers. */
  readonly videoSeconds: number | null;
}

export function RecordingCandidateCard({
  candidate,
  selected,
  onSelect,
  videoSeconds,
}: RecordingCandidateCardProps) {
  const [open, setOpen] = useState(false);
  const showWhy = open || selected;
  const difference =
    videoSeconds === null || candidate.length === null ? null : videoSeconds - candidate.length;

  return (
    <div
      data-testid="candidate"
      data-candidate-id={candidate.id}
      data-selected={selected}
      data-preselected={candidate.preselected}
      role="radio"
      aria-checked={selected}
      tabIndex={0}
      onClick={() => {
        onSelect(candidate.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(candidate.id);
        }
      }}
      className={cn(
        "candidate-grid relative isolate cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3",
        "hover:border-line-strong hover:bg-surface-2",
        selected && "border-primary bg-primary-soft",
      )}
    >
      {candidate.preselected ? <PreselectedFlag /> : null}
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-full border border-line-strong",
          selected && "border-primary",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      {/* A recording has no cover of its own; the release it would be filed under has one. */}
      <Cover
        size="md"
        src={coverArtFront(candidate.borrow?.id)}
        seed={candidate.id}
        label={candidate.title}
      />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {candidate.title}
          <span className="font-normal text-fg-2">by {candidate.artist}</span>
          <span className="font-mono font-normal text-fg-2">{mmss(candidate.length)}</span>
          {candidate.isrc === null ? null : (
            <ToneBadge outline className="font-mono">
              {candidate.isrc}
            </ToneBadge>
          )}
          {candidate.disambiguation === "" ? null : (
            <ToneBadge outline>{candidate.disambiguation}</ToneBadge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-2.5 text-xs text-fg-2">
          {candidate.borrow === null ? (
            <span className="text-warn">on no usable release</span>
          ) : (
            <span>
              album tags from <b className="font-medium">{candidate.borrow.title}</b>
              {candidate.borrow.date === null ? null : ` (${candidate.borrow.date.slice(0, 4)})`}
              {candidate.borrow.trackPosition === null
                ? null
                : ` · track ${String(candidate.borrow.trackPosition)}`}
            </span>
          )}
        </div>
        {showWhy ? (
          <div data-testid="candidate-why" className="mt-2">
            <SignalsRow signals={candidate.signals as unknown as Record<string, number>} />
            <ul className="mt-1.5 list-disc pl-4 text-xs text-fg-1">
              {candidate.why.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col items-end gap-1">
        <span
          data-testid="candidate-score"
          className={cn("font-mono text-xl font-semibold", BIG_TONE[scoreTone(candidate.score)])}
        >
          {pct(candidate.score)}
        </span>
        {difference === null ? null : (
          <span className="text-2xs text-fg-2">
            Δ {difference > 0 ? "+" : ""}
            {Math.round(difference)}s
          </span>
        )}
        <ScoreBar value={candidate.score} hideNumber />
        <DisclosureButton
          testId="why-toggle"
          label="why?"
          open={showWhy}
          onToggle={() => {
            setOpen((current) => !current);
          }}
        />
      </div>
    </div>
  );
}
