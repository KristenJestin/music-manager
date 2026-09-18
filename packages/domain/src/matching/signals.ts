/**
 * The individual signals, each normalised to [0, 1], and the penalty vocabulary.
 *
 * Every function here answers one question about one candidate and returns a number between
 * zero and one, with no knowledge of the weights. That separation is what makes the engine
 * explainable: the Console shows the map of signals next to the aggregate, and a signal that
 * looks wrong points at exactly one function.
 *
 * The keyword lists are v1's (`MusicBrainzMatcherService.cs`), which were tuned against a
 * real library; the numbers are re-expressed on the [0, 1] scale (see `config.ts` for the
 * conversion and why it happened).
 */

import {
  creditCarriesArtist,
  editionTokensIn,
  normalizeArtist,
  normalizeTitle,
  titleSimilarity,
} from "../normalize/title.ts";
import type { MbArtistCreditEntry, MbRelease } from "../metadata/resolvers/musicbrainz-types.ts";
import type {
  MatchTrack,
  MatchingPreferences,
  MatchingThresholds,
  Penalty,
  ReleaseMedium,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* small numeric helpers                                               */
/* ------------------------------------------------------------------ */

/** Clamp to [0, 1]. Every signal ends here, so a formula can be written without fear. */
export function unit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Round to three decimals, so a stored score is stable across re-runs and readable in JSON. */
export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* duration                                                            */
/* ------------------------------------------------------------------ */

/**
 * Duration agreement in [0, 1]: full credit inside the tolerance, then a linear decay to zero
 * across the grace window. Beyond that the two lengths simply are not the same performance.
 *
 * Both sides may be unknown, which is not the same as disagreeing — the caller decides
 * whether to drop the signal or treat the `null` as a zero.
 */
export function durationScore(
  videoSeconds: number | null | undefined,
  trackSeconds: number | null | undefined,
  thresholds: Pick<MatchingThresholds, "durationToleranceSeconds" | "durationDecaySeconds">,
): number {
  if (videoSeconds == null || trackSeconds == null) return 0;
  const diff = Math.abs(videoSeconds - trackSeconds);
  if (diff <= thresholds.durationToleranceSeconds) return 1;
  const over = diff - thresholds.durationToleranceSeconds;
  if (over >= thresholds.durationDecaySeconds) return 0;
  return unit(1 - over / thresholds.durationDecaySeconds);
}

/** True when two lengths are the same to within the tolerance — the ±2 s of `docs/04`. */
export function withinTolerance(
  a: number | null | undefined,
  b: number | null | undefined,
  toleranceSeconds: number,
): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= toleranceSeconds;
}

/* ------------------------------------------------------------------ */
/* title and artist                                                    */
/* ------------------------------------------------------------------ */

/** Normalised fuzzy title agreement. A thin alias, so callers never import two modules. */
export function titleScore(a: string, b: string): number {
  return unit(titleSimilarity(a, b));
}

/**
 * Artist agreement between what the source says and what MusicBrainz credits.
 *
 * The uploader is the strongest evidence on YouTube Music, where an auto-generated channel is
 * literally `<artist> - Topic`; the `artist` tag corroborates it. An exact normalised match
 * scores 1, a fuzzy one degrades, and a genuinely different artist scores 0 — which is what
 * puts Bon Iver's "Skinny Love" under 0.4 when the video is Birdy's.
 */
export function artistScore(
  sources: readonly (string | null | undefined)[],
  credited: string | null | undefined,
): number {
  if (credited == null || credited.trim() === "") return 0;
  const target = normalizeArtist(credited);
  if (target === "") return 0;
  let best = 0;
  for (const source of sources) {
    if (source == null || source.trim() === "") continue;
    const normalised = normalizeArtist(source);
    if (normalised === "") continue;
    if (normalised === target) return 1;
    // A credit like "Daft Punk" against an uploader "Daft Punk & Julian Casablancas": one
    // containing the other is a strong partial, not a miss.
    const contained = normalised.includes(target) || target.includes(normalised);
    const similarity = titleSimilarity(normalised, target);
    best = Math.max(best, contained ? Math.max(0.8, similarity) : similarity);
  }
  return unit(best);
}

