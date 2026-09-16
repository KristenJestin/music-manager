/**
 * The external links an artist already carries, read out of what we stored.
 *
 * Nothing new is fetched here and nothing new had to be persisted: `lookupArtist` asks
 * MusicBrainz with the `artistFull` preset, which includes `url-rels`, and `rememberArtist`
 * (`server/services/documents.ts`) writes the **whole** artist entity into
 * `artists_cache.payload`. The relationships were therefore already on disk; they were simply
 * never read by anything but `integrations/wikimedia.ts`, which takes the Wikidata one and
 * throws the rest away. This module is the reader.
 *
 * It is deliberately pure and in `lib/`: a `jsonb` column is `unknown` until something narrows
 * it, and narrowing it in one tested place is cheaper than a page full of casts.
 *
 * A relationship with `ended: true` is dropped. MusicBrainz keeps a homepage that has gone
 * away, because the fact that it existed is part of the record; a "quick links" row that
 * offered it would just be a dead click.
 */

/**
 * What `/library/artists/$id` is addressed by: the MBID when there is one, the name otherwise.
 *
 * One function, called by every page that links to an artist, so the list, the album header
 * and the track header cannot drift into three different URLs for the same person. The
 * reasoning behind the pair — the MBID survives a rename, the name is all an untagged import
 * ever has — is in `artistDetail` (`server/services/library.ts`), which resolves either.
 */
export function artistKey(artist: {
  readonly name: string;
  readonly mbid?: string | null;
}): string {
  const mbid = artist.mbid ?? "";
  return mbid.trim() === "" ? artist.name : mbid.trim();
}

/** One external address, ready to render. */
export interface ArtistLink {
  /** What the button reads: "Official homepage", "Discogs", "instagram.com"… */
  readonly label: string;
  readonly url: string;
  /** The MusicBrainz relationship type it came from, kept for the tooltip. */
  readonly relation: string;
}

/**
 * MusicBrainz relationship type → the word we put on the button.
 *
 * Only the types worth a place in a row of quick links. Everything else is either an
 * identifier rather than a destination (`VIAF`, `ISNI`), or something the Console already
 * shows another way (`image`, which is what `artists_cache.imageUrl` is).
 */
const LABELS: Readonly<Record<string, string>> = {
  "official homepage": "Official site",
  wikidata: "Wikidata",
  wikipedia: "Wikipedia",
  discogs: "Discogs",
  allmusic: "AllMusic",
  bandcamp: "Bandcamp",
  soundcloud: "SoundCloud",
  youtube: "YouTube",
  "last.fm": "Last.fm",
  songkick: "Songkick",
  setlistfm: "setlist.fm",
  imdb: "IMDb",
  "bbc music page": "BBC Music",
  "online community": "Community",
  blog: "Blog",
  myspace: "MySpace",
  "social network": "",
  streaming: "",
  "free streaming": "",
  "purchase for download": "",
  "purchase for mail-order": "",
  "download for free": "",
};

/** Relationship types that are catalogue identifiers, not pages a person wants to open. */
const SKIP = new Set(["image", "viaf", "isni", "other databases", "get the music"]);

/**
 * The well-known services, named from the host when the relationship type does not name them.
 *
 * "social network" covers every social site MusicBrainz knows about, and "streaming" covers
 * every streaming one, so the type alone would put four buttons reading *Streaming* in a row.
 * The host is what tells them apart, and it is what somebody scanning the row is looking for.
 */
const HOSTS: readonly (readonly [RegExp, string])[] = [
  [/(^|\.)instagram\.com$/, "Instagram"],
  [/(^|\.)facebook\.com$/, "Facebook"],
  [/(^|\.)(twitter|x)\.com$/, "X"],
  [/(^|\.)bsky\.app$/, "Bluesky"],
  [/(^|\.)threads\.net$/, "Threads"],
  [/(^|\.)tiktok\.com$/, "TikTok"],
  [/(^|\.)mastodon\./, "Mastodon"],
  [/(^|\.)youtube\.com$/, "YouTube"],
  [/(^|\.)spotify\.com$/, "Spotify"],
  [/(^|\.)deezer\.com$/, "Deezer"],
  [/(^|\.)tidal\.com$/, "Tidal"],
  [/(^|\.)apple\.com$/, "Apple Music"],
  [/(^|\.)amazon\./, "Amazon"],
  [/(^|\.)bandcamp\.com$/, "Bandcamp"],
  [/(^|\.)soundcloud\.com$/, "SoundCloud"],
  [/(^|\.)last\.fm$/, "Last.fm"],
  [/(^|\.)discogs\.com$/, "Discogs"],
  [/(^|\.)wikipedia\.org$/, "Wikipedia"],
  [/(^|\.)wikidata\.org$/, "Wikidata"],
  [/(^|\.)genius\.com$/, "Genius"],
];

