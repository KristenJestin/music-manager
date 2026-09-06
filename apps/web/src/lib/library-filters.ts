/**
 * The filter and sort vocabularies of the library pages — **client-safe**.
 *
 * They live here rather than beside the queries that use them for one hard reason. A route
 * validates its search parameters against these lists, so the route imports them *as values*;
 * and an import of a value from a module under `src/server/` is an import of that whole
 * module into the browser bundle, Drizzle and `postgres` included. That failure does not look
 * like a bad import — it looks like `Buffer is not defined` at the bottom of the client
 * entry, React never hydrates, and every button on every page silently stops working.
 *
 * `server/services/library.ts` and `server/services/quality.ts` re-export these, so the
 * queries keep their single spelling and nothing is duplicated.
 */

export const ALBUM_FILTERS = [
  "all",
  "incomplete",
  "untagged",
  "nocover",
  "ytcover",
  "schema",
] as const;
export type AlbumFilter = (typeof ALBUM_FILTERS)[number];

export const ALBUM_SORTS = ["recent", "artist", "year", "score"] as const;
export type AlbumSort = (typeof ALBUM_SORTS)[number];

export const TRACK_FILTERS = ["all", "nolyrics", "noreplaygain", "schema", "untagged"] as const;
export type TrackFilter = (typeof TRACK_FILTERS)[number];

export const QUALITY_FILTERS = [
  "all",
  "below80",
  "incomplete",
  "untagged",
  "schema",
  "drift",
  "lyrics",
  "ytcover",
  "replaygain",
] as const;
export type QualityFilter = (typeof QUALITY_FILTERS)[number];

export const QUALITY_FILTER_LABELS: Readonly<Record<QualityFilter, string>> = Object.freeze({
  all: "All",
  below80: "Below 80%",
  incomplete: "Incomplete",
  untagged: "Untagged",
  schema: "Behind schema",
  drift: "Drift",
  lyrics: "No lyrics",
  ytcover: "YouTube cover",
  replaygain: "No ReplayGain",
});