/**
 * Is this a **disagreement about who made the record**, rather than a spelling?
 *
 * The one expression behind both the “Artist mismatch” line every card can print and the
 * `artistDisagrees` flag the preselection vetoes on. They are the same statement by
 * construction, which is the point: the version this replaces had three scorers writing the
 * sentence out of a hard-coded `artist < 0.5` and nothing anywhere reading it, so the engine
 * printed “Artist mismatch (credited to VSO)” on the card it had ticked.
 *
 * Two conditions, and the second is why this is a function rather than a comparison:
 *
 *  - **the signal is low.** `artistScore` is a *similarity*, so it is the right thing to
 *    weight and the wrong thing to accuse with. Below `thresholds.artistDisagreement` there is
 *    no longer a spelling to forgive.
 *  - **and the two credits share no name.** `creditCarriesArtist` is this repository's
 *    settled answer to "are these the same artist" — it splits both sides on the separators a
 *    credit really uses, folds accents and case, and accepts one name in common. It is what
 *    the artist gate in `matching.service.ts` already asks, and asking something *different*
 *    here would mean the gate and the veto could contradict each other on the same pair.
 *
 * The second condition is not a technicality. *Stardew Valley Piano Collections* is credited
 * by YouTube to "ConcernedApe, Meadow Bridgham, Augustine Mayuga Gonzales" and by MusicBrainz
 * to "Augustine Mayuga Gonzales & Matthew Bridgham": as strings they barely resemble each
 * other and `artistScore` says so, but they name the same person and the record really is his.
 * Calling that a mismatch would print a false accusation on the right answer's card and then
 * refuse to tick it — the new bug, wearing the old one's clothes.
 */
export function artistDisagrees(
  sources: readonly (string | null | undefined)[],
  candidateCredit: string | null | undefined,
  signal: number,
  thresholds: MatchingThresholds,
): boolean {
  // `sources` is the same list `artistScore` was given — the album's credit and every video's
  // own tags — because a disagreement with one of them while another agrees is not one.
  const named = sources.filter((s) => s != null && s.trim() !== "");
  if (named.length === 0) return false; // the source names nobody to disagree with
  if (signal >= thresholds.artistDisagreement) return false;
  return !named.some((source) => creditCarriesArtist(source, candidateCredit));
}

/* ------------------------------------------------------------------ */
/* year                                                                */
/* ------------------------------------------------------------------ */

/**
 * Year agreement, from the ℗ line / `Released on:` / the `release_year` tag.
 *
 * v1 subtracted 5 points per year of distance; the same shape survives here as a decay of
 * 0.2 per year, so a reissue five years later is worth nothing and a one-year discrepancy
 * (a December release charted the following January) still counts for most of it. Nothing
 * known on either side is `0.5`: an absence of evidence must not read as a contradiction.
 */
export function yearScore(
  sourceYear: number | null | undefined,
  candidateYear: number | null,
): number {
  if (sourceYear == null && candidateYear == null) return 0.5;
  if (sourceYear == null || candidateYear == null) return 0.4;
  const distance = Math.abs(sourceYear - candidateYear);
  if (distance === 0) return 1;
  return unit(1 - distance * 0.2);
}

/**
 * The year of a **release**, judged against a year that describes the **record**.
 *
 * The hint is an album year: the ℗ line of the auto-generated description, YouTube Music's
 * `release_year` tag. A release's own `date` is the date of *that pressing*. Scoring one
 * against the other treats a re-pressing as a contradiction, and that is what it did: the 2014
 * worldwide digital *Appeal to Reason* — the master YouTube actually streams, and the edition
 * that fits the owner's playlist exactly — scored **zero** on year against a ℗ 2008, six years
 * of decay at 0.2 a year, and lost by less than the 0.04 that cost it.
 *
 * So the release is allowed the **better** of its own date and its release group's first
 * release date. The consequences are exactly the two that should follow:
 *
 *  - between two pressings of **one** record the signal now says nothing, because the group
 *    date is the same for both. That is right — `year` is evidence about *which record this
 *    is*, and the pressings are all the same record. `format`, `country` and the cover already
 *    carry the preference between pressings, and for a YouTube Music source the later digital
 *    re-issue is usually the *better* answer, not the worse one;
 *  - between two **different** records — a 2001 album and its 2019 live re-recording, filed in
 *    their own groups with their own first dates — it says as much as it ever did.
 */
