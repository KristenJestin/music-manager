/**
 * Title/artist normalization + fuzzy similarity for the matching engine.
 *
 * Taken verbatim, with its tests, from the previous prototype
 * `_archive/music-manager-v2/src/matching/normalize.ts` before that tree was archived.
 * Only the header, the doc references and the import extensions changed. The scoring that
 * consumes it arrives in P05 (docs/04-pipeline-et-matching.md §« Algorithme de présélection »).
 *
 * YouTube titles carry noise the MusicBrainz tracklist does not: a leading
 * "Artist - " prefix, "(Official Video)" / "[Official Audio]" / "(Lyric Video)"
 * tags, "feat." / "ft." credits, remaster / remaster-year markers, and assorted
 * bracketed junk ("[HD]", "(4K)"). Normalization strips all of that and folds
 * case, accents, and punctuation so two cosmetically-different spellings of the
 * same title compare equal (docs/04-pipeline-et-matching.md). The similarity is a token Dice
 * coefficient — symmetric, bounded in [0,1], deterministic, and order-
 * insensitive — feeding the engine's title sub-score.
 *
 * Pure functions only; no I/O.
 */

/** Bracketed segments — "(...)" or "[...]" — captured for noise filtering. */
const BRACKETED = /\s*[([][^()[\]]*[)\]]/g;

/**
 * A non-bracketed "feat." / "ft." / "featuring" credit clause. It runs from the
 * keyword up to — but NOT through — the next " - " dash-subtitle, the next
 * bracket, or end-of-string. The clause body is matched lazily and excludes
 * bracket openers so a following parenthetical/subtitle survives the strip
 * ("Song ft. X & Y - Live" keeps both "Song" and "Live"); a feat. credit that
 * runs to the end is removed whole ("Get Lucky ft. Pharrell" -> "Get Lucky").
 * When a dash-subtitle follows, the dash is consumed too so the title and
 * subtitle rejoin into one segment (the `normalizeTitle` Artist-prefix split
 * therefore never mistakes the leading title for an "Artist - " prefix).
 */
const FEAT_TAIL = /\s*\b(?:feat\.?|ft\.?|featuring)\b[^([]*?(?:\s+-\s+|(?=[([])|$)/i;

/** A "- Remaster" / "- Remastered 2011" style suffix (outside brackets). */
const REMASTER_SUFFIX = /\s*-\s*(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/i;

/** Tokens that mark a bracketed segment as droppable production noise. */
const NOISE_WORDS = [
  "official",
  "video",
  "audio",
  "lyric",
  "lyrics",
  "visualizer",
  "visualiser",
  "remaster",
  "remastered",
  "hd",
  "hq",
  "4k",
  "mv",
  "m/v",
  "feat",
  "ft",
  "featuring",
];

/** True when a bracketed segment is production noise we should drop entirely. */
function isNoiseBracket(inner: string): boolean {
  const lowered = inner.toLowerCase();
  return NOISE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(lowered));
}

/** Fold accents to ASCII and drop combining marks (é -> e). */
function stripAccents(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Collapse runs of whitespace and trim. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Drop bracketed production noise but keep meaningful parentheticals (e.g. a
 * subtitle). A bracket is removed only when it contains a noise word.
 */
function stripNoiseBrackets(value: string): string {
  return value.replace(BRACKETED, (match) => {
    const inner = match.replace(/[([)\]]/g, "");
    return isNoiseBracket(inner) ? "" : match;
  });
}

/**
 * Normalize a YouTube/MusicBrainz title to a comparison key: strip a leading
 * "Artist - " segment, drop "(Official Video)"-style and feat. noise, remove
 * remaster tags and any remaining bracketed junk, fold accents/case, and drop
 * punctuation. Deterministic and idempotent.
 */
export function normalizeTitle(raw: string): string {
  let s = raw;

  // 1. Remaster suffix ("- Remastered 2011", "- Remaster") first, so a dash
  //    remaster marker is not mistaken for an "Artist - Title" prefix below.
  s = s.replace(REMASTER_SUFFIX, "");

  // 2. A non-bracketed feat. clause, BEFORE the Artist-prefix split: the clause
  //    stops at the next " - " subtitle (consuming that dash so the title and
  //    subtitle rejoin), so "Song ft. X & Y - Live" → "Song  Live" rather than
  //    having "Song ft. X & Y" mistaken for an "Artist - " prefix and dropped.
  s = s.replace(FEAT_TAIL, " ");

  // 3. A leading "Artist - Title" prefix → keep only the title side.
  const dashIdx = s.indexOf(" - ");
  if (dashIdx !== -1) {
    s = s.slice(dashIdx + 3);
  }

  // 4. Drop bracketed production noise (Official Video, feat., HD, …).
  s = stripNoiseBrackets(s);

  // 5. Fold accents, lowercase, strip punctuation, collapse whitespace.
  s = stripAccents(s).toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, "");
  return collapse(s);
}

/**
 * Normalize an artist/uploader name: fold accents/case, drop a leading "The ",
 * a YouTube "- Topic" auto-channel suffix, and a trailing feat. credit.
 */
export function normalizeArtist(raw: string): string {
  let s = raw;

  // "Daft Punk - Topic" → "Daft Punk".
  s = s.replace(/\s*-\s*topic\s*$/i, "");
  // Trailing feat. credit.
  s = s.replace(FEAT_TAIL, "");
  // Leading "The ".
  s = s.replace(/^the\s+/i, "");

  s = stripAccents(s).toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, "");
  return collapse(s);
}

/**
 * Character bigrams of a normalized string with spaces removed. Bigrams capture
 * near-identical words (e.g. "light" vs "lights") far better than whole-token
 * matching, so a one-letter difference barely dents the score.
 */
function bigrams(normalized: string): string[] {
  const compact = normalized.replace(/ /g, "");
  if (compact.length < 2) return compact.length === 1 ? [compact] : [];
  const out: string[] = [];
  for (let i = 0; i < compact.length - 1; i++) {
    out.push(compact.slice(i, i + 2));
  }
  return out;
}

/**
 * Fuzzy similarity of two titles in [0,1], computed after normalization as a
 * character-bigram Dice coefficient: 2·|shared bigrams| / (|a| + |b|), counting
 * multiplicities. 1 = identical (post-normalization), 0 = nothing in common.
 * Symmetric, bounded, and deterministic.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;

  const ba = bigrams(na);
  const bb = bigrams(nb);
  if (ba.length === 0 || bb.length === 0) return 0;

  // Multiset intersection size.
  const counts = new Map<string, number>();
  for (const g of ba) counts.set(g, (counts.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of bb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      shared += 1;
      counts.set(g, c - 1);
    }
  }

  return (2 * shared) / (ba.length + bb.length);
}
