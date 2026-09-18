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

/**
 * The dash that separates an "Artist - Title" prefix from the title.
 *
 * The three characters are the three a YouTube title is actually written with: the ASCII
 * hyphen, the en dash and the em dash. Whitespace on both sides is required, so a hyphenated
 * word ("Jay-Z", "Non-Stop") is never mistaken for a separator.
 */
const DASH_SEPARATOR = / [-–—] /;

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

  // 3. A leading "Artist - Title" prefix → keep only the title side. The three dashes a
  //    YouTube title is written with are all accepted: "Radiohead - Creep",
  //    "Radiohead – Creep" and "Radiohead — Creep" are the same title.
  const dash = DASH_SEPARATOR.exec(s);
  if (dash !== null) {
    s = s.slice(dash.index + dash[0].length);
  }

  // 4. Drop bracketed production noise (Official Video, feat., HD, …).
  s = stripNoiseBrackets(s);

  // 5. Fold accents, lowercase, strip punctuation, collapse whitespace.
  s = stripAccents(s).toLowerCase();
  s = s.replace(/[^\p{L}\p{N}\s]/gu, "");
  return collapse(s);
}

/**
 * The release-type word YouTube Music puts in front of an auto-generated playlist's title.
 *
 * A playlist YouTube generated for a release — the `OLAK5uy_…` ones the paste box is mostly
 * fed — is titled "Album - Love Is Dead", "Single - Get Lucky", "EP - Wild Youth". The word is
 * the *kind* of release, not part of its name, and MusicBrainz has never heard of it: left in,
 * it becomes the album hint, then the search query, and the right release does not come back.
 *
 * The dash must be surrounded by whitespace so a title that merely starts with those letters
 * ("EP-ic Journey", "Single-Minded") is left alone.
 */
const RELEASE_TYPE_PREFIX = /^\s*(?:album|single|ep)\s+[-–—]\s+/i;

/**
 * Drop the "Album - " / "Single - " / "EP - " prefix of a YouTube-generated playlist title.
 *
 * Returns the input unchanged when there is no such prefix, and when stripping it would leave
 * nothing — a playlist actually called "Album -" keeps its name rather than losing it.
 */
export function stripReleaseTypePrefix(raw: string): string {
  const stripped = raw.replace(RELEASE_TYPE_PREFIX, "").trim();
  return stripped === "" ? raw.trim() : stripped;
}

/* ------------------------------------------------------------------ */
/* edition qualifiers                                                  */
/* ------------------------------------------------------------------ */

/**
 * The words a distributor adds to an album's name to say *which edition* this is.
 *
 * They are part of the string YouTube shows and, very often, of nothing MusicBrainz publishes:
 * the owner has forty imports stuck on "The search came back empty" because the playlist is
 * called "Let Go (Expanded Edition)", "Sunset on the Golden Age (Deluxe)" or "The Marshall
 * Mathers LP2 (Deluxe)" and MusicBrainz files one release group per *record*, named after the
 * record. Asking for the base title is the second question worth asking.
 *
 * Longest first, because the matcher strips the longest match and "Deluxe Edition" must not be
 * left as a dangling "Edition" by a "Deluxe" that matched first.
 */
const EDITION_QUALIFIERS: readonly string[] = [
  "bonus track version",
  "bonus tracks version",
  "anniversary edition",
  "expanded edition",
  "special edition",
  "deluxe edition",
  "deluxe version",
  "expanded version",
  "remastered edition",
  "collector's edition",
  "collectors edition",
  "extended edition",
  "platinum edition",
  "ultimate edition",
  "complete edition",
  "bonus edition",
  "bonus version",
  "bonus tracks",
  "remastered",
  "remaster",
  "expanded",
  "deluxe",
];

/** A qualifier optionally prefixed by a year or an ordinal: "10th Anniversary Edition". */
const QUALIFIER_PREFIX = String.raw`(?:\d{1,4}(?:st|nd|rd|th)?\s+)?`;