export function releaseYearScore(
  sourceYear: number | null | undefined,
  releaseYear: number | null,
  groupFirstYear: number | null,
): number {
  if (releaseYear === null && groupFirstYear === null) return yearScore(sourceYear, null);
  const own = releaseYear === null ? 0 : yearScore(sourceYear, releaseYear);
  const group = groupFirstYear === null ? 0 : yearScore(sourceYear, groupFirstYear);
  return Math.max(own, group);
}

/* ------------------------------------------------------------------ */
/* format, country, status                                             */
/* ------------------------------------------------------------------ */

/**
 * Format preference. v1's ladder (Digital Media +50, CD +40, Vinyl −20, Cassette −50,
 * anything else −10) rescaled, with the preferred format taken from the settings rather than
 * hard-coded: a YouTube Music source is a digital release, so `Digital Media` is the default,
 * but somebody who rips CDs is entitled to say otherwise.
 */
export function formatScore(format: string | null, preferences: MatchingPreferences): number {
  const value = (format ?? "").trim().toLowerCase();
  if (value === "") return 0.4;
  if (value === preferences.format.trim().toLowerCase()) return 1;
  if (value === "digital media") return 0.9;
  if (value === "cd") return 0.8;
  if (value.includes("vinyl")) return 0.3;
  if (value === "cassette") return 0.15;
  return 0.5;
}

/**
 * Country preference, best first, from the settings — `XW` (worldwide) then the markets the
 * library actually buys from. Ranked rather than binary, so a second-choice country still
 * beats an unlisted one, and the major markets v1 knew about keep a floor above the rest.
 */
const MAJOR_MARKETS = new Set(["US", "CA", "GB", "DE", "FR", "JP", "XE", "XW"]);

export function countryScore(country: string | null, preferences: MatchingPreferences): number {
  if (country == null || country.trim() === "") return 0.35;
  const code = country.trim().toUpperCase();
  const rank = preferences.countries.findIndex((c) => c.toUpperCase() === code);
  if (rank === 0) return 1;
  if (rank > 0) {
    const span = Math.max(preferences.countries.length - 1, 1);
    // First preference 1, last preference 0.7: still clearly ahead of an unlisted market.
    return unit(1 - (rank / span) * 0.3);
  }
  return MAJOR_MARKETS.has(code) ? 0.45 : 0.3;
}

/* ------------------------------------------------------------------ */
/* exactness — the symmetric fit                                       */
/* ------------------------------------------------------------------ */

/**
 * How exactly a release and a listing fit each other: `bound / max(videos, tracks)`.
 *
 * The intersection over the union of the 1:1 assignment, and the one number that is 1 only
 * when **nothing is left over on either side**. The two directions we already had are each
 * blind in one way, and neither is blind in this one:
 *
 *  - `durations` = covered tracks ÷ tracks — blind to the videos a release would drop;
 *  - `coverage`  = bound videos ÷ videos  — blind to the tracks it would leave unclaimed.
 *
 * The owner's *Appeal to Reason* is the case they cannot settle between them. Fourteen videos,
 * two editions: the fifteen-track one places all fourteen and leaves a live bonus track
 * unclaimed, the fourteen-track one places all fourteen and leaves nothing. `coverage` is 1.0
 * for both — every video found a home — and only `durations` says anything at all, at a third
 * of the distance. Here the first is `14/15` and the second `1`.
 *
 * Symmetric by construction: `max(videos, tracks)` is the same denominator whichever side the
 * orphan is on, so an edition with one track too many and a playlist with one video too many
 * are marked down identically. That is deliberate — neither is worse than the other, and an
 * asymmetry here would just be `trackCount`'s, restated on a signal that can see the titles.
 *
 * `null` when there is nothing to compare, which the blend then drops from its denominator.
 */
