/**
 * What actually separates two pressings of the same record.
 *
 * The owner's words, faced with a list of release groups: *"impossible for me to know what to
 * choose here."* He was right, and the reason is arithmetic rather than taste. A row gave a
 * title, an artist, a year, a count of releases and a best track count — and two pressings of
 * one album agree on **all five**. The card was showing the facts the two candidates share and
 * hiding the ones that tell them apart.
 *
 * So this module owns one list, `releaseFacts`, and one comparison, `distinguishing`:
 *
 *  - **`releaseFacts`** is every fact MusicBrainz already gave us about a pressing — the date
 *    in full rather than its year, the country, the discs and their formats, the track count
 *    per disc, the label and its catalogue number, the barcode, the status, the packaging, the
 *    disambiguation comment and whether the Cover Art Archive has a front. Nothing here costs a
 *    request: `label-info`, `media[].track-count`, `barcode`, `packaging` and
 *    `cover-art-archive` all ride along on documents the matcher already fetches.
 *  - **`distinguishing`** takes the pressings that are on screen together and returns the keys
 *    whose values are *not* all the same. That is what keeps the common case quiet: four
 *    identical CDs print four identical short rows, and the moment two of them differ by a
 *    barcode alone, the barcode appears on both — including on the one that has none, as
 *    "no barcode", because "one has a barcode and the other does not" is the answer and an
 *    omitted line is not.
 *
 * The compact row is therefore *derived*, never configured: four facts that are always worth
 * reading (date, country, discs, tracks) plus whatever else differs here. The full set is one
 * disclosure away.
 */
import type { BorrowRelease, ReleaseCandidate, ReleaseMedium } from "@mm/domain";
import { cn } from "cn";

/** The facts a pressing has, in the order they are printed. */
export type FactKey =
  | "date"
  | "country"
  | "discs"
  | "tracks"
  | "label"
  | "catalogue"
  | "barcode"
  | "status"
  | "packaging"
  | "comment"
  | "cover";

/** The four that are on the compact row whether or not they differ. */
const ALWAYS: readonly FactKey[] = ["date", "country", "discs", "tracks"];

export interface ReleaseFact {
  readonly key: FactKey;
  /** The name of the fact, for the detail table and for the accessible name of the row item. */
  readonly label: string;
  /**
   * The value as a comparable string, or `null` when MusicBrainz has none.
   *
   * `null` is a value for comparison purposes: a pressing with no barcode differs from one
   * with a barcode, and that difference is the whole point of the module.
   */
  readonly raw: string | null;
  /** What the row prints when there is a value. */
  readonly text: string;
  /** What the row prints when there is none and the fact is one of the distinguishing ones. */
  readonly absent: string;
}

/** `2 × CD`, `CD + DVD`, `Digital Media`. */
export function describeMedia(
  media: readonly ReleaseMedium[],
  fallback: string | null,
): string | null {
  if (media.length === 0) return fallback;
  const formats = media.map((medium) => medium.format ?? "unknown format");
  const distinct = [...new Set(formats)];
  if (distinct.length === 1) {
    const only = distinct[0] ?? "";
    return media.length === 1 ? only : `${String(media.length)} × ${only}`;
  }
  return formats.join(" + ");
}

/** `21 tracks (12 + 9)` on two discs, `14 tracks` on one. */
export function describeTracks(total: number, media: readonly ReleaseMedium[]): string {
  const plural = `${String(total)} track${total === 1 ? "" : "s"}`;
  if (media.length < 2) return plural;
  return `${plural} (${media.map((medium) => String(medium.trackCount)).join(" + ")})`;
}

/**
 * Every fact about one pressing, present or absent.
 *
 * The cover is three-valued on purpose and says so: a release nobody looked up has no answer at
 * all, which is not the same as MusicBrainz having no picture for it (decision 167).
 */
