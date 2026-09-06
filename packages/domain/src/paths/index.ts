/**
 * Library paths (`docs/04-pipeline-et-matching.md`, step `place`).
 *
 * The layout is `{albumArtist}/{album} ({year})/{disc-}{track:02} - {title}.{ext}`. The disc
 * prefix appears only on multi-disc releases, so a normal album keeps the plain `01 - Title`
 * numbering every player sorts correctly.
 *
 * Sanitisation has three modes, because the same library is served over SMB to Windows, read
 * by Navidrome in a Linux container, and browsed by phones:
 *  - `unicode`  keep everything the filesystem allows, only replacing what is illegal;
 *  - `windows`  additionally drop the characters Windows forbids and the reserved device
 *               names, and trim the trailing dots and spaces Explorer cannot represent;
 *  - `strict`   ASCII only, for the most conservative consumers.
 *
 * Pure string functions; nothing here touches the filesystem.
 */

export type SanitizeMode = "unicode" | "windows" | "strict";

export interface TrackPathInput {
  readonly albumArtist: string;
  readonly album: string;
  /** Release year. Omitted from the folder name when unknown. */
  readonly year?: number | string;
  readonly discNumber?: number;
  readonly totalDiscs?: number;
  readonly trackNumber: number;
  readonly title: string;
  /** Without the dot: "opus", "flac", "m4a". */
  readonly extension: string;
}

export interface PathOptions {
  readonly mode?: SanitizeMode;
  /** Longest single path segment. 255 is the ext4/NTFS limit; leave room for sidecars. */
  readonly maxSegmentLength?: number;
}

/**
 * Control characters, DEL, and the two path separators — illegal on every filesystem.
 * The control range is the point of the rule here, so no-control-regex is disabled: a title
 * arriving with a stray U+0001 from a broken tag is exactly what must be scrubbed.
 */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[\u0000-\u001f\u007f/\\]/g;
/** Additionally forbidden on Windows and over SMB. */
const WINDOWS_ILLEGAL = /[<>:"|?*]/g;
/** Windows device names, which cannot be a file name even with an extension. */
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
/** Unicode combining marks, dropped after NFD in `strict` mode. */
const COMBINING_MARKS = /[̀-ͯ]/g;
/** Anything outside printable ASCII, in `strict` mode. */
const NON_ASCII = /[^ -~]/g;

/** Replacement for a character we cannot keep. A dash reads better than an underscore. */
const REPLACEMENT = "-";

/**
 * Make one path segment safe. Never returns an empty string: a name that sanitises away
 * entirely becomes `_`, so a path is always well-formed.
 */
export function sanitizeSegment(raw: string, options: PathOptions = {}): string {
  const mode = options.mode ?? "windows";
  const max = options.maxSegmentLength ?? 200;

  let value = raw.normalize("NFC").replace(ILLEGAL, REPLACEMENT);

  if (mode === "windows" || mode === "strict") {
    value = value.replace(WINDOWS_ILLEGAL, REPLACEMENT);
  }
  if (mode === "strict") {
    // Fold accents to ASCII, then replace anything still outside printable ASCII.
    value = value.normalize("NFD").replace(COMBINING_MARKS, "").replace(NON_ASCII, REPLACEMENT);
  }

  value = value.replace(/\s+/g, " ").trim();

  if (mode === "windows" || mode === "strict") {
    // Explorer silently drops a trailing dot or space, which breaks every later path compare.
    value = value.replace(/[. ]+$/, "");
    if (WINDOWS_RESERVED.test(value)) value = `${value}${REPLACEMENT}`;
  }

  if (value.length > max)
    value = value
      .slice(0, max)
      .trimEnd()
      .replace(/[. ]+$/, "");
  return value === "" ? "_" : value;
}

/** `Daft Punk/Discovery (2001)` — the album folder, relative to the library root. */
export function albumFolder(input: TrackPathInput, options: PathOptions = {}): string {
  const artist = sanitizeSegment(input.albumArtist, options);
  const year = input.year === undefined ? "" : ` (${String(input.year)})`;
  const album = sanitizeSegment(`${input.album}${year}`, options);
  return `${artist}/${album}`;
}

/** `01 - One More Time.opus` — the file name alone. */
export function trackFileName(input: TrackPathInput, options: PathOptions = {}): string {
  const disc =
    input.totalDiscs !== undefined && input.totalDiscs > 1 && input.discNumber !== undefined
      ? `${String(input.discNumber)}-`
      : "";
  const number = String(input.trackNumber).padStart(2, "0");
  const stem = sanitizeSegment(`${disc}${number} - ${input.title}`, options);
  return `${stem}.${input.extension}`;
}

/** The full relative path: `Daft Punk/Discovery (2001)/01 - One More Time.opus`. */
export function trackPath(input: TrackPathInput, options: PathOptions = {}): string {
  return `${albumFolder(input, options)}/${trackFileName(input, options)}`;
}

export interface SidecarPaths {
  /** `Artist/Album (Year)/cover.jpg` and friends — one per album (§3). */
  readonly cover: string;
  readonly back: string;
  readonly medium: string;
  /** `Artist/artist.jpg`, in the artist folder, not the album's. */
  readonly artistImage: string;
  readonly albumNfo: string;
  readonly artistNfo: string;
  /** `Artist/Album (Year)/01 - One More Time.lrc` — one per track. */
  readonly lyrics: string;
}

/** Every sidecar of §3 for one track, at the paths their readers expect. */
export function sidecarPaths(input: TrackPathInput, options: PathOptions = {}): SidecarPaths {
  const folder = albumFolder(input, options);
  const artist = sanitizeSegment(input.albumArtist, options);
  const stem = trackFileName(input, options).replace(/\.[^.]+$/, "");
  return {
    cover: `${folder}/cover.jpg`,
    back: `${folder}/back.jpg`,
    medium: `${folder}/medium.jpg`,
    artistImage: `${artist}/artist.jpg`,
    albumNfo: `${folder}/album.nfo`,
    artistNfo: `${artist}/artist.nfo`,
    lyrics: `${folder}/${stem}.lrc`,
  };
}

/** `booklet-01.jpg`, `booklet-02.jpg`… in album order (§3). */
export function bookletPath(
  input: TrackPathInput,
  index: number,
  options: PathOptions = {},
): string {
  return `${albumFolder(input, options)}/booklet-${String(index).padStart(2, "0")}.jpg`;
}