export function exactnessScore(
  bound: number,
  videoCount: number,
  trackCount: number,
): number | null {
  const span = Math.max(videoCount, trackCount);
  if (span === 0) return null;
  return unit(bound / span);
}

/* ------------------------------------------------------------------ */
/* cover art                                                           */
/* ------------------------------------------------------------------ */

/** What the Cover Art Archive holds for one release, as a card can print it. */
export interface CoverArtInfo {
  /** At least one image of any type. */
  readonly available: boolean;
  /** A front cover — the one we would embed. */
  readonly front: boolean;
  readonly count: number;
}

/**
 * The `cover-art-archive` block of a release lookup, or `null` when it was never looked up.
 *
 * `null` is the honest answer for a search result: MusicBrainz sends the block on lookups and
 * on no search, so a shallow candidate does not *lack* a cover, we simply never asked. The
 * ranking treats it exactly as it treats an unread tracklist — dropped from the denominator,
 * never counted as a zero.
 */
export function coverArtOf(release: MbRelease): CoverArtInfo | null {
  const block = release["cover-art-archive"];
  if (block === undefined) return null;
  const count = typeof block.count === "number" ? block.count : 0;
  return {
    available: block.artwork === true || count > 0,
    front: block.front === true,
    count,
  };
}

/**
 * The cover-art signal (decision 167).
 *
 * A front is what the `tag` step embeds, so a front is worth full marks. Images without an
 * approved front are worth *something* — the archive has the record, and the release-group
 * fallback of `docs/03` §4 can often turn them into a picture — but not the same thing.
 * Nothing at all scores zero, and an un-looked-up release scores `null`.
 */
export function coverArtScore(info: CoverArtInfo | null): number | null {
  if (info === null) return null;
  if (info.front) return 1;
  return info.available ? 0.5 : 0;
}

/* ------------------------------------------------------------------ */
/* primary type                                                        */
/* ------------------------------------------------------------------ */

/**
 * How much the release group's **primary type** looks like a record worth importing.
 *
 * A weight, never a veto, and that distinction is the whole specification of it: a Single that
 * is genuinely the only thing the release group holds still wins, because there is nothing for
 * this signal to prefer it *over*. What it fixes is the other case — an album and an EP or a
 * single of the same name, scoring within a hair of each other, where the engine used to
 * settle on whichever happened to sort first.
 *
 * `null` for a release group that declares no type at all, and `null` is dropped from the
 * blend rather than counted as a zero — the same rule `coverArtScore` follows, for the same
 * reason: MusicBrainz not saying is not MusicBrainz saying "none".
 *
 * Deliberately *not* `releaseGroups.primaryTypeScore`, which is a different question asked at
 * a different moment: that one leans on how many videos are on the table, to decide which
 * groups are worth a release search at all, and it reverses for a lone video. This one ranks
 * releases that are already candidates, and the preference it encodes does not reverse.
 */
export function typeScore(primary: string | null | undefined): number | null {
  const type = (primary ?? "").trim().toLowerCase();
  if (type === "") return null;
  if (type === "album") return 1;
  if (type === "ep") return 0.7;
  if (type === "single") return 0.4;
  if (type === "broadcast" || type === "other") return 0.3;
  return 0.5;
}

/** Official releases only, really: v1 refused anything else outright (`return -1000`). */
export function statusScore(status: string | null): number {
  const value = (status ?? "").trim().toLowerCase();
  if (value === "official") return 1;
  if (value === "") return 0.5;
  if (value === "promotion") return 0.4;
  if (value === "bootleg") return 0;
  return 0.3;
}

/**
 * Label agreement between the "Provided to YouTube by …" line and the release's label.
 *
 * Deliberately gentle. That line names whoever distributes the catalogue *today* — Discovery
 * is "Provided to YouTube by Parlophone" while every 2001 pressing says Virgin — so a
 * mismatch is worth a shrug, not a verdict. Hence the floor at 0.5 rather than 0.
 */
