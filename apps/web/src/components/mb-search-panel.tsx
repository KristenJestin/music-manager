/**
 * The wizard's one box for "the list is wrong, here is what I mean".
 *
 * It replaces a control that had five separate defects, all of which the owner met in one
 * sitting, and which are one experience rather than five patches:
 *
 *  1. **it refused the id people have.** The placeholder said *"paste a recording MBID"* and it
 *     meant it, so a release id — the one on the page anybody would have just been looking at —
 *     came back as "No MusicBrainz recording with id …". The id was right; the *kind* was
 *     wrong, and the message said the opposite;
 *  2. **it said nothing for the id it accepted.** A valid recording id produced no error, no
 *     preview and no new candidate. The owner's question was, verbatim, *"does that mean it
 *     found it and I can hit next???"*. It did not: he had to press a button, and nothing said
 *     so;
 *  3. **it hid the result.** Pressing the button appended the hand-supplied candidate at the
 *     *bottom* of the list, under four irrelevant ones and off screen;
 *  4. **it searched one field with the whole string.** `bewitched Laufey` went into the album
 *     title, so a record MusicBrainz obviously has returned nothing;
 *  5. **and "Nothing found for that"** never said what had been searched for, which is the one
 *     sentence that would have explained (4) instantly.
 *
 * So: two fields, because title and artist is what a person has in their head and what
 * MusicBrainz indexes; an id or a link in the first field is **resolved as it is typed**, with
 * a preview that says what it is and a button that says what pressing it will do; and every
 * state has a visible answer, because a field that swallows valid input and shows nothing is
 * worse than one that refuses.
 *
 * The hand-supplied candidate's *placement* is the caller's job — `StepMatch` puts it at the
 * top of the list, selects it and scrolls to it. This component only reports what was chosen.
 */
import { useEffect, useRef, useState } from "react";
import { Hand, Loader2, Search } from "lucide-react";
import { parseMbRef } from "@mm/domain";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { mmss } from "#/lib/format.ts";
import type { ResolvedRef } from "#/server/services/mb-resolve.ts";

export interface SearchTermsView {
  readonly title: string;
  readonly artist: string | null;
  readonly guessed: boolean;
}

export interface MbSearchPanelProps {
  /** A single wants recordings, an album wants release groups. Only the wording differs here. */
  readonly single: boolean;
  readonly busy: boolean;
  /** Prefilled from the import's own resolved metadata, so the common case is no typing. */
  readonly defaultTitle: string;
  readonly defaultArtist: string;
  /** One gated lookup, no writes. `null` means the field holds no MusicBrainz reference. */
  readonly onResolve: (input: string) => Promise<ResolvedRef | null>;
  /** Do what the preview said. */
  readonly onApply: (input: string) => Promise<void>;
  readonly onSearch: (title: string, artist: string) => Promise<void>;
  /** What the last search actually asked for, so an empty answer can read it back. */
  readonly terms: SearchTermsView | null;
  /** True when the last search returned nothing at all. */
  readonly empty: boolean;
}

/** How long the field is left alone before the lookup goes out. */
const RESOLVE_DEBOUNCE_MS = 400;

