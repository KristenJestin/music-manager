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
import { Check, CirclePlay, ExternalLink, ListVideo, Scissors, Sparkles } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { Kbd } from "#/components/kbd.tsx";
import { MbLink } from "#/components/mb-link.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { humanise, mmss } from "#/lib/format.ts";
import type { InboxCard, InboxOption } from "#/server/functions/inbox.ts";

export interface ReviewCardProps {
  readonly card: InboxCard;
  readonly busy: boolean;
  readonly onConfirm: (option: InboxOption) => void;
  /** Relaunch the import pinned to a release the reader pasted. */
  readonly onPin: (release: string) => void;
  /** Relaunch the search under the album title without its edition qualifier. */
  readonly onDropQualifier: () => void;
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
  mediumPosition: number;
  title: string;
  lengthSeconds: number | null;
}[] {
  const raw = payload["tracks"];
  if (Array.isArray(raw)) {
    return raw.map((entry) => {
      const track = entry as Record<string, unknown>;
      return {
        position: typeof track["position"] === "number" ? track["position"] : 0,
        mediumPosition: typeof track["mediumPosition"] === "number" ? track["mediumPosition"] : 1,
        title: typeof track["title"] === "string" ? track["title"] : "unknown track",
        lengthSeconds: typeof track["lengthSeconds"] === "number" ? track["lengthSeconds"] : null,
      };
    });
  }
  const positions = payload["positions"];
  if (!Array.isArray(positions)) return [];
  return positions
    .filter((position): position is number => typeof position === "number")
    .map((position) => ({
      position,
      mediumPosition: 1,
      title: "not covered by any video",
      lengthSeconds: null,
    }));
}

/**
 * The two sides of a `fingerprint_mismatch`, as `steps/fingerprint.ts` writes them.
 *
 * `expected` is the binding you confirmed, `heard` is the recording AcoustID names. The
 * prototype (`prototypes/A-console`, the `fingerprint_mismatch` branch of the Review page)
 * shows them side by side, and it is right to: the question is not "do you accept?" but
 * "which of these two is the track in this file?", and that is a comparison, not a sentence.
 */
function fingerprintSides(payload: Record<string, unknown>): {
  expected: { title: string; recordingMbid: string | null };
  heard: { title: string; recordingMbid: string | null; score: number | null };
} | null {
  const expected = payload["expected"];
  const heard = payload["heard"];
  if (typeof expected !== "object" || expected === null) return null;
  if (typeof heard !== "object" || heard === null) return null;
  const left = expected as Record<string, unknown>;
  const right = heard as Record<string, unknown>;
  const text = (value: unknown, fallback: string): string =>
    typeof value === "string" && value.trim() !== "" ? value : fallback;
  const mbid = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return {
    expected: {
      title: text(left["title"], "the track you confirmed"),
      recordingMbid: mbid(left["recordingMbid"]),
    },
    heard: {
      title: text(right["title"], "nothing it recognises"),
      recordingMbid: mbid(right["recordingMbid"]),
      score: typeof right["score"] === "number" ? right["score"] : null,
    },
  };
}

/**
 * The MusicBrainz entity an answer names, when it names one.
 *
 * An `ambiguous_release` option *is* a release id and an `ambiguous_recording` option *is* a
 * recording id — that is what `optionsFor` writes into `value`, and what a `decisions` row
 * ends up carrying. Reading it back here is how the card links to the record instead of
 * describing it in four fields and leaving the reader to search for it.
 */
function mbEntityOf(option: InboxOption): { kind: "release" | "recording"; mbid: string } | null {
  const release = option.value["releaseMbid"];
  const recording = option.value["recordingMbid"];
  if (typeof recording === "string" && recording !== "") {
    return { kind: "recording", mbid: recording };
  }
  if (typeof release === "string" && release !== "") return { kind: "release", mbid: release };
  return null;
}

function extraVideos(payload: Record<string, unknown>): { title: string }[] {
  const raw = payload["videos"];
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const video = entry as Record<string, unknown>;
    return { title: typeof video["title"] === "string" ? video["title"] : "unknown video" };
  });
}

/**
 * The link back to where the audio is.
 *
 * The review screen contained not one link, though the payload has carried the address all
 * along — and deciding between two editions means listening to the video, which is the natural
 * gesture and was impossible without copying an id by hand. New tab, always: the queue is a
 * place you stay in, and a decision you navigated away from is a decision you retake.
 */
function SourceLink({ link }: { readonly link: NonNullable<InboxCard["source"]> }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      data-testid="review-source"
      data-source-kind={link.kind}
      title={link.label}
      className="inline-flex items-center gap-1 rounded-md border border-line bg-background px-2 py-0.5 text-2xs text-fg-2 hover:border-primary hover:text-primary"
    >
      {link.kind === "playlist" ? (
        <ListVideo className="size-3" aria-hidden="true" />
      ) : (
        <CirclePlay className="size-3" aria-hidden="true" />
      )}
      {link.kind === "playlist" ? "Source playlist" : "Source video"}
      <ExternalLink className="size-3" aria-hidden="true" />
      <span className="sr-only">(opens YouTube in a new tab)</span>
    </a>
  );
}

/**
 * What a card with nothing to choose between offers instead of "Cancel this import".
 *
 * Both buttons relaunch the *same* import through the same door the pipeline already has —
 * `imports.options.releaseMbid`, the field `mm import --release <mbid>` writes, and a stated
 * album title the matcher prefers over the one it derives from the videos' tags. Neither is a
 * second way of importing something.
 *
 * The field is a plain `<input>` and Enter inside it submits *this* form and nothing else: the
 * card's global Enter handler ignores keystrokes whose target is an input, which is what keeps
 * "Enter accepts the preselection" from meaning "Enter cancels this import" while somebody is
 * typing an id into it.
 */