export function releaseFacts(candidate: ReleaseCandidate): ReleaseFact[] {
  const discs = describeMedia(candidate.media, candidate.format);
  const cover =
    candidate.coverArt === null
      ? null
      : candidate.coverArt.front
        ? "front"
        : candidate.coverArt.available
          ? "images, no front"
          : "none";

  return [
    {
      key: "date",
      label: "Release date",
      raw: candidate.date,
      text: candidate.date ?? "",
      absent: "no date",
    },
    {
      key: "country",
      label: "Country",
      raw: candidate.country,
      text: candidate.country ?? "",
      absent: "no country",
    },
    {
      key: "discs",
      label: "Format",
      raw: discs,
      text: discs ?? "",
      absent: "no format",
    },
    {
      key: "tracks",
      label: "Tracks",
      // The per-disc breakdown is part of the comparison: 21 on one disc and 12 + 9 on two are
      // the same `tracks` and a different record to file.
      raw: candidate.media.map((medium) => String(medium.trackCount)).join("+") || null,
      text: describeTracks(candidate.tracks, candidate.media),
      absent: `${String(candidate.tracks)} tracks`,
    },
    {
      key: "label",
      label: "Label",
      raw: candidate.label,
      text: candidate.label ?? "",
      absent: "no label",
    },
    {
      key: "catalogue",
      label: "Catalogue number",
      raw: candidate.catalogNumber,
      text: candidate.catalogNumber ?? "",
      absent: "no catalogue number",
    },
    {
      key: "barcode",
      label: "Barcode",
      raw: candidate.barcode,
      text: candidate.barcode ?? "",
      absent: "no barcode",
    },
    {
      key: "status",
      label: "Status",
      raw: candidate.status,
      text: candidate.status ?? "",
      absent: "no status",
    },
    {
      key: "packaging",
      label: "Packaging",
      raw: candidate.packaging,
      text: candidate.packaging ?? "",
      absent: "no packaging",
    },
    {
      key: "comment",
      label: "Disambiguation",
      raw: candidate.disambiguation === "" ? null : candidate.disambiguation,
      text: candidate.disambiguation,
      absent: "no comment",
    },
    {
      key: "cover",
      label: "Cover art",
      raw: cover,
      text:
        cover === "front"
          ? "front cover"
          : cover === "images, no front"
            ? "images, no front cover"
            : "no cover art",
      absent: "cover not checked",
    },
  ];
}

/**
 * The keys whose value is not the same across every pressing shown together.
 *
 * Compared on `raw`, so "absent" is a value: the pair the owner could not tell apart — same
 * album, same label, same country, one barcode — comes back as `{"barcode"}` and both cards
 * print their barcode, one of them as "no barcode".
 *
 * One pressing on its own distinguishes nothing: there is nothing to tell it apart *from*, and
 * marking all eleven facts would be the noise this exists to avoid.
 */
export function distinguishing(candidates: readonly ReleaseCandidate[]): ReadonlySet<FactKey> {
  const out = new Set<FactKey>();
  if (candidates.length < 2) return out;
  const columns = candidates.map(releaseFacts);
  const first = columns[0];
  if (first === undefined) return out;
  for (const [index, fact] of first.entries()) {
    const differs = columns.some((column) => column[index]?.raw !== fact.raw);
    if (differs) out.add(fact.key);
  }
  return out;
}

/**
 * How many *extra* facts the compact row will carry beyond the four that always read.
 *
 * Three, and the number matters. Discovery's release group holds twenty-three pressings that
 * differ on every one of the eleven facts, so "show everything that differs" prints eleven
 * items on a line and marks all eleven — which is the owner's original complaint rendered in
 * amber. Three is enough for the case the cap exists to serve (a pair that differs by one
 * thing shows that one thing) and short enough that a shelf of pressings stays a list. The
 * rest is the `details` disclosure, which is why that exists.
 *
 * The order is `releaseFacts`' own, so the three are the label, the catalogue number and the
 * barcode — the three a record collector reads off a sleeve, in that order.
 */
const ROW_EXTRAS = 3;