export function MbSearchPanel({
  single,
  busy,
  defaultTitle,
  defaultArtist,
  onResolve,
  onApply,
  onSearch,
  terms,
  empty,
}: MbSearchPanelProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [artist, setArtist] = useState(defaultArtist);
  const [ref, setRef] = useState<ResolvedRef | null>(null);
  const [resolving, setResolving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  /** `true` while the first field holds something that parses as an id or a link. */
  const isRef = parseMbRef(title) !== null;

  /*
   * Resolve as you paste.
   *
   * A ref counts the attempts so a slow answer for a string that has since been retyped is
   * dropped rather than painted over the current one — the field is typed into, and the
   * lookups come back in whatever order the gate lets them.
   */
  const attempt = useRef(0);
  useEffect(() => {
    // Nothing to resolve, and nothing to clear: what the panel renders is *derived* from
    // `isRef` below rather than mirrored into state, so this effect never has to undo itself.
    // (An effect that calls `setState` in its body is a cascading render, and the lint rule
    // that says so is right: the clear belongs in the render, where it costs nothing.)
    if (!isRef) return;
    const mine = ++attempt.current;
    const timer = setTimeout(() => {
      setResolving(true);
      setFailed(null);
      void onResolve(title).then(
        (found) => {
          if (attempt.current !== mine) return;
          setRef(found);
          setResolving(false);
        },
        (error: unknown) => {
          if (attempt.current !== mine) return;
          setResolving(false);
          setRef(null);
          setFailed(error instanceof Error ? error.message : "MusicBrainz could not be reached.");
        },
      );
    }, RESOLVE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [title, isRef, onResolve]);

  /* The three derived states. A field holding free text shows none of them. */
  const shown = isRef ? ref : null;
  const busyResolving = isRef && resolving;
  const failure = isRef ? failed : null;

  const canApply = shown !== null && shown.action !== "none" && shown.actionLabel !== null;
  const actionLabel = canApply ? (shown.actionLabel ?? "Use this") : "Search MusicBrainz";
  const disabled =
    busy ||
    busyResolving ||
    title.trim() === "" ||
    (isRef && shown !== null && !canApply) ||
    (isRef && shown === null && failure === null);

  const submit = (): void => {
    if (disabled) return;
    if (canApply) void onApply(title);
    else if (!isRef) void onSearch(title, artist);
  };

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="mb-search-panel">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-64 grow basis-64 flex-col gap-1">
          <span className="text-2xs font-medium text-fg-2">
            {single ? "Track title" : "Album title"}, or a MusicBrainz id or link
          </span>
          <span className="flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-background px-2.5">
            {busyResolving ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-fg-3" aria-hidden="true" />
            ) : (
              <Search className="size-4 shrink-0 text-fg-3" aria-hidden="true" />
            )}
            <input
              data-testid="mb-search"
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder={single ? "Bewitched, or an id / link…" : "Discovery, or an id / link…"}
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-3"
            />
          </span>
        </label>

        {/*
          Hidden while the first field holds an id, because an id names one thing and an artist
          clause beside it would be a contradiction nobody could resolve.
        */}
        {isRef ? null : (
          <label className="flex min-w-40 grow basis-40 flex-col gap-1">
            <span className="text-2xs font-medium text-fg-2">Artist</span>
            <span className="flex h-8 items-center rounded-md border border-line-strong bg-background px-2.5">
              <input
                data-testid="mb-search-artist"
                value={artist}
                onChange={(event) => {
                  setArtist(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder="Laufey"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-3"
              />
            </span>
          </label>
        )}

        <Button
          variant={canApply ? "default" : "outline"}
          size="sm"
          data-testid="mb-search-submit"
          disabled={disabled}
          onClick={submit}
        >
          {canApply ? <Hand className="size-4" aria-hidden="true" /> : null}
          {actionLabel}
        </Button>
      </div>

      {/*
        Every state has a visible answer. `aria-live` because the whole complaint was that
        nothing happened — and "nothing happened" is exactly what a screen reader gets from a
        panel that appears silently.
      */}
      <div aria-live="polite" data-testid="mb-search-status">
        {busyResolving ? (
          <p className="text-2xs text-fg-2">Looking this up on MusicBrainz…</p>
        ) : failure !== null ? (
          <Callout tone="danger" data-testid="mb-search-failed">
            {failure}
          </Callout>
        ) : shown !== null && shown.entity === null ? (
          <Callout tone="danger" data-testid="mb-search-unknown">
            {shown.explanation}
          </Callout>
        ) : shown !== null ? (
          <Callout tone={canApply ? "info" : "warn"} data-testid="mb-search-preview">
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-1.5">
                <ToneBadge tone="info" data-testid="mb-search-entity">
                  {shown.noun ?? "unknown"}
                </ToneBadge>
                <b data-testid="mb-search-title">{shown.title}</b>
                {shown.artist === null || shown.artist === "" ? null : (
                  <span data-testid="mb-search-artist-name">by {shown.artist}</span>
                )}
                <span className="font-mono text-2xs text-fg-2">
                  {[
                    shown.year === null ? null : String(shown.year),
                    shown.lengthSeconds === null ? null : mmss(shown.lengthSeconds),
                    shown.count === null || shown.count === 0
                      ? null
                      : shown.entity === "release"
                        ? `${String(shown.count)} track(s)`
                        : shown.entity === "release-group"
                          ? `${String(shown.count)} edition(s)`
                          : `on ${String(shown.count)} release(s)`,
                    shown.disambiguation,
                  ]
                    .filter((part): part is string => part !== null && part !== "")
                    .join(" · ")}
                </span>
              </span>
              <span className="mt-0.5 block">{shown.explanation}</span>
            </span>
          </Callout>
        ) : terms !== null && empty ? (
          <Callout tone="warn" data-testid="mb-search-empty">
            {/* Never "Nothing found for that" again: the sentence that would have said, at a
                glance, that the artist had been folded into the title. */}
            Nothing matched {describe(terms)}. Try the two fields separately, or paste a MusicBrainz
            id.
          </Callout>
        ) : terms !== null && terms.guessed ? (
          <p className="text-2xs text-fg-2" data-testid="mb-search-terms">
            Searched {describe(terms)} — the artist was read off the dash. Use the two fields if
            that split is wrong.
          </p>
        ) : (
          <p className={cn("text-2xs text-fg-3")}>
            An id or a musicbrainz.org link is looked up as you type, whatever kind it is; free text
            searches {single ? "recordings" : "release groups"}.
          </p>
        )}
      </div>
    </div>
  );
}

function describe(terms: SearchTermsView): string {
  return terms.artist === null || terms.artist === ""
    ? `“${terms.title}”`
    : `“${terms.title}” by “${terms.artist}”`;
}
