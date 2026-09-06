/**
 * The Console's formatting vocabulary, ported from `prototypes/shared/core.js`.
 *
 * Pure functions, no React, no DOM: the components use them, and the unit tests can check
 * them without rendering anything. Every one of them takes the null/undefined case, because
 * every one of them is fed straight from a database column that is allowed to be null.
 */

/** `3:21`, or `1:02:03` past an hour. */
export function mmss(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const head = hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, "0")}` : String(minutes);
  return `${head}:${String(rest).padStart(2, "0")}`;
}

/** A [0, 1] score as `97%`. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${String(Math.round(value * 100))}%`;
}

/** A [0, 1] score as a CSS width, for a bar. */
export function pctWidth(value: number | null | undefined): string {
  const clamped = Math.min(1, Math.max(0, value ?? 0));
  return `${String(Math.round(clamped * 100))}%`;
}

/** `1.4 GB`. Binary units, as every disk tool on the machine reports them. */
export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = size >= 100 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit] ?? "B"}`;
}

/**
 * `12 min ago`.
 *
 * `now` is a parameter rather than a call to `Date.now()` so that a server render and the
 * hydration that follows it cannot disagree, and so the tests are not time-dependent.
 */
export function timeAgo(at: Date | string | null | undefined, now: Date = new Date()): string {
  if (at === null || at === undefined) return "—";
  const then = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(then.getTime())) return "—";
  const seconds = (now.getTime() - then.getTime()) / 1000;
  if (seconds < 0) return "just now";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))} min ago`;
  if (seconds < 86_400) return `${String(Math.floor(seconds / 3600))} h ago`;
  if (seconds < 86_400 * 14) return `${String(Math.floor(seconds / 86_400))} d ago`;
  return then.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** `05 Sep, 18:05`. */
export function dateTime(at: Date | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const value = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(value.getTime())) return "—";
  return value.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `18:05:12` — the timestamp column of the log viewer. */
export function clockTime(at: Date | string | null | undefined): string {
  if (at === null || at === undefined) return "--:--:--";
  const value = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(value.getTime())) return "--:--:--";
  return value.toLocaleTimeString("en-GB", { hour12: false });
}

/** The first eight characters of an MBID — enough to recognise, short enough to sit in a cell. */
export function short(id: string | null | undefined, length = 8): string {
  return id === null || id === undefined || id === "" ? "—" : id.slice(0, length);
}

/** `+2s` / `−3s`. A signed duration difference, with a real minus sign. */
export function delta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const rounded = Math.round(seconds);
  if (rounded === 0) return "0s";
  return rounded > 0 ? `+${String(rounded)}s` : `−${String(Math.abs(rounded))}s`;
}

/** `uncovered_tracks` → `uncovered tracks`. Inbox types are shown as words, not identifiers. */
export function humanise(value: string): string {
  return value.replaceAll("_", " ");
}

/** Total seconds of a list of durations, nulls skipped. */
export function totalSeconds(durations: readonly (number | null | undefined)[]): number {
  return durations.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/** How many cover gradients `styles.css` defines. */
export const COVER_GRADIENTS = 11;

/**
 * Which gradient a thing gets, derived from its id.
 *
 * Stable — the same album is the same colour on every page and after every restart — and
 * cheap. Real artwork replaces this in P07; until then a coloured square is still a better
 * anchor for the eye than eleven identical grey ones.
 */
export function coverIndex(seed: string | null | undefined): number {
  const text = seed ?? "";
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 100_003;
  }
  return (hash % COVER_GRADIENTS) + 1;
}