/**
 * The compact row: the four that always read, plus what tells this pressing from its siblings.
 *
 * A distinguishing fact with no value is kept and printed as its `absent` wording — "one has a
 * barcode and the other does not" is the answer, and an omitted line is not — while a
 * non-distinguishing one with no value is dropped, because "no barcode · no packaging · no
 * comment" on four identical CDs is the noise the owner already has.
 */
export function rowFacts(
  candidate: ReleaseCandidate,
  differs: ReadonlySet<FactKey>,
): ReleaseFact[] {
  const all = releaseFacts(candidate);
  const base = all.filter((fact) => ALWAYS.includes(fact.key) && fact.raw !== null);
  const extras = all
    .filter((fact) => !ALWAYS.includes(fact.key) && differs.has(fact.key))
    .slice(0, ROW_EXTRAS);
  return [...base, ...extras];
}

/**
 * One fact, as the compact row draws it.
 *
 * Only the extras are tinted. The four that are always there say nothing by being there, so
 * colouring the ones that happen to differ would tint most of most rows; an extra is on the
 * row *because* it differs, and the tint says which reading is the reason.
 */
function FactItem({ fact, marked }: { readonly fact: ReleaseFact; readonly marked: boolean }) {
  return (
    <span
      data-testid="candidate-fact"
      data-fact={fact.key}
      data-distinguishing={marked}
      title={
        marked ? `${fact.label} — this is what tells this pressing from the others` : fact.label
      }
      className={cn(
        "whitespace-nowrap",
        marked && "font-medium text-primary",
        !marked && fact.raw === null && "text-fg-3",
      )}
    >
      <span className="sr-only">{fact.label}: </span>
      {fact.raw === null ? fact.absent : fact.text}
    </span>
  );
}

/**
 * The facts of one pressing, on one line, without opening anything.
 *
 * `differs` comes from the group the card is in, which is the only place the comparison can be
 * made: a card cannot know on its own that it is the one with the odd barcode.
 */
export function ReleaseFactsRow({
  candidate,
  differs,
  className,
}: {
  readonly candidate: ReleaseCandidate;
  readonly differs: ReadonlySet<FactKey>;
  readonly className?: string;
}) {
  const facts = rowFacts(candidate, differs);
  return (
    <span
      data-testid="candidate-facts"
      className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)}
    >
      {facts.map((fact) => (
        <FactItem
          key={fact.key}
          fact={fact}
          marked={differs.has(fact.key) && !ALWAYS.includes(fact.key)}
        />
      ))}
    </span>
  );
}

/**
 * The whole set, on expand — a definition list rather than a sentence, because eleven facts
 * read as a table and not as prose.
 *
 * Absent values are printed here whether or not they distinguish anything: this is the panel
 * somebody opened *in order to* find out, and "MusicBrainz has no barcode for this pressing"
 * is an answer.
 */
