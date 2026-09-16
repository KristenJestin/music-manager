/**
 * Where a picture can be fetched from, and at what size — the pure half of `<Cover>`.
 *
 * It lives in `lib/` rather than in `components/cover.tsx` because two callers are not
 * components: `server/functions/player.ts` builds the queue's `coverUrl` on the server, and
 * the unit tests want the tables without a DOM. Nothing here imports React, so the client
 * boundary guard has nothing to say about it either.
 *
 * ## Asking for the size we are going to draw
 *
 * Every URL is built for a **slot** — the same `size` the `<Cover>` tile is rendered at. A
 * `sm` row avatar is 36 CSS pixels, so it asks `/api/cover` for 160 and the Cover Art Archive
 * for `front-250`; an `xl` album header asks for 320 and `front-500`. `SLOT_SIZES` is the
 * single place those numbers live, so "which cover does this screen fetch" has one answer.
 *
 * The numbers are the rendered width **doubled**, because a 2× display draws 36 CSS pixels
 * with 72 device pixels and an image narrower than that is visibly soft.
 *
 * The one slot with no fixed width is `full`, the album grid, which is between a sixth and a
 * half of the viewport depending on the breakpoint. That one gets a `srcset` and a `sizes`
 * instead of a number, and the browser picks — accounting for its own pixel ratio, which is
 * something no hard-coded number can do.
 */

/** How big the tile is drawn — the `size` prop, named so a source builder can take it too. */
export type CoverSlot = "xs" | "sm" | "md" | "lg" | "xl" | "full";

/** The sizes `/api/cover` and `/api/artist-image` will resize to. */
export type LibraryImageSize = 64 | 160 | 320 | 640;

/** The sizes the Cover Art Archive publishes for a release front. */
export type CoverArtSize = 250 | 500 | 1200;

export interface SlotSizes {
  /** Rendered width in CSS pixels, for the reader more than for the code. */
  readonly css: number;
  /** What `/api/cover` is asked for: `css × 2`, rounded up to the closed set. */
  readonly local: LibraryImageSize;
  /** What the Cover Art Archive is asked for, out of the three it publishes. */
  readonly remote: CoverArtSize;
}

/**
 * Rendered width → what to fetch. `css` is the `w-*` of `coverVariants` in pixels; the other
 * two are the smallest value of each provider's own set that still covers `css × 2`.
 *
 * `full` has no width of its own — the grid decides — so it carries the largest of each set as
 * the *fallback* `src`, and the `srcset` is what the browser actually uses.
 */
export const SLOT_SIZES: Readonly<Record<CoverSlot, SlotSizes>> = {
  xs: { css: 24, local: 64, remote: 250 },
  sm: { css: 36, local: 160, remote: 250 },
  md: { css: 56, local: 160, remote: 250 },
  lg: { css: 96, local: 320, remote: 250 },
  xl: { css: 160, local: 320, remote: 500 },
  full: { css: 0, local: 640, remote: 1200 },
};

/**
 * What one grid cell is worth, per breakpoint.
 *
 * `/library`'s grid is `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6` inside the
 * shell, which keeps a fixed sidebar, so a column is a little narrower than `100vw / columns`.
 * Rounding *up* is the safe direction — an over-wide guess costs a few kilobytes, an
 * under-wide one is a blurry tile — so these are the plain fractions of the viewport.
 */
export const ALBUM_GRID_SIZES =
  "(min-width: 1280px) 16vw, (min-width: 1024px) 19vw, (min-width: 640px) 32vw, 48vw";

/** The widths `/api/cover` is offered for a grid cell. */
export const GRID_LOCAL_WIDTHS: readonly LibraryImageSize[] = [160, 320, 640];

/** The widths the Cover Art Archive is offered for a grid cell. */
export const GRID_REMOTE_WIDTHS: readonly CoverArtSize[] = [250, 500, 1200];

/* ------------------------------------------------------------------ */
/* candidates                                                          */
/* ------------------------------------------------------------------ */

/**
 * One place the picture may be, with the responsive variants of it when there are any.
 *
 * A bare string is the same thing without them, and every call site that passes a YouTube
 * thumbnail keeps working unchanged.
 */
export interface CoverCandidate {
  readonly url: string;
  readonly srcSet?: string;
  readonly sizes?: string;
}

export type CoverSource = string | CoverCandidate;

