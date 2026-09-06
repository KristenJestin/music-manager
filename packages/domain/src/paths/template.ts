/**
 * The library layout, as a template (`docs/07-ui.md`, Settings › Library & files).
 *
 * `./index.ts` fixes one layout — `{albumArtist}/{album} ({year})/{disc-}{track:02} {title}.{ext}`
 * — and that is still the default and still what every test asserts. This file makes it
 * *configurable*, because the shape of a music library is one of the few things a self-hosted
 * app genuinely must not decide for you: somebody's Navidrome, somebody's phone and somebody's
 * twenty-year-old naming habit all have a vote, and none of them is wrong.
 *
 * Three properties are not negotiable, so they are enforced here rather than left to the
 * template:
 *
 *  - **`/` is the only separator, and each segment is sanitised separately.** A template
 *    cannot smuggle a `..` or a colon into a path: substitution happens first, the split on
 *    `/` happens second, and `sanitizeSegment` runs on every piece.
 *  - **A segment is never empty.** `{year}` on a release with no year would leave `Album ()`,
 *    so empty bracket groups are collapsed before sanitising — the folder is `Album`, not
 *    `Album ()` and not `Album (undefined)`.
 *  - **The file always ends in the real extension.** `{ext}` is substituted from the file we
 *    actually have; a template that omits it gets it appended, because a library of extensionless
 *    files is not a preference, it is a bug.
 *
 * `renderPathTemplate(DEFAULT_PATH_TEMPLATE, …)` is byte-for-byte `trackPath(…)`. That is a
 * unit test, not a claim: it is what lets the setting default to "the layout P01 shipped" and
 * lets `place` route through one function instead of two.
 */

import { sanitizeSegment, type PathOptions, type TrackPathInput } from "./index.ts";

/** What `./index.ts` builds, written as a template. The default value of the setting. */
export const DEFAULT_PATH_TEMPLATE =
  "{albumArtist}/{album} ({year})/{disc-}{track:02} {title}.{ext}";

/**
 * How a multi-disc release is numbered.
 *
 *  - `prefix`      `Album/1-01 Title.opus` — one folder, disc in the file name (the default);
 *  - `folder`      `Album/Disc 1/01 Title.opus` — one folder per disc;
 *  - `continuous`  `Album/01 Title.opus` — no disc anywhere, for releases numbered straight
 *                  through. Only choose it if the tracks really are numbered that way, or two
 *                  discs will both claim `01`.
 */
export const DISC_MODES = ["prefix", "folder", "continuous"] as const;
export type DiscMode = (typeof DISC_MODES)[number];

export interface TemplateOptions extends PathOptions {
  readonly discMode?: DiscMode;
}

/** Extra values a template may reference that are not part of the path input proper. */
export interface TemplateExtras {
  /** `{mbid}` — the recording or track MBID, for people who file by identifier. */
  readonly mbid?: string | null;
  /** `{artist}` — the *track* artist, which differs from the album artist on compilations. */
  readonly artist?: string | null;
}

export interface TemplateToken {
  readonly token: string;
  readonly description: string;
}

/** Every token, with what it means. The Settings page lists exactly this. */
export const PATH_TOKENS: readonly TemplateToken[] = Object.freeze([
  { token: "{albumArtist}", description: "Album artist — the folder most libraries group by." },
  { token: "{album}", description: "Album title." },
  { token: "{year}", description: "Release year. Empty brackets are removed when unknown." },
  { token: "{disc}", description: "Disc number, unpadded." },
  {
    token: "{disc-}",
    description:
      "Disc prefix — `1-` on a multi-disc release, nothing otherwise. Honours the multi-disc setting.",
  },
  { token: "{track}", description: "Track number, unpadded." },
  { token: "{track:02}", description: "Track number, zero-padded to that width (`02`, `03`…)." },
  { token: "{title}", description: "Track title." },
  {
    token: "{artist}",
    description: "Track artist — differs from the album artist on compilations.",
  },
  { token: "{ext}", description: "File extension, from the file we actually have." },
  { token: "{mbid}", description: "MusicBrainz recording id." },
]);

/** Tokens that must appear, or two tracks would collide on one path. */
const REQUIRED = ["{title}"] as const;

export interface TemplateCheck {
  readonly ok: boolean;
  /** Tokens in the template that mean nothing. */
  readonly unknown: readonly string[];
  /** Required tokens the template does not use. */
  readonly missing: readonly string[];
  /** Human-readable reason, empty when `ok`. */
  readonly reason: string;
}

const TOKEN_PATTERN = /\{[^{}]+\}/g;
const KNOWN = new Set(PATH_TOKENS.map((entry) => entry.token));

/**
 * Is this template usable?
 *
 * A template is rejected for exactly two reasons: it uses a token that does not exist (a typo
 * would otherwise become a literal `{albumartist}` in every folder name), or it omits
 * `{title}`, without which every track of an album competes for the same file name.
 */
export function validatePathTemplate(template: string): TemplateCheck {
  const used = template.match(TOKEN_PATTERN) ?? [];
  const unknown = [
    ...new Set(used.filter((token) => !KNOWN.has(token) && !/^\{track:0\d\}$/.test(token))),
  ];
  const missing = REQUIRED.filter((token) => !template.includes(token));
  const reasons = [
    unknown.length === 0 ? null : `unknown token(s): ${unknown.join(", ")}`,
    missing.length === 0 ? null : `missing token(s): ${missing.join(", ")}`,
    template.trim() === "" ? "the template is empty" : null,
  ].filter((reason): reason is string => reason !== null);

  return {
    ok: reasons.length === 0,
    unknown,
    missing,
    reason: reasons.join("; "),
  };
}