export function labelScore(
  sourceLabel: string | null | undefined,
  candidateLabel: string | null,
): number {
  if (sourceLabel == null || sourceLabel.trim() === "") return 0.5;
  if (candidateLabel == null || candidateLabel.trim() === "") return 0.4;
  const a = normalizeArtist(sourceLabel);
  const b = normalizeArtist(candidateLabel);
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  return unit(0.5 + 0.5 * titleSimilarity(a, b));
}

/* ------------------------------------------------------------------ */
/* penalties                                                           */
/* ------------------------------------------------------------------ */

/**
 * v1's `UndesirableDisambiguations`, verbatim, with the deduction each one earns.
 *
 * v1 gave every entry the same `-200` and anything else `-30`. That was too blunt in one
 * direction — a "deluxe" edition is a different tracklist, a "pink" vinyl variant is the same
 * record in a different colour — so the list keeps its membership and gains a severity, with
 * the harshest entries sitting at v1's original weight once rescaled (0.20).
 */
const DISAMBIGUATION_PENALTIES: readonly (readonly [string, number])[] = [
  // A different tracklist: the fit will disagree anyway, but say so out loud.
  ["deluxe", 0.2],
  ["expanded", 0.18],
  ["box set", 0.2],
  ["anniversary", 0.16],
  ["bonus", 0.12],
  // A different performance.
  ["live", 0.2],
  ["demo", 0.18],
  ["remix", 0.16],
  ["instrumental", 0.2],
  ["karaoke", 0.2],
  ["commentary", 0.2],
  ["video version", 0.14],
  /*
   * "radio edit", never a bare "edit".
   *
   * It used to be `["edit", 0.08]` matched as a substring, so *every* "deluxe edition",
   * "special edition" and "limited edition" quietly owed eight points for containing the
   * letters. It never showed, because "deluxe" costs 0.20 and only the worst line counts — and
   * then the edition rule below stopped charging for "deluxe" when the source asked for it,
   * and an eight-point deduction for the word "edition" surfaced on the one candidate this
   * whole review is about. The term meant a *different mix*; these are the two ways it is
   * actually written.
   */
  ["radio edit", 0.08],
  ["single edit", 0.08],
  // A different master or pressing of the same performance: mild.
  ["remaster", 0.1],
  ["reissue", 0.1],
  ["import", 0.06],
  ["club edition", 0.08],
  ["dolby atmos", 0.08],
  ["360 reality audio", 0.08],
  // Cosmetic variants: named, so the Console can explain the ranking, barely deducted.
  ["alternative cover", 0.03],
  ["journal", 0.03],
  ["pink", 0.03],
  ["magenta", 0.03],
  ["vellum", 0.03],
  ["exclusive", 0.05],
];

/**
 * Does this comment or title *mention* a term, as a word rather than as letters?
 *
 * v1 matched these lists by raw substring and so did the first port of them, which is how
 * "live" matched "delivery", "import" matched "important" and "edit" matched "edition". The
 * boundary is only required at the **start** of the term, because MusicBrainz writes
 * "remastered" where the list says "remaster" and "remixes" where it says "remix".
 */
function mentions(haystack: string, term: string): boolean {
  const text = haystack.toLowerCase();
  const needle = term.toLowerCase();
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const before = at === 0 ? "" : text[at - 1];
    if (before === undefined || before === "" || !/[a-z0-9]/.test(before)) return true;
  }
  return false;
}

/** v1's `GetSecondaryTypePenalty`, rescaled from −75/−60/−50/−40/−10. */
const SECONDARY_TYPE_PENALTIES: Readonly<Record<string, number>> = {
  compilation: 0.075,
  remix: 0.06,
  live: 0.05,
  soundtrack: 0.04,
};
const SECONDARY_TYPE_DEFAULT = 0.01;

/** An unrecognised disambiguation still means *something* set this pressing apart. v1: −30. */
const UNKNOWN_DISAMBIGUATION_PENALTY = 0.03;

