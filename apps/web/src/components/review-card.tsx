/**
 * The decision card.
 *
 * `docs/decisions.md` 002, as one component: the question, what the algorithm would answer,
 * the alternatives, and Enter to accept. The preselected option is chosen when the card opens,
 * so the fast path — read the summary, press Enter — is one keystroke, and the slow path is
 * the same card with a different radio.
 *
 * `↵` is bound here rather than in the shell because it only means something where there *is*
 * a preselection; a global Enter handler would fire on every page and mean nothing on most.
 */
import { useEffect, useState } from "react";
import { Check, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Cover } from "#/components/cover.tsx";
import { Kbd } from "#/components/kbd.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { humanise, mmss } from "#/lib/format.ts";
import type { InboxCard, InboxOption } from "#/server/functions/inbox.ts";

export interface ReviewCardProps {
  readonly card: InboxCard;
  readonly busy: boolean;
  readonly onConfirm: (option: InboxOption) => void;
}

/**
 * The tracks of an `uncovered_tracks` payload, in either of the two shapes the step writes.
 *
 * The matcher's own proposal carries whole tracks; a *supplied* mapping — what the wizard
 * sends — only knows which positions it left uncovered, because it never looked the tracklist
 * up. Both are rendered; the second simply has no titles to show.
 */
function uncoveredTracks(payload: Record<string, unknown>): {
  position: number;
  title: string;
  lengthSeconds: number | null;
}[] {
  const raw = payload["tracks"];
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      const track = entry as Record<string, unknown>;
      return {
        position: typeof track["position"] === "number" ? track["position"] : 0,
        title: typeof track["title"] === "string" ? track["title"] : "unknown track",
        lengthSeconds: typeof track["lengthSeconds"] === "number" ? track["lengthSeconds"] : null,
      };
    });
  }
  const positions = payload["positions"];
  if (!Array.isArray(positions)) return [];
  return positions
    .filter((position): position is number => typeof position === "number")
    .map((position) => ({ position, title: "not covered by any video", lengthSeconds: null }));
}

function extraVideos(payload: Record<string, unknown>): { title: string }[] {
  const raw = payload["videos"];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const video = entry as Record<string, unknown>;
    return { title: typeof video["title"] === "string" ? video["title"] : "unknown video" };
  });
}

export function ReviewCard({ card, busy, onConfirm }: ReviewCardProps) {
  const { item, options } = card;
  /*
   * The preselection is the initial state, not an effect.
   *
   * `ReviewScreen` mounts this component with `key={item.id}`, so moving to the next item
   * remounts it and this initialiser runs again. Synchronising a prop into state with an
   * effect would render the previous item's answer for one frame — long enough to press Enter
   * on the wrong one.
   */
  const [chosen, setChosen] = useState(
    () => options.find((option) => option.preselected)?.id ?? options[0]?.id ?? "",
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Enter" || busy) return;
      const target = event.target;
      if (target instanceof HTMLElement && ["INPUT", "TEXTAREA"].includes(target.tagName)) return;
      const option = options.find((entry) => entry.id === chosen);
      if (option === undefined) return;
      event.preventDefault();
      onConfirm(option);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [chosen, options, onConfirm, busy]);

  const uncovered = item.type === "uncovered_tracks" ? uncoveredTracks(item.payload) : [];
  const extras = item.type === "extra_videos" ? extraVideos(item.payload) : [];

  return (
    <div
      data-testid="review-card"
      data-item-id={item.id}
      data-item-type={item.type}
      className="review-card-grid items-start gap-3.5 self-start rounded-xl border border-line bg-surface-1 p-3.5"
    >
      <Cover size="md" seed={item.id} label={item.title} />
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold">{item.title}</h2>
          <ToneBadge tone="warn">{humanise(item.type)}</ToneBadge>
          {card.job === null ? null : (
            <span className="font-mono text-2xs text-fg-3">job {card.job.id}</span>
          )}
        </div>
        {item.summary === null ? null : <p className="text-fg-1">{item.summary}</p>}

        {uncovered.length === 0 ? null : (
          <div className="rounded-md border border-line bg-background p-3">
            <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-fg-2 uppercase">
              Uncovered release tracks
            </h3>
            <table className="w-full text-xs">
              <tbody>
                {uncovered.map((track) => (
                  <tr key={`${String(track.position)}-${track.title}`}>
                    <td className="py-0.5 pr-3 font-mono text-fg-3">
                      {String(track.position).padStart(2, "0")}
                    </td>
                    <td className="py-0.5">{track.title}</td>
                    <td className="py-0.5 text-right font-mono text-fg-2">
                      {mmss(track.lengthSeconds)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {extras.length === 0 ? null : (
          <div className="rounded-md border border-line bg-background p-3 text-xs">
            <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-fg-2 uppercase">
              Videos outside the tracklist
            </h3>
            <ul className="list-disc pl-4">
              {extras.map((video) => (
                <li key={video.title}>{video.title}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="Answers">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={chosen === option.id}
              data-testid="review-option"
              data-option-id={option.id}
              onClick={() => {
                setChosen(option.id);
              }}
              className={cn(
                "flex items-center gap-2.5 rounded-md border border-line bg-background px-2.5 py-2 text-left",
                chosen === option.id && "border-primary bg-primary-soft",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "grid size-3.5 shrink-0 place-items-center rounded-full border border-line-strong",
                  chosen === option.id && "border-primary",
                )}
              >
                {chosen === option.id ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block">{option.label}</span>
                {option.detail === undefined || option.detail === "" ? null : (
                  <span className="block text-2xs text-fg-2">{option.detail}</span>
                )}
              </span>
              {option.score === undefined ? null : <ScoreBar value={option.score} />}
              {option.preselected ? (
                <ToneBadge tone="primary">
                  <Sparkles className="size-3" aria-hidden="true" /> preselected
                </ToneBadge>
              ) : null}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            data-testid="review-confirm"
            disabled={busy}
            onClick={() => {
              const option = options.find((entry) => entry.id === chosen);
              if (option !== undefined) onConfirm(option);
            }}
          >
            <Check className="size-4" aria-hidden="true" />
            {busy ? "Saving…" : "Confirm & resume"}
            <Kbd className="ml-1">Enter</Kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