/** Normalise either shape to a candidate. */
export function coverCandidate(entry: CoverSource): CoverCandidate {
  return typeof entry === "string" ? { url: entry } : entry;
}

/**
 * The Cover Art Archive's front for a release, as a URL.
 *
 * It answers a redirect to archive.org for a release that has one and a 404 for a release that
 * does not, which is exactly the signal `<Cover>` needs: no probe request, no server round
 * trip, the browser's own load either works or falls back to the gradient.
 */
export function coverArtFront(
  mbid: string | null | undefined,
  size: CoverArtSize = 250,
): string | null {
  if (mbid === null || mbid === undefined) return null;
  const trimmed = mbid.trim();
  if (trimmed === "") return null;
  return `https://coverartarchive.org/release/${trimmed}/front-${String(size)}`;
}

/**
 * The library's own `cover.jpg` for an album, as a URL.
 *
 * The path is never in the URL: the endpoint takes an album id and resolves the file from the
 * row, so a library path can neither leak into a link nor be walked out of. It answers a 404
 * when the album has no cover file, which is the same signal a missing Cover Art Archive front
 * gives — the tile simply moves to the next candidate.
 *
 * `size` names one of the four widths `services/image-variants.ts` will resize to. Leaving it
 * out asks for the file as it is on disk, which is what a download wants and no tile does.
 */
export function libraryCover(
  albumId: string | null | undefined,
  size?: LibraryImageSize,
): string | null {
  if (albumId === null || albumId === undefined) return null;
  const trimmed = albumId.trim();
  if (trimmed === "") return null;
  const suffix = size === undefined ? "" : `&size=${String(size)}`;
  return `/api/cover?album=${encodeURIComponent(trimmed)}${suffix}`;
}

/**
 * The library's own `artist.jpg` for an artist, as a URL.
 *
 * The path is never in the URL: the endpoint takes an artist name and resolves the file from
 * the row that folder belongs to, exactly like `libraryCover` does for an album id. A 404
 * means the artist has no local image, which is the same signal `<Cover>` already knows how
 * to fall through on.
 */
export function libraryArtistImage(
  name: string | null | undefined,
  size?: LibraryImageSize,
): string | null {
  if (name === null || name === undefined) return null;
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const suffix = size === undefined ? "" : `&size=${String(size)}`;
  return `/api/artist-image?artist=${encodeURIComponent(trimmed)}${suffix}`;
}

/** Just enough of an album row to say where its picture could come from. */
export interface AlbumCoverSource {
  readonly id?: string | null;
  readonly releaseMbid?: string | null;
  /**
   * `library_albums.cover_path`. Only its *presence* is used — the endpoint resolves the real
   * path — but gating on it keeps a list of sixty rows from asking for sixty covers that are
   * known not to exist.
   */
  readonly coverPath?: string | null;
}

/**
 * Where an album's picture may be found, best first: the file on disk, then the Cover Art
 * Archive. Hand the result straight to `<Cover src={…}>`; the gradient is the last resort.
 *
 * One function, used by every screen that shows an album or one of its tracks, so "which cover
 * does a track show" has a single answer rather than one per page — and, since `slot` is the
 * same value as the tile's `size`, a single answer to how many bytes that costs.
 */
export function albumCoverSources(
  album: AlbumCoverSource | null | undefined,
  slot: CoverSlot = "sm",
): readonly CoverSource[] {
  if (album === null || album === undefined) return [];
  const sizes = SLOT_SIZES[slot];
  const hasFile =
    album.coverPath !== null && album.coverPath !== undefined && album.coverPath.trim() !== "";

  const placed = hasFile ? libraryCover(album.id, sizes.local) : null;
  const remote = coverArtFront(album.releaseMbid, sizes.remote);

  if (slot !== "full") {
    return [placed, remote].filter((entry): entry is string => entry !== null);
  }

  const candidates: CoverCandidate[] = [];
  if (placed !== null) {
    candidates.push({
      url: placed,
      srcSet: GRID_LOCAL_WIDTHS.map(
        (width) => `${String(libraryCover(album.id, width))} ${String(width)}w`,
      ).join(", "),
      sizes: ALBUM_GRID_SIZES,
    });
  }
  if (remote !== null) {
    candidates.push({
      url: remote,
      srcSet: GRID_REMOTE_WIDTHS.map(
        (width) => `${String(coverArtFront(album.releaseMbid, width))} ${String(width)}w`,
      ).join(", "),
      sizes: ALBUM_GRID_SIZES,
    });
  }
  return candidates;
}

