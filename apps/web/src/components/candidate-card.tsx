/**
 * One scored candidate, release or recording.
 *
 * The card is the whole of decision 002 made visible: the score is large, the preselection is
 * labelled as a *proposal*, and "why?" opens the signals and the sentences that produced the
 * number. Selecting is a radio — the algorithm ordered the list, you pick from it.
 *
 * The reasons are open by default on the selected card. Somebody comparing two candidates is
 * doing so on the evidence, and making them click twice to see it would be making the
 * argument harder to read than the conclusion.
 */
import { useState } from "react";
import { ChevronDown, ExternalLink, Sparkles } from "lucide-react";
import type { RecordingCandidate, ReleaseCandidate } from "@mm/domain";
import { cn } from "cn";
import { Cover } from "#/components/cover.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { SignalsRow } from "#/components/signals-row.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { mmss, pct, short } from "#/lib/format.ts";

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

/* ------------------------------------------------------------------ */
/* release                                                             */
/* ------------------------------------------------------------------ */

export interface ReleaseCandidateCardProps extends CommonProps {
  readonly candidate: ReleaseCandidate;
}

export function ReleaseCandidateCard({ candidate, selected, onSelect }: ReleaseCandidateCardProps) {
  const [open, setOpen] = useState(false);
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
        "candidate-grid relative cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3",
        "hover:border-line-strong hover:bg-surface-2",
        selected && "border-primary bg-primary-soft hover:border-primary hover:bg-primary-soft",
      )}
    >
      {candidate.preselected ? (
        <ToneBadge tone="primary" className="absolute -top-2 left-3">
          <Sparkles className="size-3" aria-hidden="true" /> preselected
        </ToneBadge>
      ) : null}

      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-full border border-line-strong",
          selected && "border-primary",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>

      <Cover size="md" seed={candidate.id} label={candidate.title} />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {candidate.title}
          <span className="font-normal text-fg-2">— {candidate.artist}</span>
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
        <button
          type="button"
          data-testid="why-toggle"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-2 hover:bg-surface-3 hover:text-foreground"
        >
          why? <ChevronDown className={cn("size-3", showWhy && "rotate-180")} aria-hidden="true" />
        </button>
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
        "candidate-grid relative cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3",
        "hover:border-line-strong hover:bg-surface-2",
        selected && "border-primary bg-primary-soft",
      )}
    >
      {candidate.preselected ? (
        <ToneBadge tone="primary" className="absolute -top-2 left-3">
          <Sparkles className="size-3" aria-hidden="true" /> preselected
        </ToneBadge>
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 place-items-center rounded-full border border-line-strong",
          selected && "border-primary",
        )}
      >
        {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
      </span>
      <Cover size="md" seed={candidate.id} label={candidate.title} />

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          {candidate.title}
          <span className="font-normal text-fg-2">— {candidate.artist}</span>
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
        <button
          type="button"
          data-testid="why-toggle"
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs text-fg-2 hover:bg-surface-3 hover:text-foreground"
        >
          why? <ChevronDown className={cn("size-3", showWhy && "rotate-180")} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
