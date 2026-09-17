/**
 * The filter and sort vocabularies of the review queue — **client-safe**.
 *
 * Same split, and the same hard reason, as `lib/library-filters.ts`: `/review` and
 * `/review/$id` validate their search parameters against these lists, so the routes import
 * them *as values*, and a value-import of anything under `src/server/` drags Drizzle and
 * `postgres` into the browser bundle. That failure does not read as a bad import — it reads as
 * `Buffer is not defined` at the bottom of the client entry, with no page hydrating and every
 * button silently dead.
 *
 * `server/services/inbox.ts` re-exports `INBOX_SORTS`, so the service keeps one spelling and
 * nothing is duplicated.
 */

/**
 * How the queue is ordered.
 *
 * `recent` is the default and is what the page has always done. `oldest` is the one that
 * matters at three hundred items: the questions that have been waiting longest are the ones
 * holding up imports, and they are precisely the ones a newest-first list buries.
 */
export const INBOX_SORTS = ["recent", "oldest", "type", "title"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];

export const INBOX_SORT_LABELS: Readonly<Record<InboxSort, string>> = Object.freeze({
  recent: "Newest first",
  oldest: "Oldest first",
  type: "By type",
  title: "By title",
});

/**
 * The status filter, as the page spells it.
 *
 * `all` is not a status — the three real ones are `INBOX_STATUSES` in the schema vocabulary —
 * so it lives here, where "what the URL may say" is defined, rather than being smuggled into
 * the database's own enum.
 */
export const INBOX_STATUS_FILTERS = ["open", "resolved", "dismissed", "all"] as const;
export type InboxStatusFilter = (typeof INBOX_STATUS_FILTERS)[number];

export const INBOX_STATUS_LABELS: Readonly<Record<InboxStatusFilter, string>> = Object.freeze({
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
  all: "Any status",
});

/** How many items one page of the queue holds. */
export const INBOX_PAGE_SIZE = 50;