export function ReleaseFactsTable({
  candidate,
  differs,
}: {
  readonly candidate: ReleaseCandidate;
  readonly differs: ReadonlySet<FactKey>;
}) {
  return (
    <dl
      data-testid="candidate-facts-table"
      className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-line bg-surface-2 px-2.5 py-2 text-2xs sm:grid-cols-[auto_1fr_auto_1fr]"
    >
      {releaseFacts(candidate).map((fact) => (
        <div key={fact.key} className="contents">
          <dt className="text-fg-3">{fact.label}</dt>
          {/*
            No colour here, deliberately.
            Discovery's group differs on all eleven, so tinting every one of them would paint
            the whole sheet amber and say nothing. The *row* is where "what differs" is the
            message; this is the fact sheet, and it is weighted rather than coloured.
          */}
          <dd
            data-testid="candidate-fact-value"
            data-fact={fact.key}
            data-distinguishing={differs.has(fact.key)}
            title={
              differs.has(fact.key)
                ? `${fact.label} — not the same on every pressing of this record`
                : undefined
            }
            className={cn(
              "min-w-0 truncate",
              fact.raw === null ? "text-fg-3" : "text-fg-2",
              differs.has(fact.key) && fact.raw !== null && "font-medium text-fg-1",
            )}
          >
            {fact.raw === null ? fact.absent : fact.text}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/* ------------------------------------------------------------------ */
/* the same question, one level up and one level down                  */
/* ------------------------------------------------------------------ */

/**
 * What a release **group**'s pressings have between them, for the collapsed header.
 *
 * A group row used to say "4 releases, best: 14 tracks", which tells you nothing about whether
 * opening it is worth your time. This says what the four differ on — the countries, the
 * formats, the span of track counts — so the shut group is legible enough to leave shut.
 */
export function groupSpread(releases: readonly ReleaseCandidate[]): string[] {
  const out: string[] = [];
  const countries = [...new Set(releases.map((r) => r.country).filter((c) => c !== null))];
  const formats = [
    ...new Set(
      releases
        .map((r) => describeMedia(r.media, r.format))
        .filter((f): f is string => f !== null && f !== ""),
    ),
  ];
  const counts = [...new Set(releases.map((r) => r.tracks).filter((n) => n > 0))].sort(
    (a, b) => a - b,
  );

  if (countries.length > 0) out.push(countries.slice(0, 4).join(" · "));
  if (formats.length > 0) out.push(formats.slice(0, 3).join(" · "));
  const low = counts[0];
  const high = counts[counts.length - 1];
  if (low !== undefined && high !== undefined) {
    out.push(low === high ? `${String(low)} tracks` : `${String(low)}–${String(high)} tracks`);
  }
  return out;
}

/* ---- the borrow release, which is the same card in a dropdown ---- */

/** The comparable facts of a borrow option, in the same shape as a pressing's. */
export function borrowFacts(release: BorrowRelease): ReleaseFact[] {
  const discs =
    release.format === null
      ? null
      : release.mediumCount > 1
        ? `${String(release.mediumCount)} × ${release.format}`
        : release.format;
  return [
    {
      key: "date",
      label: "Release date",
      raw: release.date,
      text: release.date ?? "",
      absent: "no date",
    },
    {
      key: "country",
      label: "Country",
      raw: release.country,
      text: release.country ?? "",
      absent: "no country",
    },
    { key: "discs", label: "Format", raw: discs, text: discs ?? "", absent: "no format" },
    {
      key: "tracks",
      label: "Track",
      raw:
        release.trackPosition === null
          ? null
          : `${String(release.trackPosition)}/${String(release.trackCount ?? 0)}`,
      text:
        release.trackPosition === null
          ? ""
          : `track ${String(release.trackPosition)}${release.trackCount === null ? "" : `/${String(release.trackCount)}`}`,
      absent: "no track number",
    },
    {
      key: "label",
      label: "Label",
      raw: release.label,
      text: release.label ?? "",
      absent: "no label",
    },
    {
      key: "catalogue",
      label: "Catalogue number",
      raw: release.catalogNumber,
      text: release.catalogNumber ?? "",
      absent: "no catalogue number",
    },
    {
      key: "barcode",
      label: "Barcode",
      raw: release.barcode,
      text: release.barcode ?? "",
      absent: "no barcode",
    },
    {
      key: "status",
      label: "Status",
      raw: release.status,
      text: release.status ?? "",
      absent: "no status",
    },
    {
      key: "comment",
      label: "Disambiguation",
      raw: release.disambiguation === "" ? null : release.disambiguation,
      text: release.disambiguation,
      absent: "no comment",
    },
  ];
}

/** The same comparison as `distinguishing`, over the borrow options of one recording. */
export function distinguishingBorrow(releases: readonly BorrowRelease[]): ReadonlySet<FactKey> {
  const out = new Set<FactKey>();
  if (releases.length < 2) return out;
  const columns = releases.map(borrowFacts);
  const first = columns[0];
  if (first === undefined) return out;
  for (const [index, fact] of first.entries()) {
    if (columns.some((column) => column[index]?.raw !== fact.raw)) out.add(fact.key);
  }
  return out;
}
