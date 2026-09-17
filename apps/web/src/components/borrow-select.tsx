/**
 * "Which album should this file belong to?" — where a lone recording gets filed.
 *
 * A single video has no album. It still has to land in a folder, carry album tags and get a
 * track number, so `docs/04` § Recording makes the matcher choose a release to *borrow* that
 * from: album > single > EP > compilation/live, same artist, coherent year. That choice decides
 * the folder name, the `ALBUM`/`ALBUMARTIST` tags and the track index of the file, and the
 * single versus the compilation is a genuine fork with different files on disk at the end.
 *
 * ## What the owner met, and what changed
 *
 * The concept is right and it stays. Everything about how it was put was wrong:
 *
 *  - it was labelled **"Borrow album context from"**, which is the internal term out of
 *    `docs/04` — his reaction was "what is borrow album context". The question on screen is now
 *    the one he is actually answering; the precise phrase lives in the help text below, where
 *    it belongs;
 *  - the consequence was *described* — "This is the album folder, the album tags and the track
 *    number the file ends up with" — rather than shown. A sentence about a path is not a path.
 *    Each option now renders the **actual** destination, through `renderPathTemplate`, the same
 *    pure function `place` uses, from the settings that will be in force. Two albums, two
 *    visibly different paths;
 *  - and the alternatives were **hidden inside a dropdown**, so the second option existing at
 *    all was something you learned by clicking. Two or three options are a visible choice; the
 *    select comes back above `AS_LIST_UP_TO`, and the count is said either way.
 */
import {
  renderPathTemplate,
  type BorrowRelease,
  type DiscMode,
  type SanitizeMode,
} from "@mm/domain";
import { cn } from "cn";
import { MbLink } from "#/components/mb-link.tsx";
import { borrowFacts, distinguishingBorrow, type FactKey } from "#/components/release-facts.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";

/** Up to this many options are shown as a list; above it, a select. */
const AS_LIST_UP_TO = 4;

/** `Klangsberg — single, 2018, XW, Digital Media, track 1/1`. */
export function borrowLabel(release: BorrowRelease): string {
  const parts = [
    release.type ?? "release",
    release.date === null ? null : release.date.slice(0, 4),
    release.country,
    // The discs, because eighteen soundtrack variants include a 2 × CD and telling it from the
    // single disc is half the question.
    release.format === null
      ? null
      : release.mediumCount > 1
        ? `${String(release.mediumCount)} × ${release.format}`
        : release.format,
    release.trackPosition === null
      ? null
      : `track ${String(release.trackPosition)}${release.trackCount === null ? "" : `/${String(release.trackCount)}`}`,
  ].filter((part): part is string => typeof part === "string" && part !== "");
  return `${release.title} — ${parts.join(", ")}`;
}

/** The facts `borrowLabel` already prints, so the second line never repeats one. */
const ON_THE_LABEL: readonly FactKey[] = ["date", "country", "discs", "tracks"];

/** At most this many facts on the second line — the same reasoning as the card's row. */
const DETAIL_FACTS = 4;

/**
 * The second line of an option: what tells *this* release from the other seventeen.
 *
 * The owner's screenshot is eighteen *Arcane: League of Legends* soundtrack variants, and the
 * dropdown printed eighteen copies of one truncated title. The titles are identical because
 * they genuinely are the same record; the catalogue number, the barcode, the country and the
 * disambiguation comment are not, and those are already on every release document the borrow
 * ladder scored. So the option says the same thing a candidate card's compact row says —
 * `distinguishingBorrow` decides which facts, by the same rule.
 *
 * Empty when there is genuinely nothing to tell them apart, which is the only honest answer
 * and never happens with eighteen of them.
 */
export function borrowDetail(release: BorrowRelease, differs: ReadonlySet<FactKey>): string {
  return borrowFacts(release)
    .filter((fact) => differs.has(fact.key) && !ON_THE_LABEL.includes(fact.key))
    .slice(0, DETAIL_FACTS)
    .map((fact) => (fact.raw === null ? fact.absent : fact.text))
    .join(" · ");
}

/** Everything `renderPathTemplate` needs that does not come from the release being chosen. */
export interface FilingPreview {
  readonly template: string;
  readonly discMode: DiscMode;
  readonly sanitize: SanitizeMode;
  readonly extension: string;
  /** The credited artist of the recording — the album artist of the file. */
  readonly artist: string;
  /** The recording's title, which is the file's `{title}`. */
  readonly title: string;
}

/**
 * Where this file lands if that release is the one borrowed from.
 *
 * Computed with the renderer rather than described, so what the wizard promises and what
 * `place` does cannot drift: it is the same function, the same template and the same sanitise
 * mode.
 */
function pathFor(release: BorrowRelease, filing: FilingPreview): string {
  return renderPathTemplate(
    filing.template,
    {
      albumArtist: filing.artist,
      album: release.title,
      // `undefined`, not `null`: the template input says "absent" with the key missing, and an
      // undated release must render the `({year})` group away rather than as "NaN".
      ...(release.date === null
        ? {}
        : { year: Number.parseInt(release.date.slice(0, 4), 10) || undefined }),
      trackNumber: release.trackPosition ?? 1,
      title: filing.title,
      extension: filing.extension,
    },
    { discMode: filing.discMode, mode: filing.sanitize },
  );
}

