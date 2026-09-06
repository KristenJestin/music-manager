/**
 * v1's file naming, ported exactly.
 *
 * `v1/apps/WorkerService/Processing/ProcessSongJob.cs` → `GeneratePathAndNameInternal`, plus
 * `v1/apps/WorkerService/Common/FileNameSanitizer.cs`. This is a port and not an improvement:
 * its only job is to predict the path a v1 row *claims*, so that a file on disk can be tied
 * back to the row that wrote it. Every difference from v1 is a track we would fail to
 * recognise, so the oddities are reproduced deliberately:
 *
 *  - the year is appended **after** sanitising, so `Album (2001)` keeps its parentheses even
 *    though `(` and `)` would otherwise be untouched anyway;
 *  - the track number is `:D2` — zero-padded to two digits, and *not* truncated beyond them;
 *  - the disc prefix is `Disc N - ` with **no** padding, and only when `DiscNumber >= 1`;
 *  - the separator is exactly `" - "`, added after sanitisation and never itself sanitised;
 *  - v1 ran in a Linux container, where `Path.GetInvalidFileNameChars()` is `{ '\0', '/' }`.
 *    So `:`, `*`, `?`, `"`, `<`, `>`, `|` and `\` **survive** in v1 paths. That is the single
 *    most surprising fact in this file and the reason `sanitizeV1` takes a platform.
 *
 * Two v1 behaviours cannot be ported and must not be faked: an empty name becomes
 * `default_filename_<4 random hex>` and a name that trims away to nothing becomes
 * `cleaned_file_<8 random hex>`. Those are random, so `predictV1Path` returns `null` for them
 * rather than guessing — such rows reconcile by MBID or by YouTube id, or they are reported.
 */

/** Which `Path.GetInvalidFileNameChars()` v1 was running with. */
export type V1Platform = "linux" | "windows";

/** .NET on Linux: `{ '\0', '/' }` only. */
const LINUX_INVALID = new Set(["\u0000", "/"]);
/** .NET on Windows: the POSIX pair plus these nine. */
const WINDOWS_INVALID = new Set(["\u0000", "/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

const REPLACEMENT = "_";

/**
 * `FileNameSanitizer.SanitizeFileName`, minus the two random fallbacks.
 *
 * Returns `null` exactly where v1 would have produced a GUID-derived name, because those are
 * unpredictable by construction. Consecutive invalid characters collapse into a single `_`,
 * and the result is trimmed of `_`, `.` and space at both ends — in that order, as .NET's
 * `Trim(params char[])` does it.
 */
export function sanitizeV1(raw: string | null | undefined, platform: V1Platform): string | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;

  const invalid = platform === "windows" ? WINDOWS_INVALID : LINUX_INVALID;
  let out = "";
  let lastWasReplacement = false;

  for (const char of raw) {
    // `c < 32` in v1 is a comparison on the UTF-16 code unit, so the control range only.
    const isInvalid = invalid.has(char) || (char.codePointAt(0) ?? 0) < 32;
    if (isInvalid) {
      if (!lastWasReplacement) {
        out += REPLACEMENT;
        lastWasReplacement = true;
      }
      continue;
    }
    out += char;
    lastWasReplacement = false;
  }

  const trimmed = trimChars(out, ["_", ".", " "]);
  return trimmed === "" ? null : trimmed;
}

/** .NET's `string.Trim(char[])`: strip any of the given characters from both ends. */
function trimChars(value: string, chars: readonly string[]): string {
  const set = new Set(chars);
  let start = 0;
  let end = value.length;
  while (start < end && set.has(value[start] ?? "")) start += 1;
  while (end > start && set.has(value[end - 1] ?? "")) end -= 1;
  return value.slice(start, end);
}

/** What `GeneratePathAndNameInternal` needs from a `"Songs"` row. */
export interface V1PathInput {
  readonly id: number;
  readonly title: string | null;
  readonly artist: string | null;
  readonly albumArtists: readonly string[];
  readonly album: string | null;
  readonly year: number | null;
  readonly trackNumber: number | null;
  readonly discNumber: number | null;
}

export interface V1PathParts {
  /** `Artist/Album (2001)` — forward slashes, as v1 stored it. */
  readonly directory: string;
  /** `Disc 2 - 03 - Title` — no extension. */
  readonly stem: string;
  /** `Artist/Album (2001)/Disc 2 - 03 - Title.opus`. */
  readonly path: string;
}

/**
 * Predict the relative path v1 would have written for this row.
 *
 * `null` when v1 would have used one of its random fallbacks — an untitled song, or a name
 * made entirely of characters the sanitiser strips.
 */
export function predictV1Path(
  song: V1PathInput,
  options: { platform?: V1Platform; extension?: string } = {},
): V1PathParts | null {
  const platform = options.platform ?? "linux";
  const extension = options.extension ?? "opus";

  const primaryArtist = song.albumArtists[0] ?? song.artist;
  const artistDir = sanitizeV1(primaryArtist ?? "Unknown Artist", platform);
  const albumName = sanitizeV1(song.album ?? "Unknown Album", platform);
  // `Song_<id>` is v1's deterministic fallback for a null title — that one *is* predictable.
  const title = sanitizeV1(song.title ?? `Song_${String(song.id)}`, platform);
  if (artistDir === null || albumName === null || title === null) return null;

  const albumFolder = song.year === null ? albumName : `${albumName} (${String(song.year)})`;
  const trackNumber = song.trackNumber ?? 1;
  const numbered = `${padD2(trackNumber)} - ${title}`;
  const stem =
    song.discNumber !== null && song.discNumber >= 1
      ? `Disc ${String(song.discNumber)} - ${numbered}`
      : numbered;

  const directory = `${artistDir}/${albumFolder}`;
  return { directory, stem, path: `${directory}/${stem}.${extension}` };
}

/** .NET's `:D2`: at least two digits, zero-padded; longer numbers keep all their digits. */
export function padD2(value: number): string {
  const rounded = Math.trunc(value);
  const sign = rounded < 0 ? "-" : "";
  return `${sign}${String(Math.abs(rounded)).padStart(2, "0")}`;
}

/**
 * Normalise a v1 path for comparison.
 *
 * v1 wrote `Path.Combine(...).Replace('\\','/')`, so a well-formed value is already
 * forward-slashed and root-relative — but a database that has been through a Windows run, a
 * manual edit or a restore may hold backslashes, a leading `./` or a leading separator.
 * Comparison is case-insensitive because the two filesystems this has to work on disagree
 * about case, and a migration that missed a file over `The` versus `the` would be useless.
 */
export function normalizeV1Path(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .trim();
  return value === "" ? null : value;
}

/** The comparison key for a path: normalised, then lower-cased. */
export function pathKey(raw: string | null | undefined): string | null {
  const normalized = normalizeV1Path(raw);
  return normalized === null ? null : normalized.toLowerCase();
}