/** The host of a URL, without `www.`, or `null` when it is not a URL we can open. */
export function hostOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.hostname.replace(/^www\./, "").toLowerCase();
}

function labelFor(relation: string, url: string): string | null {
  const host = hostOf(url);
  if (host === null) return null;
  for (const [pattern, name] of HOSTS) {
    if (pattern.test(host)) return name;
  }
  const declared = LABELS[relation];
  if (declared !== undefined && declared !== "") return declared;
  // A type we have no word for, on a host we do not know: the host *is* the useful label.
  return host;
}

interface RawRelation {
  readonly type?: unknown;
  readonly "target-type"?: unknown;
  readonly ended?: unknown;
  readonly url?: unknown;
}

function resourceOf(relation: RawRelation): string | null {
  const url = relation.url;
  if (typeof url !== "object" || url === null) return null;
  const resource = (url as { resource?: unknown }).resource;
  return typeof resource === "string" && resource !== "" ? resource : null;
}

/**
 * Every usable url-rel of a cached artist, best first and deduplicated by URL.
 *
 * `payload` is `artists_cache.payload` — the MusicBrainz artist entity, verbatim. A row
 * written before the payload column was filled, or seeded by the fixtures, simply has none,
 * and the answer is an empty list rather than an error.
 */
export function artistLinks(payload: unknown): readonly ArtistLink[] {
  if (typeof payload !== "object" || payload === null) return [];
  const relations = (payload as { relations?: unknown }).relations;
  if (!Array.isArray(relations)) return [];

  const seen = new Set<string>();
  const out: ArtistLink[] = [];
  for (const entry of relations as readonly RawRelation[]) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry["target-type"] !== "url") continue;
    if (entry.ended === true) continue;
    const relation = typeof entry.type === "string" ? entry.type.toLowerCase() : "";
    if (SKIP.has(relation)) continue;
    const url = resourceOf(entry);
    if (url === null) continue;
    if (seen.has(url)) continue;
    const label = labelFor(relation, url);
    if (label === null) continue;
    seen.add(url);
    out.push({ label, url, relation: relation === "" ? "url" : relation });
  }

  // The official site first, then everything else alphabetically: a stable order, so two
  // renders of the same artist never shuffle the row under the pointer.
  return out.sort((a, b) => {
    const rank = (link: ArtistLink): number => (link.relation === "official homepage" ? 0 : 1);
    return rank(a) - rank(b) || a.label.localeCompare(b.label);
  });
}

/* ------------------------------------------------------------------ */
/* the rest of the cached entity                                       */
/* ------------------------------------------------------------------ */

/** The few facts of the cached artist a header wants, narrowed once. */
export interface ArtistProfile {
  /** MusicBrainz's own "Group", "Person", "Orchestra"… `null` when it did not say. */
  readonly kind: string | null;
  /** The parenthesis MusicBrainz puts after a name to tell two artists apart. */
  readonly disambiguation: string | null;
  /** `life-span.begin` and `.end`, as MusicBrainz writes them: a year, or a full date. */
  readonly began: string | null;
  readonly ended: string | null;
}

function textField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Read `artists_cache.payload` for the header of the artist page.
 *
 * In the same module as `artistLinks` on purpose: `payload` is a `jsonb` column and therefore
 * `unknown`, and every place that narrows it by hand is a place that can narrow it wrongly.
 */
export function artistProfile(payload: unknown): ArtistProfile {
  const empty: ArtistProfile = { kind: null, disambiguation: null, began: null, ended: null };
  if (typeof payload !== "object" || payload === null) return empty;
  const entity = payload as Record<string, unknown>;
  const span = entity["life-span"];
  const lifeSpan =
    typeof span === "object" && span !== null ? (span as Record<string, unknown>) : {};
  return {
    kind: textField(entity, "type"),
    disambiguation: textField(entity, "disambiguation"),
    began: textField(lifeSpan, "begin"),
    ended: textField(lifeSpan, "end"),
  };
}
