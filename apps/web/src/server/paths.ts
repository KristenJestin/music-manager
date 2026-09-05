/**
 * Host ↔ container path translation.
 *
 * The orchestrator runs on the host (Windows, in development) and the toolbox runs in Linux,
 * looking at the *same* directory through a bind mount. Two settings name the two ends —
 * `MM_LIBRARY_ROOT` and `MM_TOOLBOX_LIBRARY_ROOT` — and every path crossing the bridge is
 * rewritten between them. Nothing else works: `D:\…\.local\library\Daft Punk` is meaningless
 * inside the container and `/library/Daft Punk` is meaningless to `node:fs` on Windows.
 *
 * Everything the database stores is **library-relative with `/` separators**, so a row is
 * portable between the two worlds and between machines.
 *
 * Pure string functions over an explicit `PathMap`; the filesystem is never touched here.
 */
import { isAbsolute, resolve, sep } from "node:path";

export interface PathMap {
  /** Library root as this process sees it. Absolute after `pathMap()` has normalised it. */
  readonly host: string;
  /** Library root as the toolbox sees it, always POSIX. */
  readonly container: string;
  /** Work directory, relative to both roots. */
  readonly workDir: string;
}

/** Normalise `\` to `/` and collapse the duplicates a joined path picks up. */
export function toPosix(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

/** Drop a trailing separator so that joins never produce `//`. */
function trimTrailing(value: string): string {
  return value.length > 1 ? value.replace(/[/\\]+$/, "") : value;
}

/**
 * Build the map from the two roots. The host root is resolved against `cwd` so that the
 * default `./.local/library` works from the repository root, from `apps/web`, and from a
 * `bun run` script alike.
 */
export function pathMap(options: {
  host: string;
  container: string;
  workDir?: string;
  cwd?: string;
}): PathMap {
  const host = isAbsolute(options.host)
    ? trimTrailing(options.host)
    : trimTrailing(resolve(options.cwd ?? process.cwd(), options.host));
  return {
    host,
    container: trimTrailing(toPosix(options.container)),
    workDir: options.workDir ?? ".mm-work",
  };
}

/** `Daft Punk/Discovery (2001)/01 One More Time.opus` → the absolute host path. */
export function hostPath(map: PathMap, relative: string): string {
  const clean = toPosix(relative).replace(/^\/+/, "");
  const joined = `${toPosix(map.host)}/${clean}`;
  // Give Windows back its own separator: `node:fs` accepts both, humans and logs do not.
  return sep === "\\" ? joined.replace(/\//g, "\\") : joined;
}

/** The same relative path, as the toolbox must be told about it. */
export function containerPath(map: PathMap, relative: string): string {
  const clean = toPosix(relative).replace(/^\/+/, "");
  return `${map.container}/${clean}`;
}

/**
 * Turn any absolute path from either side back into a library-relative one.
 * Returns `null` when the path is outside the library — a caller must decide what that means
 * rather than silently storing an absolute path in a row.
 */
export function toRelative(map: PathMap, absolute: string): string | null {
  const value = toPosix(absolute);
  for (const root of [toPosix(map.host), map.container]) {
    const prefix = `${root}/`;
    // Windows paths are case-insensitive; comparing case-sensitively would fail on `D:` vs `d:`.
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) return value.slice(prefix.length);
    if (value.toLowerCase() === root.toLowerCase()) return "";
  }
  return null;
}

/** Rewrite an absolute path the toolbox returned into an absolute host path. */
export function fromToolbox(map: PathMap, absolute: string): string {
  const relative = toRelative(map, absolute);
  return relative === null ? absolute : hostPath(map, relative);
}

/** Rewrite an absolute host path into the one the toolbox must receive. */
export function toToolbox(map: PathMap, absolute: string): string {
  const relative = toRelative(map, absolute);
  return relative === null ? toPosix(absolute) : containerPath(map, relative);
}

/** `.mm-work/imp_01H…` — where one import's downloads live before `place` moves them. */
export function workFolder(map: PathMap, importId: string): string {
  return `${map.workDir}/${importId}`;
}