/**
 * Penalties earned by a release's disambiguation comment.
 *
 * Substring matching on the lowercased comment, exactly as v1 did it. Only the harshest match
 * counts — a comment reading "deluxe edition, remastered" is one problem, not two, and adding
 * the deductions would bury a candidate for a single fact stated twice.
 */
export function disambiguationPenalties(
  disambiguation: string | null | undefined,
  preferences: MatchingPreferences,
  edition: EditionRequest = NO_EDITION,
): Penalty[] {
  const comment = (disambiguation ?? "").trim().toLowerCase();
  const wanted = new Set(edition.wanted);
  /*
   * What this pressing says it is, read from **both** places an edition is written: the
   * disambiguation comment, and the release's own title. MusicBrainz uses them
   * interchangeably — "The Heist" + comment "deluxe edition" and "Nevermind (20th Anniversary
   * Edition)" with no comment at all are the same fact stated in two columns.
   */
  const carries = new Set([
    ...editionTokensIn(comment),
    ...editionTokensIn(edition.candidateTitle),
  ]);
  const agrees = [...wanted].some((token) => carries.has(token));

  const found: Penalty[] = [];
  const explicit = explicitPenalty(comment, preferences);

  /*
   * The deductions, **relative to what the source asked for**.
   *
   * A deluxe pressing is the wrong answer for a playlist of the standard album, and that is
   * what this list has always been for. It is exactly the wrong answer for a playlist titled
   * "The Heist (Deluxe Edition)" — eighteen videos, eighteen tracks, mean Δ 0.3 s, and the
   * only correct candidate marked down twenty points to 76 %. So:
   *
   *  - the source asked for nothing → every qualifier is a mark against the pressing, which is
   *    the behaviour this list has always had;
   *  - the source asked for *this* qualifier → no deduction at all. There is no bonus either,
   *    because a score is a blend plus named deductions and a bonus would break that; the
   *    reward is that every other pressing pays the line below;
   *  - the source asked and this pressing does not say it → a deduction for being the **wrong
   *    edition**, at half what carrying an unasked-for qualifier costs. Half, because "does not
   *    say it is deluxe" is weaker evidence than "says it is live": plenty of correct pressings
   *    carry no comment, and MusicBrainz often has no edition the playlist announces at all;
   *  - the source asked for one qualifier and this pressing carries a *different* one → the
   *    ordinary deduction. "Remaster" is not satisfied by "live".
   *
   * Only the worst line counts, as before: a comment reading "deluxe edition, remastered" is
   * one problem stated twice, and adding the deductions would bury a pressing for a fact.
   */
  let worst: Penalty | null = null;
  const consider = (penalty: Penalty): void => {
    if (worst === null || penalty.amount > worst.amount) worst = penalty;
  };

  /*
   * Both columns, charged as well as read.
   *
   * "Nevermind (20th Anniversary Edition)" with an empty comment is the same statement as a
   * comment reading "anniversary edition", so a qualifier in the *title* earns the same
   * deduction — except for the four terms `titleKeywordPenalties` already owns ("live",
   * "remix", "best of", "greatest hits"), which would otherwise be charged twice for one word.
   */
  const titleOwned = new Set(TITLE_KEYWORD_PENALTIES.map(([term]) => term));
  for (const [term, amount] of DISAMBIGUATION_PENALTIES) {
    const inComment = mentions(comment, term);
    const inTitle = !titleOwned.has(term) && mentions(edition.candidateTitle, term);
    if (!inComment && !inTitle) continue;
    // A qualifier the source itself announced is not a mark against anything.
    if (wanted.size > 0 && editionTokensIn(term).some((token) => wanted.has(token))) continue;
    consider({
      reason: inComment ? `Disambiguation contains “${term}”` : `Title contains “${term}”`,
      amount,
    });
  }

  if (wanted.size > 0 && !agrees) {
    const asked = [...wanted];
    const cost = Math.max(...asked.map((token) => EDITION_REQUEST_COST[token] ?? 0.1)) * 0.5;
    consider({
      reason: `The source asks for the ${asked.join(" / ")} edition and this pressing does not say it is one`,
      amount: round3(cost),
    });
  }

  if (worst !== null) found.push(worst);
  else if (comment !== "" && explicit === null && wanted.size === 0) {
    found.push({
      reason: `Disambiguation “${comment}” sets this pressing apart`,
      amount: UNKNOWN_DISAMBIGUATION_PENALTY,
    });
  }
  if (explicit !== null) found.push(explicit);
  return found;
}