/** `Album ()` → `Album`, `Album []` → `Album`. Run before sanitising, per segment. */
function collapseEmptyGroups(value: string): string {
  return value
    .replace(/\s*\(\s*\)/g, "")
    .replace(/\s*\[\s*\]/g, "")
    .replace(/\s*\{\s*\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * A separator that came out of a *value* is not a separator.
 *
 * `AC/DC` is a band, not two folders. Substituted values therefore have their slashes swapped
 * for a control character before the template is split on `/`; `sanitizeSegment` then turns
 * that control character into the same dash it gives every other illegal character. Splitting
 * first and substituting second would have been the other way to do it and is harder to read.
 */
const SEPARATOR_SENTINEL = String.fromCharCode(1);

function safe(value: string): string {
  return value.replace(/[/\\]/g, SEPARATOR_SENTINEL);
}

function substitute(
  template: string,
  input: TrackPathInput,
  discMode: DiscMode,
  extras: TemplateExtras,
): string {
  const multiDisc = (input.totalDiscs ?? 1) > 1 && input.discNumber !== undefined;
  const discPrefix = multiDisc && discMode === "prefix" ? `${String(input.discNumber)}-` : "";

  return template.replace(TOKEN_PATTERN, (token) => {
    const padded = /^\{track:0(\d)\}$/.exec(token);
    if (padded !== null) {
      return String(input.trackNumber).padStart(Number(padded[1] ?? "2"), "0");
    }
    switch (token) {
      case "{albumArtist}":
        return safe(input.albumArtist);
      case "{album}":
        return safe(input.album);
      case "{year}":
        return input.year === undefined ? "" : String(input.year);
      case "{disc}":
        return input.discNumber === undefined ? "" : String(input.discNumber);
      case "{disc-}":
        return discPrefix;
      case "{track}":
        return String(input.trackNumber);
      case "{title}":
        return safe(input.title);
      case "{artist}":
        return safe(extras.artist ?? input.albumArtist);
      case "{ext}":
        return input.extension;
      case "{mbid}":
        return safe(extras.mbid ?? "");
      default:
        // Unreachable for a validated template; a literal is the least surprising fallback.
        return token;
    }
  });
}

/**
 * Render a template into a library-relative path.
 *
 * The extension is enforced rather than trusted: whatever the template produced, the result
 * ends in `.{extension}` exactly once.
 */
export function renderPathTemplate(
  template: string,
  input: TrackPathInput,
  options: TemplateOptions = {},
  extras: TemplateExtras = {},
): string {
  const discMode = options.discMode ?? "prefix";
  const raw = substitute(template, input, discMode, extras);

  const segments = raw
    .split("/")
    .map((segment) => collapseEmptyGroups(segment))
    .filter((segment) => segment !== "");

  const last = segments.pop() ?? `${input.trackNumber} ${input.title}.${input.extension}`;

  /* `folder` mode puts the disc between the album folder and the file. */
  const multiDisc = (input.totalDiscs ?? 1) > 1 && input.discNumber !== undefined;
  if (multiDisc && discMode === "folder") {
    segments.push(`Disc ${String(input.discNumber)}`);
  }

  const suffix = `.${input.extension}`;
  const stem = last.endsWith(suffix) ? last.slice(0, -suffix.length) : last;

  const folders = segments.map((segment) => sanitizeSegment(segment, options));
  const file = `${sanitizeSegment(stem, options)}${suffix}`;

  return [...folders, file].join("/");
}

/**
 * The album folder a template produces — the path minus the file, and minus the per-disc
 * folder when there is one.
 *
 * The album row and `cover.jpg` both need "the album's directory", and on a `folder`-mode
 * multi-disc release that is the *parent* of where the tracks are: one album, one cover, one
 * row, however many discs.
 */
export function renderAlbumFolder(
  template: string,
  input: TrackPathInput,
  options: TemplateOptions = {},
  extras: TemplateExtras = {},
): string {
  const path = renderPathTemplate(template, input, options, extras);
  const parts = path.split("/");
  parts.pop();
  const discMode = options.discMode ?? "prefix";
  const multiDisc = (input.totalDiscs ?? 1) > 1 && input.discNumber !== undefined;
  if (multiDisc && discMode === "folder") parts.pop();
  return parts.join("/");
}

/**
 * Two worked examples for the Settings preview — a plain album and a multi-disc one.
 *
 * They live here rather than in the route so that the preview cannot drift from the renderer:
 * whatever this function says is what `place` will do.
 */
export function previewPathTemplate(
  template: string,
  options: TemplateOptions = {},
): readonly { label: string; path: string }[] {
  const single: TrackPathInput = {
    albumArtist: "Daft Punk",
    album: "Discovery",
    year: 2001,
    trackNumber: 1,
    title: "One More Time",
    extension: "opus",
  };
  const double: TrackPathInput = {
    albumArtist: "Justice",
    album: "Woman",
    year: 2016,
    discNumber: 1,
    totalDiscs: 2,
    trackNumber: 1,
    title: "Safe and Sound",
    extension: "opus",
  };
  const undated: TrackPathInput = {
    albumArtist: "Unknown Artist",
    album: "Untitled",
    trackNumber: 7,
    title: "Track Seven",
    extension: "opus",
  };
  return [
    { label: "single disc", path: renderPathTemplate(template, single, options) },
    { label: "multi-disc", path: renderPathTemplate(template, double, options) },
    { label: "no year", path: renderPathTemplate(template, undated, options) },
  ];
}
