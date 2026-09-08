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

import { normalizeArtist, normalizeTitle, titleSimilarity } from "../normalize/title.ts";
import type { MbArtistCreditEntry, MbRelease } from "../metadata/resolvers/musicbrainz-types.ts";
import type { MatchTrack, MatchingPreferences, MatchingThresholds, Penalty } from "./types.ts";

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
  ["edit", 0.08],
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
): Penalty[] {
  const comment = (disambiguation ?? "").trim().toLowerCase();
  if (comment === "") return [];

  let worst: Penalty | null = null;
  for (const [term, amount] of DISAMBIGUATION_PENALTIES) {
    if (!comment.includes(term)) continue;
    if (worst === null || amount > worst.amount) {
      worst = { reason: `Disambiguation contains “${term}”`, amount };
    }
  }

  const explicit = explicitPenalty(comment, preferences);
  const found: Penalty[] = [];
  if (worst !== null) found.push(worst);
  else if (explicit === null) {
    found.push({
      reason: `Disambiguation “${comment}” sets this pressing apart`,
      amount: UNKNOWN_DISAMBIGUATION_PENALTY,
    });
  }
  if (explicit !== null) found.push(explicit);
  return found;
}

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
): Penalty[] {
  const lowered = title.toLowerCase();
  const known = new Set(
    [primaryType ?? "", ...(secondary ?? [])].map((t) => t.trim().toLowerCase()),
  );
  const out: Penalty[] = [];
  for (const [term, amount] of TITLE_KEYWORD_PENALTIES) {
    if (!lowered.includes(term)) continue;
    // Already declared by the release group: not a surprise, so not a penalty.
    if (known.has(term) || (term === "greatest hits" && known.has("compilation"))) continue;
    if (term === "best of" && known.has("compilation")) continue;
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
