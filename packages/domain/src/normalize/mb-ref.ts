/**
 * Reading a MusicBrainz reference out of whatever somebody pasted.
 *
 * ## Why this is not a regex at the call site
 *
 * The Console had one, and it said `/[0-9a-f]{8}-…/` and nothing else. So the wizard's search
 * box on a single accepted *a recording id and nothing else*, and the id a person actually has
 * in the clipboard is the one from the page they were just looking at — which is a release.
 * Pasting `966e9be9-…` there answered **"No MusicBrainz recording with id 966e9be9-…"**, which
 * is the worst sentence available: the id is perfectly good, it is the *kind* that is wrong,
 * and the message says the opposite.
 *
 * Getting that right needs two halves, and only the first one is pure:
 *
 *  - **here** — what did they paste? An id, or an address, and if an address, what did the
 *    address claim it was? No network, no opinions, testable against every URL shape
 *    musicbrainz.org serves;
 *  - **`server/services/mb-resolve.ts`** — what *is* it, really, and what can this import do
 *    with it? That needs a lookup, because the claim on a URL is a hint and a bare id makes no
 *    claim at all.
 *
 * The split is the point. A parser that guessed would be wrong exactly where it mattered.
 */

/**
 * The entity types a musicbrainz.org address can name.
 *
 * All of them, not only the five this application understands: recognising `/work/<id>` is what
 * lets the refusal say *"that is a work"* instead of *"that is not a release"*, and naming what
 * something is has been the whole complaint.
 */
export const MB_ENTITIES = [
  "area",
  "artist",
  "event",
  "genre",
  "instrument",
  "label",
  "place",
  "recording",
  "release",
  "release-group",
  "series",
  "url",
  "work",
] as const;

export type MbEntityName = (typeof MB_ENTITIES)[number];

export interface MbRef {
  /** Lower-cased, hyphenated, 36 characters. */
  readonly mbid: string;
  /**
   * What the *address* said it was, or `null` for a bare id.
   *
   * A hint, never the answer: it orders the lookups so the common case costs one request. A URL
   * can be stale, hand-edited or simply wrong, and a bare id says nothing at all, so the entity
   * on the resolved reference always comes from MusicBrainz rather than from here.
   */
  readonly claimed: MbEntityName | null;
}

/** 8-4-4-4-12 hexadecimal, anywhere in the string. */
const MBID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * `…/<entity>/<mbid>`, wherever it appears in a path.
 *
 * Written against the path rather than the whole URL so that `/ws/2/recording/<id>` — the web
 * service address, which is what somebody debugging has in their clipboard — reads the same as
 * `/recording/<id>`, and so a trailing segment (`/release/<id>/cover-art`, `/artist/<id>/works`)
 * does not stop it matching.
 */
const ENTITY_IN_PATH = new RegExp(`/(${MB_ENTITIES.join("|")})/(${MBID.source})(?:[/?#]|$)`, "i");

/** The hosts whose paths carry an entity word. Anything else is treated as free text. */
function isMusicBrainzHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^www\./, "");
  return (
    bare === "musicbrainz.org" || bare === "beta.musicbrainz.org" || bare === "test.musicbrainz.org"
  );
}

/**
 * The MusicBrainz reference in a pasted string, or `null` when there is none.
 *
 * Accepts, in the order a person is likely to produce them:
 *
 *  - a bare MBID, with or without surrounding whitespace — `claimed: null`;
 *  - `https://musicbrainz.org/release/<id>`, with or without a scheme, `www.`, a query string,
 *    a fragment or a trailing segment;
 *  - the beta and test hosts, which is what a link from a MusicBrainz edit looks like;
 *  - `https://musicbrainz.org/ws/2/recording/<id>?inc=…`, the web service address.
 *
 * Anything with no MBID in it at all is `null`, which is the caller's signal that this is free
 * text and belongs in a search. That distinction is the one the box has to make before it can
 * say anything useful.
 */
export function parseMbRef(input: string): MbRef | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;

  const found = MBID.exec(trimmed);
  if (found === null) return null;
  const mbid = found[0].toLowerCase();

  // The entity word only counts when it is on a musicbrainz.org path. A bare id, and an id
  // inside some other site's URL, claim nothing — the lookup decides.
  const host = hostOf(trimmed);
  if (host === null || !isMusicBrainzHost(host)) return { mbid, claimed: null };

  const path = pathOf(trimmed);
  const entity = ENTITY_IN_PATH.exec(path);
  if (entity === null) return { mbid, claimed: null };
  const claimed = entity[1]?.toLowerCase();
  if (claimed === undefined || !isEntityName(claimed)) return { mbid, claimed: null };
  // The id in the path wins over one that happened to appear in a query parameter.
  return { mbid: (entity[2] ?? mbid).toLowerCase(), claimed };
}

function isEntityName(value: string): value is MbEntityName {
  return (MB_ENTITIES as readonly string[]).includes(value);
}

/**
 * The host of a pasted address, or `null` when it is not one.
 *
 * `new URL` is strict about the scheme, and people paste `musicbrainz.org/release/…` without
 * one at least as often as with, so a schemeless string is retried with `https://` rather than
 * being thrown away.
 */
function hostOf(value: string): string | null {
  for (const candidate of [value, `https://${value}`]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.hostname;
    } catch {
      // Not a URL in that form; try the next.
    }
  }
  return null;
}

/** The path of a pasted address, with the query and the fragment removed. */
function pathOf(value: string): string {
  for (const candidate of [value, `https://${value}`]) {
    try {
      return new URL(candidate).pathname;
    } catch {
      // Not a URL in that form; try the next.
    }
  }
  return value;
}

/** How the entity reads in a sentence: "That is a **release group**, not a recording." */
export const MB_ENTITY_NOUN: Readonly<Record<MbEntityName, string>> = Object.freeze({
  area: "area",
  artist: "artist",
  event: "event",
  genre: "genre",
  instrument: "instrument",
  label: "label",
  place: "place",
  recording: "recording",
  release: "release",
  "release-group": "release group",
  series: "series",
  url: "URL",
  work: "work",
});