/** The album tags and the track number this choice produces, as one line. */
function tagsFor(release: BorrowRelease): string {
  const track =
    release.trackPosition === null
      ? "no track number"
      : `track ${String(release.trackPosition)}${release.trackCount === null ? "" : ` of ${String(release.trackCount)}`}`;
  return `ALBUM “${release.title}” · ${track}`;
}

export function BorrowSelect({
  releases,
  value,
  onChange,
  disabled = false,
  filing = null,
}: {
  readonly releases: readonly BorrowRelease[];
  /** The chosen release MBID, or `null` to follow the engine's preference. */
  readonly value: string | null;
  readonly onChange: (releaseMbid: string) => void;
  readonly disabled?: boolean;
  /** Absent on a screen that has no settings to render a path from; the labels still work. */
  readonly filing?: FilingPreview | null;
}) {
  const hydrated = useHydrated();
  /*
   * Which facts are not the same across these options — the same comparison the candidate
   * cards make inside a release group, because this is the same question in a smaller box.
   */
  const differs = distinguishingBorrow(releases);
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

  const question = "Which album should this file belong to?";
  const help = (
    <span className="text-2xs text-fg-3">
      {releases.length === 1
        ? "One album carries this recording, so there is nothing to choose."
        : `${String(releases.length)} albums carry this recording.`}{" "}
      The one you pick supplies the folder, the <code className="font-mono">ALBUM</code> tags and
      the track number — what <code className="font-mono">docs/04</code> calls the borrowed album
      context.
    </span>
  );

  /* ---- few enough to show: a visible choice, not a menu ---- */

  if (releases.length <= AS_LIST_UP_TO) {
    return (
      <div className="flex flex-col gap-1.5" data-testid="borrow" data-shape="list">
        <span className="text-2xs font-medium text-fg-2">{question}</span>
        <div role="radiogroup" aria-label={question} className="flex flex-col gap-1.5">
          {releases.map((release) => {
            const active = chosen?.id === release.id;
            return (
              <button
                key={release.id}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled || !hydrated}
                data-testid="borrow-option"
                data-release-id={release.id}
                data-active={active}
                onClick={(event) => {
                  event.stopPropagation();
                  onChange(release.id);
                }}
                className={cn(
                  "flex flex-col gap-0.5 rounded-md border border-line bg-background px-2.5 py-1.5 text-left",
                  active && "border-primary bg-primary-soft",
                )}
              >
                <span className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-3 shrink-0 place-items-center rounded-full border border-line-strong",
                      active && "border-primary",
                    )}
                  >
                    {active ? <span className="size-1.5 rounded-full bg-primary" /> : null}
                  </span>
                  {borrowLabel(release)}
                </span>
                {borrowDetail(release, differs) === "" ? null : (
                  <span
                    data-testid="borrow-detail"
                    className="block truncate text-2xs text-primary"
                  >
                    {borrowDetail(release, differs)}
                  </span>
                )}
                {/* The consequence, computed. This is what makes the fork readable: two albums
                    produce two visibly different paths rather than the same sentence twice. */}
                <span
                  className="block truncate font-mono text-2xs text-fg-2"
                  data-testid="borrow-path"
                >
                  {filing === null ? tagsFor(release) : pathFor(release, filing)}
                </span>
                {filing === null ? null : (
                  <span className="block truncate text-2xs text-fg-3">{tagsFor(release)}</span>
                )}
              </button>
            );
          })}
        </div>
        {/* Outside the radios: an anchor inside a button is invalid HTML, and the option is the
            button. */}
        {chosen === null ? null : (
          <MbLink
            kind="release"
            mbid={chosen.id}
            truncate
            label="release"
            data-testid="borrow-mb"
          />
        )}
        {help}
      </div>
    );
  }

  /* ---- too many to show: the select, with the same consequence underneath ---- */

  return (
    <label className="flex flex-col gap-1" data-testid="borrow" data-shape="select">
      <span className="text-2xs font-medium text-fg-2">{question}</span>
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
          aria-label={question}
          className="w-full max-w-borrow rounded-md border-line-strong bg-background text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {chosen === null ? "none" : borrowLabel(chosen)}
          </span>
        </SelectTrigger>
        {/* Wider than the trigger: eighteen pressings that differ by a catalogue number cannot
            be told apart through an ellipsis. */}
        <SelectContent className="w-auto max-w-borrow-menu min-w-(--anchor-width) text-xs">
          {/*
            Two lines per option, not a truncated title.
            Eighteen options whose first line is identical is a list of one option; the second
            line is the catalogue number, the barcode, the country — whatever `differs` says is
            not shared — so the list is scannable at the length it actually reaches.
          */}
          {releases.map((release) => (
            <SelectItem key={release.id} value={release.id} className="text-xs">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate">{borrowLabel(release)}</span>
                {borrowDetail(release, differs) === "" ? null : (
                  <span data-testid="borrow-detail" className="truncate text-2xs text-fg-2">
                    {borrowDetail(release, differs)}
                  </span>
                )}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {chosen === null ? null : (
        <span className="block truncate font-mono text-2xs text-fg-2" data-testid="borrow-path">
          {filing === null ? tagsFor(chosen) : pathFor(chosen, filing)}
        </span>
      )}
      {/* The chosen option's own page, so "which of the eighteen is this?" is one click and
          not a guess. */}
      {chosen === null ? null : (
        <MbLink kind="release" mbid={chosen.id} truncate label="release" data-testid="borrow-mb" />
      )}
      {help}
    </label>
  );
}