const COMMONS_FILEPATH = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const UPLOAD_ORIGINAL =
  /^(https:\/\/upload\.wikimedia\.org\/[^?#]*?\/)([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/;
const UPLOAD_THUMB = /^(https:\/\/upload\.wikimedia\.org\/[^?#]*\/thumb\/[^?#]+\/)\d+px-([^/?#]+)$/;

/**
 * The same remote picture, asked for at a width, when the host knows how to do that.
 *
 * `artists_cache.image_url` holds whatever `integrations/wikimedia.ts` found, and that is three
 * different kinds of URL:
 *
 * - **Commons `Special:FilePath`** — what `commonsUrl()` writes, at `width=1000`. The endpoint
 *   takes `?width=` and answers a resized JPEG, so this is a pure rewrite: no proxying, no
 *   cache of ours, Wikimedia's own thumbnailer does work it already does for everyone. A
 *   160 px portrait instead of a 1000 px one is the artists page in a fraction of the bytes.
 * - **`upload.wikimedia.org`** — the direct file, or an existing `/thumb/…/NNNpx-` form. Both
 *   rewrite to the thumb form at the width we want. (An SVG thumbnails to PNG, hence the
 *   suffix; a photograph never is one, but a MusicBrainz "image" relation can point anywhere.)
 * - **fanart.tv**, and anything else — left **verbatim**. `artistthumb` is already about
 *   1000 px and fanart.tv publishes no documented width parameter, so guessing one would turn
 *   a working picture into a 404. The right answer there is the `artist.jpg` sidecar
 *   (`services/artist-image.ts`) that `/api/artist-image` serves resized, and that is the
 *   first candidate anyway.
 */
export function remoteImageAtWidth(url: string, width: number): string {
  if (url.startsWith(COMMONS_FILEPATH)) {
    const [base = url, query = ""] = url.split("?", 2);
    const params = new URLSearchParams(query);
    params.set("width", String(width));
    return `${base}?${params.toString()}`;
  }

  const thumb = UPLOAD_THUMB.exec(url);
  if (thumb !== null) return `${thumb[1] ?? ""}${String(width)}px-${thumb[2] ?? ""}`;

  const original = UPLOAD_ORIGINAL.exec(url);
  if (original !== null) {
    const [, prefix = "", first = "", second = "", file = ""] = original;
    if (prefix.includes("/thumb/")) return url;
    const name = file.toLowerCase().endsWith(".svg") ? `${file}.png` : file;
    return `${prefix}thumb/${first}/${second}/${file}/${String(width)}px-${name}`;
  }

  return url;
}

/** Just enough of an artist row to say where its picture could come from. */
export interface ArtistImageSource {
  readonly name?: string | null;
  /** `artists_cache.image_url` — a remote URL, Wikimedia or fanart.tv. */
  readonly imageUrl?: string | null;
}

/**
 * Where an artist's picture may be found, best first: the `artist.jpg` placed beside their
 * folder, then the remote URL `artists_cache` recorded (§3). Hand the result straight to
 * `<Cover src={…}>`, the same way `albumCoverSources` feeds an album tile.
 */
export function artistImageSources(
  artist: ArtistImageSource | null | undefined,
  slot: CoverSlot = "sm",
): readonly CoverSource[] {
  if (artist === null || artist === undefined) return [];
  const sizes = SLOT_SIZES[slot];
  const remote =
    artist.imageUrl === null || artist.imageUrl === undefined || artist.imageUrl === ""
      ? null
      : remoteImageAtWidth(artist.imageUrl, sizes.local);
  return [libraryArtistImage(artist.name, sizes.local), remote].filter(
    (entry): entry is string => entry !== null,
  );
}

/**
 * The best candidate as a plain URL.
 *
 * The player bar shows one 36 px tile and its queue entries carry a single `coverUrl` string,
 * so it takes the head of the list rather than the list itself. `sm` is that tile's slot, so
 * the URL it gets is already the 160 px variant.
 */
export function primaryCoverUrl(sources: readonly CoverSource[]): string | null {
  const first = sources[0];
  return first === undefined ? null : coverCandidate(first).url;
}