/** What the source announced, and what this candidate calls itself. See `sourceEdition`. */
export interface EditionRequest {
  /** Canonical edition tokens read off the source's own title (`normalize/title.ts`). */
  readonly wanted: readonly string[];
  /** The candidate release's title, where MusicBrainz half the time writes the edition. */
  readonly candidateTitle: string;
}

export const NO_EDITION: EditionRequest = { wanted: [], candidateTitle: "" };

/** What *missing* each announced edition costs, before the half-weight is applied. */
const EDITION_REQUEST_COST: Readonly<Record<string, number>> = {
  deluxe: 0.2,
  expanded: 0.18,
  "box set": 0.2,
  anniversary: 0.16,
  bonus: 0.12,
  live: 0.2,
  demo: 0.18,
  remix: 0.16,
  instrumental: 0.2,
  karaoke: 0.2,
  acoustic: 0.16,
  remaster: 0.1,
  reissue: 0.1,
  special: 0.1,
  mono: 0.1,
};

/**
 * The explicit/clean pair. v1 preferred explicit, then a release with no comment at all, then
 * whatever was left — an ordering, never a number. Here it is a setting with three values and
 * the deduction only ever falls on the side you said you did not want.
 */
export function explicitPenalty(comment: string, preferences: MatchingPreferences): Penalty | null {
  const isExplicit = comment.includes("explicit");
  const isClean = comment.includes("clean");
  if (!isExplicit && !isClean) return null;
  if (preferences.explicit === "either") return null;
  if (preferences.explicit === "explicit" && isClean) {
    return { reason: "Clean version, but the preference is explicit", amount: 0.1 };
  }
  if (preferences.explicit === "clean" && isExplicit) {
    return { reason: "Explicit version, but the preference is clean", amount: 0.1 };
  }
  return null;
}

/** Penalties earned by a release group's secondary types (live, compilation, remix, …). */
export function secondaryTypePenalties(
  secondary: readonly string[] | undefined,
  primary: string | null | undefined,
): Penalty[] {
  if (secondary === undefined || secondary.length === 0) return [];
  const primaryLower = (primary ?? "").trim().toLowerCase();
  const out: Penalty[] = [];
  for (const type of secondary) {
    const value = type.trim().toLowerCase();
    if (value === "" || value === primaryLower) continue;
    const amount = SECONDARY_TYPE_PENALTIES[value] ?? SECONDARY_TYPE_DEFAULT;
    out.push({ reason: `Secondary type ${type}`, amount });
  }
  return out;
}

/**
 * v1 penalised "Live", "Remix", "Best Of" and "Greatest Hits" appearing in the *title* of a
 * release whose group was not already of that kind. Kept: a title is evidence the group types
 * sometimes miss.
 */
const TITLE_KEYWORD_PENALTIES: readonly (readonly [string, number])[] = [
  ["greatest hits", 0.15],
  ["best of", 0.15],
  ["live", 0.15],
  ["remix", 0.1],
];

export function titleKeywordPenalties(
  title: string,
  primaryType: string | null | undefined,
  secondary: readonly string[] | undefined,
  wantedEdition: readonly string[] = [],
): Penalty[] {
  const lowered = title.toLowerCase();
  const known = new Set(
    [primaryType ?? "", ...(secondary ?? [])].map((t) => t.trim().toLowerCase()),
  );
  const wanted = new Set(wantedEdition);
  const out: Penalty[] = [];
  for (const [term, amount] of TITLE_KEYWORD_PENALTIES) {
    if (!mentions(lowered, term)) continue;
    // Already declared by the release group: not a surprise, so not a penalty.
    if (known.has(term) || (term === "greatest hits" && known.has("compilation"))) continue;
    if (term === "best of" && known.has("compilation")) continue;
    // Nor is it a surprise when the source asked for it: a playlist called "… (Live)" is not
    // penalised for finding a release with "Live" in its name.
    if (editionTokensIn(term).some((token) => wanted.has(token))) continue;
    out.push({ reason: `Title contains “${term}”`, amount });
  }
  return out;
}