function NoCandidatePanel({
  card,
  busy,
  onPin,
  onDropQualifier,
}: {
  readonly card: InboxCard;
  readonly busy: boolean;
  readonly onPin: (release: string) => void;
  readonly onDropQualifier: () => void;
}) {
  const [pasted, setPasted] = useState("");
  const base = card.editionBaseTitle;

  return (
    <div
      data-testid="no-candidate-panel"
      className="flex flex-col gap-2.5 rounded-md border border-line bg-background p-3"
    >
      <Callout tone="info">
        MusicBrainz returned nothing for this title. Either name the release yourself, or search
        again without the edition the source added to it.
      </Callout>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && pasted.trim() !== "") onPin(pasted);
        }}
      >
        <label className="flex min-w-56 grow flex-col gap-1">
          <span className="text-2xs font-semibold tracking-wider text-fg-2 uppercase">
            MusicBrainz release id
          </span>
          <Input
            data-testid="pin-release-input"
            value={pasted}
            disabled={busy}
            placeholder="0cbe4a8e-… or https://musicbrainz.org/release/…"
            onChange={(event) => {
              setPasted(event.target.value);
            }}
          />
        </label>
        <Button
          type="submit"
          data-testid="pin-release-submit"
          disabled={busy || pasted.trim() === ""}
        >
          <Check className="size-4" aria-hidden="true" />
          {busy ? "Saving…" : "Import this release"}
        </Button>
      </form>
      <p className="text-2xs text-fg-3">
        The id or the whole musicbrainz.org address — both are read. The import restarts at{" "}
        <code className="font-mono">match</code>, pinned to it.
      </p>

      {base === null ? (
        <p data-testid="drop-qualifier-absent" className="text-2xs text-fg-3">
          This title carries no edition qualifier to drop.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            data-testid="drop-qualifier"
            disabled={busy}
            onClick={onDropQualifier}
          >
            <Scissors className="size-4" aria-hidden="true" />
            Search without the edition qualifier
          </Button>
          <span className="text-2xs text-fg-2">
            searches for <span className="font-medium text-fg-1">“{base}”</span>
          </span>
        </div>
      )}
    </div>
  );
}

export function ReviewCard({ card, busy, onConfirm, onPin, onDropQualifier }: ReviewCardProps) {
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
  const uncoveredDiscs = new Set(uncovered.map((track) => track.mediumPosition)).size;
  const extras = item.type === "extra_videos" ? extraVideos(item.payload) : [];
  const sides = item.type === "fingerprint_mismatch" ? fingerprintSides(item.payload) : null;

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
          {card.source === null ? null : <SourceLink link={card.source} />}
          {card.job?.releaseMbid == null ? null : (
            <MbLink kind="release" mbid={card.job.releaseMbid} truncate />
          )}
        </div>
        {item.summary === null ? null : <p className="text-fg-1">{item.summary}</p>}

        {card.noCandidate ? (
          <NoCandidatePanel
            card={card}
            busy={busy}
            onPin={onPin}
            onDropQualifier={onDropQualifier}
          />
        ) : null}

        {uncovered.length === 0 ? null : (
          <div className="rounded-md border border-line bg-background p-3">
            <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-fg-2 uppercase">
              Uncovered release tracks
            </h3>
            <table className="w-full text-xs">
              <tbody>
                {uncovered.map((track) => (
                  <tr
                    key={`${String(track.mediumPosition)}-${String(track.position)}-${track.title}`}
                  >
                    <td className="py-0.5 pr-3 font-mono text-fg-3">
                      {/* A position without its disc names two tracks on a two-disc record. */}
                      {uncoveredDiscs > 1 ? `${String(track.mediumPosition)}-` : ""}
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

        {sides === null ? null : (
          <div className="split-even-grid" data-testid="fingerprint-sides">
            <div className="rounded-md border border-line bg-background p-3">
              <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-fg-2 uppercase">
                Mapping — what you confirmed
              </h3>
              <div className="text-xs font-medium">{sides.expected.title}</div>
              {/* The id was printed as bare text on both sides, which is the "copy an id by
                  hand" the review screen was full of. `MbLink` is the Console's one answer to
                  "how do we link to musicbrainz.org". */}
              <MbLink
                kind="recording"
                mbid={sides.expected.recordingMbid}
                missing="no recording MBID"
              />
            </div>
            <div className="rounded-md border border-line bg-background p-3">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider text-fg-2 uppercase">
                AcoustID — what the file sounds like
                {sides.heard.score === null ? null : (
                  <ToneBadge tone={sides.heard.score >= 0.9 ? "danger" : "warn"}>
                    score {sides.heard.score.toFixed(2)}
                  </ToneBadge>
                )}
              </h3>
              <div className="text-xs font-medium">{sides.heard.title}</div>
              <MbLink
                kind="recording"
                mbid={sides.heard.recordingMbid}
                missing="no recording MBID"
              />
            </div>
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
          {options.map((option) => {
            const entity = mbEntityOf(option);
            return (
              <div key={option.id} className="flex items-center gap-2">
                <button
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
                {/*
              Beside the radio, never inside it: an anchor nested in a button is neither valid
              markup nor reachable by keyboard. A candidate is a MusicBrainz release, and
              choosing between two pressings is the one decision that genuinely needs the
              record in front of you.
            */}
                {entity === null ? null : (
                  <MbLink
                    kind={entity.kind}
                    mbid={entity.mbid}
                    truncate
                    data-testid="review-option-mb"
                    className="shrink-0"
                  />
                )}
              </div>
            );
          })}
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