/** Escape one literal term for use inside a regular expression. */
function escapeForRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The qualifier alternation, longest first, as one non-capturing group. */
const QUALIFIER_BODY = EDITION_QUALIFIERS.map(escapeForRegExp)
  .map((term) => term.replace(/ /g, String.raw`\s+`))
  .join("|");

/** `Title (Deluxe Edition)` / `Title [Bonus Track Version]` — the bracketed form. */
const BRACKETED_QUALIFIER = new RegExp(
  String.raw`\s*[([]\s*${QUALIFIER_PREFIX}(?:${QUALIFIER_BODY})\s*[)\]]\s*$`,
  "i",
);

/** `Title - Deluxe Edition` / `Title: Expanded Edition` / `Title, Remastered`. */
const SEPARATED_QUALIFIER = new RegExp(
  String.raw`\s*[-–—:,]\s*${QUALIFIER_PREFIX}(?:${QUALIFIER_BODY})\s*$`,
  "i",
);

/**
 * `Title Deluxe Edition`, with nothing between them.
 *
 * Deliberately narrower than the two above: only qualifiers that are **two words or more** are
 * stripped without a bracket or a separator to mark them. A bare trailing "Deluxe" or
 * "Remastered" with no punctuation is left alone, because that is how "Hotel Deluxe" and
 * "Songs Remastered" would lose a word of their real name. Two words ("Deluxe Edition",
 * "Bonus Track Version") do not occur by accident at the end of an album title.
 */
const MULTIWORD_QUALIFIERS = EDITION_QUALIFIERS.filter((term) => term.includes(" "));
const BARE_QUALIFIER = new RegExp(
  String.raw`\s+${QUALIFIER_PREFIX}(?:${MULTIWORD_QUALIFIERS.map((t) => t.replace(/ /g, String.raw`\s+`)).join("|")})\s*$`,
  "i",
);

/**
 * The album title without the edition qualifier a distributor appended to it.
 *
 * Returns the input **unchanged** when there is no qualifier, and — the case that matters —
 * when stripping one would leave nothing: an album genuinely called *Deluxe* (Harmonia, 1975)
 * or *Remastered* keeps its name rather than losing it. The qualifier has to be at the *end*,
 * so "Deluxe Corner" is never touched either.
 *
 * This is for the **search query only**. The original string stays the hint, the display name
 * and the input to `titleKeywordPenalties` and `disambiguationPenalties`: stripping the title
 * for a query must not disarm the deductions that "deluxe", "remaster" and "live" earn, which
 * are computed against MusicBrainz's own title and comment, not against ours.
 *
 * Idempotent, and it strips more than one qualifier: "Album (Deluxe Edition) [Remastered]"
 * comes back as "Album".
 */
export function stripEditionQualifier(raw: string): string {
  let out = raw.trim();
  for (;;) {
    const next = out
      .replace(BRACKETED_QUALIFIER, "")
      .replace(SEPARATED_QUALIFIER, "")
      .replace(BARE_QUALIFIER, "")
      .trim();
    if (next === out || next === "") return out;
    out = next;
  }
}

/**
 * The single-word qualifiers, as one alternation.
 *
 * They are plain words — "deluxe", "remaster", "remastered", "expanded" — so the escaping the
 * bracketed and separated forms do above has nothing to bite on here. Escaped anyway, through
 * the same helper, because the list is editable and the day somebody adds "12\"" to it is the
 * day an unescaped alternation becomes a silently wrong regular expression.
 */
const SINGLE_WORD_QUALIFIERS = EDITION_QUALIFIERS.filter((term) => !term.includes(" "))
  .map(escapeForRegExp)
  .join("|");