/** Sum a penalty list, capped so no candidate can be pushed below zero by bookkeeping alone. */
export function totalPenalty(penalties: readonly Penalty[]): number {
  let sum = 0;
  for (const penalty of penalties) sum += penalty.amount;
  return sum > 0.9 ? 0.9 : sum;
}

/* ------------------------------------------------------------------ */
/* release shape helpers                                               */
/* ------------------------------------------------------------------ */

/** Flatten a release's media into one tracklist, in absolute order (disc 1, then disc 2, …). */
export function flattenTracks(release: MbRelease): MatchTrack[] {
  const out: MatchTrack[] = [];
  let absoluteIndex = 0;
  for (const medium of release.media ?? []) {
    for (const track of medium.tracks ?? []) {
      const lengthMs = track.length ?? track.recording?.length ?? null;
      out.push({
        trackMbid: track.id ?? null,
        recordingMbid: track.recording?.id ?? null,
        title: track.title ?? track.recording?.title ?? "",
        artist: creditName(track["artist-credit"] ?? track.recording?.["artist-credit"]),
        lengthSeconds: lengthMs === null ? null : lengthMs / 1000,
        position: track.position ?? absoluteIndex + 1,
        mediumPosition: medium.position ?? 1,
        absoluteIndex,
      });
      absoluteIndex += 1;
    }
  }
  return out;
}

/** Tracks on a release, from the media's `track-count` when the tracklist was not fetched. */
export function trackTotal(release: MbRelease): number {
  let total = 0;
  for (const medium of release.media ?? []) {
    total += medium["track-count"] ?? medium.tracks?.length ?? 0;
  }
  return total;
}

/** The credited artist as one string, with MusicBrainz's own join phrases. */
export function creditName(credit: readonly MbArtistCreditEntry[] | undefined): string | null {
  if (credit === undefined || credit.length === 0) return null;
  const joined = credit
    .map((entry) => `${entry.name ?? entry.artist?.name ?? ""}${entry.joinphrase ?? ""}`)
    .join("")
    .trim();
  return joined === "" ? null : joined;
}

/** The four-digit year of an ISO-ish MusicBrainz date, or `null`. */
export function yearOf(date: string | null | undefined): number | null {
  if (date == null || date.length < 4) return null;
  const year = Number(date.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** The first medium's format — what v1 scored, and what a one-disc release always has. */
export function mainFormat(release: MbRelease): string | null {
  return release.media?.[0]?.format ?? null;
}

/**
 * The discs, with the format and the track count of each.
 *
 * A release *search* result already carries `media[].format` and `media[].track-count` — no
 * tracklist, but the shape of the thing — so this is known for every candidate, including the
 * ones the exploration never opened.
 */
export function mediaOf(release: MbRelease): ReleaseMedium[] {
  return (release.media ?? []).map((medium, index) => ({
    position: medium.position ?? index + 1,
    format: medium.format ?? null,
    trackCount: medium["track-count"] ?? medium.tracks?.length ?? 0,
  }));
}

/** The first catalogue number MusicBrainz lists for the release. */
export function mainCatalogNumber(release: MbRelease): string | null {
  for (const info of release["label-info"] ?? []) {
    // `== null` and not `!== undefined`: MusicBrainz sends an explicit `null` here for a label
    // entry with no catalogue number, which a strict `undefined` check walks straight into.
    const number = info["catalog-number"];
    if (number != null && number.trim() !== "") return number.trim();
  }
  return null;
}

/** The first label's name. */
export function mainLabel(release: MbRelease): string | null {
  for (const info of release["label-info"] ?? []) {
    const name = info.label?.name;
    if (name !== undefined && name.trim() !== "") return name;
  }
  return null;
}

/** Normalised title, exported so tests and the CLI describe candidates the same way. */
export { normalizeArtist, normalizeTitle };