/**
 * A **bare** trailing single-word qualifier — "AFTERCARE DELUXE", "Sremmlife 2 Remastered".
 *
 * Deliberately absent from `stripEditionQualifier`, and the reason written above it still
 * holds: a bare "Deluxe" with no bracket and no separator is how *Deluxe* (Harmonia, 1975) is
 * spelled, and stripping it everywhere would take a word off a real name.
 *
 * It is safe **here**, as the last title rung of a ladder, for a reason that has nothing to do
 * with how likely the word is to be a qualifier: this question is only ever asked once every
 * narrower one has come back with nothing at all, and it still carries the artist clause. If
 * the record really is called *Hotel Deluxe*, the rung above it already found it and this one
 * is never reached; if it is not, `releasegroup:"Hotel" AND artist:"…"` is a strict question
 * about one artist's catalogue, not the title-only search this file forbids. The cost of being
 * wrong is one search that finds nothing. The cost of not asking was six searches and an
 * import stuck on *AFTERCARE DELUXE* by Nessa Barrett, whose release group MusicBrainz has had
 * all along under the name *AFTERCARE*.
 */
const BARE_SINGLE_QUALIFIER = new RegExp(
  String.raw`\s+${QUALIFIER_PREFIX}(?:${SINGLE_WORD_QUALIFIERS})\s*$`,
  "i",
);

/**
 * `stripEditionQualifier`, plus the bare single-word qualifier it refuses to touch.
 *
 * For the **last title rung of the search ladder only**. Everything else — the display name,
 * `titleKeywordPenalties`, `disambiguationPenalties` — keeps using the narrow one, or a
 * pressing that announces itself as deluxe stops being recognisable as one.
 *
 * Returns the input unchanged when the narrow strip already handled it, when there is nothing
 * bare to take, and when taking it would leave nothing.
 */
export function stripEditionQualifierLoosely(raw: string): string {
  let out = stripEditionQualifier(raw);
  for (;;) {
    const next = out.replace(BARE_SINGLE_QUALIFIER, "").trim();
    if (next === out || next === "") return out;
    out = stripEditionQualifier(next);
  }
}

/** True when a title carries an edition qualifier worth asking MusicBrainz a second time for. */
export function hasEditionQualifier(raw: string): boolean {
  return stripEditionQualifier(raw) !== raw.trim();
}

/**
 * The vocabulary of editions, as canonical tokens.
 *
 * One word per *kind* of edition, with the spellings that mean it. Both sides of the comparison
 * are reduced to these tokens, which is what lets "Deluxe Edition" on a YouTube playlist and
 * "deluxe edition" in a MusicBrainz disambiguation be recognised as the same request, and
 * "Live" as a different one.
 *
 * Wider than `EDITION_QUALIFIERS` above on purpose: that list decides what is *noise in a
 * search query*, and "Live" is not noise — `Unplugged (Live)` is a record MusicBrainz files
 * under that name. This list decides what the source is *asking for*, and a live album asks for
 * a live release.
 */
const EDITION_TOKENS: readonly (readonly [string, readonly string[]])[] = [
  ["deluxe", ["deluxe"]],
  ["expanded", ["expanded"]],
  ["anniversary", ["anniversary"]],
  ["bonus", ["bonus track", "bonus tracks", "bonus edition", "bonus version"]],
  ["special", ["special edition"]],
  ["box set", ["box set", "boxset"]],
  ["remaster", ["remaster", "remastered"]],
  ["reissue", ["reissue", "re-issue"]],
  ["live", ["live"]],
  ["acoustic", ["acoustic", "unplugged"]],
  ["instrumental", ["instrumental"]],
  ["demo", ["demo"]],
  ["remix", ["remix", "remixes"]],
  ["karaoke", ["karaoke"]],
  ["mono", ["mono"]],
];

/** Every edition token a free string mentions, deduplicated, in vocabulary order. */
export function editionTokensIn(raw: string | null | undefined): string[] {
  const lowered = (raw ?? "").toLowerCase();
  if (lowered.trim() === "") return [];
  const out: string[] = [];
  for (const [token, spellings] of EDITION_TOKENS) {
    if (spellings.some((spelling) => lowered.includes(spelling))) out.push(token);
  }
  return out;
}

/** A trailing `(…)`, `[…]` or `- …` segment, peeled one at a time from the end. */
const TRAILING_SEGMENT = /\s*(?:[([]([^()[\]]*)[)\]]|[-–—:,]\s*([^-–—:,()[\]]*))\s*$/;

/**
 * Which edition the **source** is asking for, read off its own title.
 *
 * The other half of `stripEditionQualifier`, and the reason the two live next to each other:
 * one extraction, two consumers. The search query drops the qualifier because MusicBrainz does
 * not publish it; the **scorer** keeps it, because it says which pressing of the record the
 * person actually wants. A playlist titled "The Heist (Deluxe Edition)" is not a playlist that
 * should be marked down twenty points for choosing the deluxe edition — that penalty exists
 * for the *opposite* case, and applying it unconditionally punished the only right answer.
 *
 * Only **trailing bracketed or separated segments** are read, and that is what keeps it from
 * firing on a record's real name: *Deluxe* by Harmonia announces nothing, and neither does
 * *Live Through This* — but "MTV Unplugged (Live)" and "Abbey Road - Remastered" do.
 *
 * ## Do not widen this to read a bare trailing word
 *
 * It is the obvious simplification and it is wrong. "AFTERCARE DELUXE" carries no bracket and
 * no separator, so nothing here fires and the deluxe pressing of that record was marked down
 * for announcing itself — a real defect, and the temptation is to reach for
 * `stripEditionQualifierLoosely` and read the last word after all. That breaks *Hotel Deluxe*
 * and *Songs Remastered*, which are names, and the test below says so in as many words.
 *
 * The bare case is answered somewhere it can be answered *on evidence*:
 * `editionProvenByFallback` in `apps/web/src/server/services/matching.service.ts` reads the
 * word only once MusicBrainz has answered the stripped title and refused the full one, which
 * is the index stating that the word is not part of the name. A string cannot know that and
 * this function only ever has the string.
 */
export function sourceEdition(raw: string | null | undefined): string[] {
  let rest = (raw ?? "").trim();
  const found = new Set<string>();
  for (let guard = 0; guard < 4; guard += 1) {
    const match = TRAILING_SEGMENT.exec(rest);
    if (match === null) break;
    const segment = (match[1] ?? match[2] ?? "").trim();
    const head = rest.slice(0, match.index).trim();
    if (head === "") break; // the whole title is the segment: it is the name, not a qualifier
    for (const token of editionTokensIn(segment)) found.add(token);
    rest = head;
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/* composite artist credits                                            */
/* ------------------------------------------------------------------ */

/**
 * The separators a credit uses to name more than one person.
 *
 * YouTube credits the artist *and whoever else the label listed* — a producer, a featured
 * singer, a co-writer — in one string: "Laufey, Spencer Stewart". MusicBrainz credits the
 * record to "Laufey", so `artist:"Laufey, Spencer Stewart"` returns nothing at all, and the
 * engine used to answer that by dropping the artist clause entirely and ranking a hundred and
 * forty-two homonyms. Splitting the credit is the right answer to the same problem: ask for
 * the first name credited, which is the artist, and keep the whole string as a second attempt.
 */
const CREDIT_SEPARATORS =
  /\s*(?:,|;|\/|&|\+|×|\b(?:x|and|et|feat|ft|featuring|with|vs|versus)\b\.?)\s*/i;

/**
 * Split a credit into the names it lists, in order, human spelling preserved.
 *
 * Returns `[]` for an empty credit and `[whole]` for a credit with no separator in it. The
 * names are **not** normalised: the first of them goes into a Lucene phrase, and MusicBrainz
 * indexes the spelling, not the comparison key.
 */
export function splitArtistCredit(raw: string | null | undefined): string[] {
  if (raw == null) return [];
  const cleaned = raw.replace(/\s*-\s*topic\s*$/i, "").trim();
  if (cleaned === "") return [];
  return cleaned
    .split(CREDIT_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * The first name a credit lists — the artist, as opposed to everyone else on the line.
 *
 * `null` when there is nothing to take, and when the credit holds exactly one name, so a
 * caller can ask "is there a narrower question than the whole credit?" and get a straight no.
 */
export function primaryArtist(raw: string | null | undefined): string | null {
  const parts = splitArtistCredit(raw);
  if (parts.length < 2) return null;
  return parts[0] ?? null;
}

/**
 * The artist clauses to try, narrowest plausible first — the rungs of the artist ladder.
 *
 * The seventh owner review's first defect. A credit that matches nothing at MusicBrainz used
 * to be tried twice, as the first name and as the whole string, and then **dropped**: the
 * search fell through to the title alone by way of the recordings, and on
 * *Stardew Valley Piano Collections* it fell through to nothing at all. Seven searches, no
 * candidate, over a release MusicBrainz has had since 2018 — because YouTube credits
 * "ConcernedApe, Meadow Bridgham, Augustine Mayuga Gonzales" and MusicBrainz credits
 * "Augustine Mayuga Gonzales, Matthew Bridgham". The two strings share a name. Neither of the
 * two rungs asked for it, because it is the *third* one written.
 *
 * So the credit is degraded name by name instead of being thrown away:
 *
 *  1. the **first credited name** — "Laufey" out of "Laufey, Spencer Stewart". YouTube lists
 *     whoever the label listed, producers included, and MusicBrainz almost never publishes a
 *     composite credit. The narrowest plausible question first;
 *  2. the **whole credit**, because some records really are credited to a pair and
 *     "Macklemore & Ryan Lewis" is one of them;
 *  3. **each of the other names, alone**, in the order the credit lists them. A collaborative
 *     record is filed under one of its collaborators and there is no rule saying which, so the
 *     only honest thing is to ask about each.
 *
 * Every rung is an `artist:` clause, and that is what separates this from the widening that was
 * deleted: `releasegroup:"Bewitched"` with no artist returned a hundred and forty-two records
 * by everybody who ever used the word, while `releasegroup:"X" AND artist:"Augustine Mayuga
 * Gonzales"` is exactly as strict as the first rung — it is asked about a **shorter credit**,
 * not about no credit. A shorter credit cannot return somebody else's record unless that
 * somebody else is named on the source. See `lucene.ts`, which explains what must never come
 * back.
 *
 * `limit` caps it, because every rung is a second through the MusicBrainz gate and a credit
 * listing eight session musicians is not eight hypotheses worth a second each.
 */
export function artistLadder(raw: string | null | undefined, limit = 4): string[] {
  const names = splitArtistCredit(raw);
  const whole = (raw ?? "").replace(/\s*-\s*topic\s*$/i, "").trim();
  if (names.length === 0) return whole === "" ? [] : [whole];

  const rungs: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "" && !rungs.includes(trimmed)) rungs.push(trimmed);
  };

  push(names[0] ?? "");
  push(whole);
  for (const name of names.slice(1)) push(name);
  return rungs.slice(0, Math.max(1, limit));
}

/**
 * Does this MusicBrainz credit **carry** the artist the source names?
 *
 * The question the sixth owner review turns into a refusal: the engine chose Laura Fygi's
 * *Bewitched* for a playlist credited "Laufey, Spencer Stewart", printed "Artist mismatch" on
 * its own card, and imported it anyway. A disagreement this plain is not a deduction, it is a
 * different record — but the comparison has to be generous, or a right answer gets refused for
 * spelling.
 *
 * Generous in four stated ways, each of which is a real pair from the owner's library:
 *
 *  - **either credit may be a list.** "Laufey, Spencer Stewart" carries "Laufey"; "Daft Punk"
 *    is carried by "Daft Punk feat. Julian Casablancas". One name in common is enough.
 *  - **`&` and "and" are the same word**, and so are `feat.`, `ft.` and "featuring" — they are
 *    all separators here, so "Simon & Garfunkel" and "Simon and Garfunkel" split identically.
 *  - **accents, case, punctuation and a leading "The" do not count** (`normalizeArtist`).
 *  - **one name containing the other counts**: "Macklemore" is carried by "Macklemore & Ryan
 *    Lewis", and "Beyoncé Knowles" by "Beyoncé".
 *
 * And strict in the one way that matters: two names that merely *look* alike do not count.
 * The comparison is exact on the normalised form or containment, never a fuzzy similarity —
 * "Laufey" and "Laura Fygi" share four letters and a shape, and a similarity threshold low
 * enough to forgive a spelling is low enough to accept them.
 *
 * `aliases` is what a MusicBrainz artist is *also* known as, when the caller has it. It is
 * absent from the matching cassettes on purpose (`scripts/prune-musicbrainz.ts` strips them),
 * so nothing may depend on it being there.
 */
export function creditCarriesArtist(
  sourceCredit: string | null | undefined,
  candidateCredit: string | null | undefined,
  aliases: readonly string[] = [],
): boolean {
  const wanted = splitArtistCredit(sourceCredit)
    .map(normalizeArtist)
    .filter((n) => n !== "");
  if (wanted.length === 0) return true; // the source names nobody: nothing to disagree with

  const offered = new Set<string>();
  for (const name of splitArtistCredit(candidateCredit)) {
    const normalised = normalizeArtist(name);
    if (normalised !== "") offered.add(normalised);
  }
  for (const alias of aliases) {
    for (const name of splitArtistCredit(alias)) {
      const normalised = normalizeArtist(name);
      if (normalised !== "") offered.add(normalised);
    }
  }
  if (offered.size === 0) return false;

  for (const name of wanted) {
    for (const candidate of offered) {
      if (name === candidate) return true;
      // Containment on whole words, so "Cary" is not carried by "Marc Cary" by accident of
      // being a substring — and "Macklemore" still is carried by "Macklemore Ryan Lewis".
      if (containsName(candidate, name) || containsName(name, candidate)) return true;
    }
  }
  return false;
}

/**
 * True when `haystack` contains `needle` as a whole run of words — and `needle` is long enough
 * for that to mean something.
 *
 * Containment is what lets "Beyoncé" be carried by "Beyoncé Knowles"; the separators above
 * already handle every credit that *lists* names, so this is only ever about a name and a
 * fuller form of it. A short single word is the dangerous case and is refused: *Air* is a band,
 * and it is not Air Supply; *Kiss* is a band, and it is not Kiss the Anus of a Black Cat. Two
 * words, or one of six characters, is where a shared prefix stops being a coincidence.
 */
function containsName(haystack: string, needle: string): boolean {
  const wanted = needle.split(" ");
  if (needle === "" || (wanted.length < 2 && needle.length < 6)) return false;
  const words = haystack.split(" ");
  for (let i = 0; i + wanted.length <= words.length; i += 1) {
    if (words.slice(i, i + wanted.length).join(" ") === needle) return true;
  }
  return false;
}

/**
 * Drop a leading "Artist - " from a video title, keeping the human spelling of the rest.
 *
 * `normalizeTitle` already does this, but it also folds case, accents and punctuation — it
 * produces a *comparison key*, not a title. The two places that need the title itself are the
 * MusicBrainz recording query and everything derived from it, and there the difference is not
 * cosmetic: `recording:"Radiohead - Creep"` is a phrase search that matches a cover literally
 * titled "Radiohead - Creep" and never proposes the original, which is exactly what the first
 * real single import did (DRIVE-1 §B1). `recording:"Creep" AND artist:"Radiohead"` proposes it
 * first.
 *
 * The strip is **conditional on the artist** when one is known: the leading segment has to be
 * that artist (or a channel name built on it, "RadioheadVEVO"), otherwise "Creep - Radiohead"
 * would lose its title instead of its credit. With no artist to check against, the leading
 * segment is dropped anyway — that is what `normalizeTitle` has always done, and the query is
 * better off without it either way.
 */
export function stripArtistPrefix(raw: string, artist?: string | null): string {
  const dash = DASH_SEPARATOR.exec(raw);
  if (dash === null) return raw.trim();
  const head = raw.slice(0, dash.index).trim();
  const tail = raw.slice(dash.index + dash[0].length).trim();
  if (head === "" || tail === "") return raw.trim();
  if (artist == null || artist.trim() === "") return tail;

  const wanted = normalizeArtist(artist);
  const found = normalizeArtist(head);
  if (wanted === "" || found === "") return raw.trim();
  return found === wanted || found.startsWith(wanted) || wanted.startsWith(found)
    ? tail
    : raw.trim();
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
