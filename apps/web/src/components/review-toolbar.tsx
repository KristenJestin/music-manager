/**
 * Everything that narrows the review queue, in one row.
 *
 * ## Why this is not a fork of the library toolbar
 *
 * It *is* the library toolbar. `FilterToolbar` takes the search box, the preset chips and a
 * trailing block of selects, and all three are exactly what this page needs; the only thing
 * left here is deciding what goes in each slot. Nothing about the chips, the counts, the
 * "a count of zero is information" rule or the `role="search"` landmark is restated.
 *
 * The one thing that could not be reused is `FilterConditions`, the `?f=` tree. An Inbox item
 * has five columns worth filtering on and two of them are closed vocabularies; a condition
 * builder over that would be a heavier way of saying what two controls already say, and it
 * would need a whitelist and a compiler on the server to boot. So `conditions` is left unset,
 * which is precisely what the prop being optional is for.
 *
 * ## Which filter is a chip and which is a select
 *
 * **Type is the chips**, because it is the filter the page exists for: with 307 open items of
 * which 168 are verification mismatches, the 40 edition decisions are invisible until their
 * number is on screen. But there are fourteen types, and fourteen chips is a scrolling row
 * nobody reads — so the chips are the types **you actually have**, read off the counts, plus
 * `All`. A queue holding four kinds of question shows five chips.
 *
 * **Status is a select**, because it is a mode rather than a view: `open` is the answer
 * essentially always, and the other three exist to look something up afterwards. Its counts go
 * in the option labels, which is where a number that is consulted rather than scanned belongs.
 *
 * ## What it must not do
 *
 * Nothing here reads a loader. Every control comes from `params`, so a route can render this
 * for real while its rows are still in flight and hand the counts in later as `null`.
 */
import { useNavigate } from "@tanstack/react-router";
import { FilterToolbar } from "#/components/library/filter-toolbar.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";
import { humanise } from "#/lib/format.ts";
import {
  INBOX_SORT_LABELS,
  INBOX_SORTS,
  INBOX_STATUS_FILTERS,
  INBOX_STATUS_LABELS,
  type InboxSearch,
  type InboxStatusFilter,
} from "#/lib/inbox-filters.ts";
import { INBOX_TYPES, type InboxStatus, type InboxType } from "#/server/db/schema/enums.vocab.ts";
import { useTestId } from "#/components/pending-tree.tsx";

export interface ReviewToolbarProps {
  readonly params: InboxSearch;
  /** One number per type, with the type filter lifted. `null` while the loader runs. */
  readonly byType: Record<InboxType, number> | null;
  /** One number per status, with the status filter lifted. `null` while the loader runs. */
  readonly byStatus: Record<InboxStatus, number> | null;
}

/** `all`, then every type the queue actually holds — and the selected one even if it holds none. */
function typeChips(
  params: InboxSearch,
  byType: Record<InboxType, number> | null,
): readonly ("all" | InboxType)[] {
  const present = INBOX_TYPES.filter((type) => (byType?.[type] ?? 0) > 0 || params.type === type);
  return ["all", ...present];
}

/** What the badge on a queue row says, so the chip and the row read the same word. */
const label = (type: "all" | InboxType): string => {
  if (type === "all") return "All";
  const words = humanise(type);
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function ReviewToolbar({ params, byType, byStatus }: ReviewToolbarProps) {
  const navigate = useNavigate();
  /*
   * `/review` draws this toolbar **for real** in its pending component as well as in its
   * settled one (`ReviewScreenSkeleton`), so a navigation that re-suspends the loader — a type
   * chip, a sort, a page — has both copies mounted at once. `review-search` and the
   * `review-types` chips come out scoped already, because `SearchInput` and `PresetGroup` call
   * this hook themselves; these two Selects write their identifier here and would otherwise be
   * the two that name two elements at a time.
   */
  const scoped = useTestId();

  /** Every control resets the page: "page 4" of a set with one page is an empty queue. */
  const to = (patch: Partial<InboxSearch>): { to: "/review"; search: InboxSearch } => ({
    to: "/review",
    search: { ...params, ...patch, page: 0 },
  });

  const total =
    byType === null ? null : INBOX_TYPES.reduce((sum, type) => sum + (byType[type] ?? 0), 0);

  return (
    <FilterToolbar
      search={{
        value: params.q,
        label: "Search the review queue",
        placeholder: "Search titles, summaries, types…",
        testId: "review-search",
        onSubmit: (q) => {
          void navigate(to({ q }));
        },
      }}
      presets={{
        chips: typeChips(params, byType).map((type) => ({
          value: type,
          label: label(type),
          count: type === "all" ? total : (byType?.[type] ?? null),
        })),
        active: params.type ?? "all",
        testId: "review-types",
        // `type: undefined` for `all`: absent means every type, and the router drops the key.
        link: (type) => to(type === "all" ? { type: undefined } : { type }),
      }}
    >
      <Select
        value={params.status}
        onValueChange={(next: string | null) => {
          if (next === null) return;
          void navigate(to({ status: next as InboxStatusFilter }));
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid={scoped("review-status")}
          aria-label="Filter by status"
          className="max-w-36 border-line bg-surface-1 text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {INBOX_STATUS_LABELS[params.status]}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {INBOX_STATUS_FILTERS.map((status) => (
            <SelectItem key={status} value={status} className="text-xs">
              {INBOX_STATUS_LABELS[status]}
              <span className="ml-2 font-mono text-2xs text-fg-3 tabular-nums">
                {status === "all"
                  ? byStatus === null
                    ? "–"
                    : byStatus.open + byStatus.resolved + byStatus.dismissed
                  : (byStatus?.[status] ?? "–")}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={params.sort}
        onValueChange={(next: string | null) => {
          if (next === null) return;
          void navigate(to({ sort: next as InboxSearch["sort"] }));
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid={scoped("review-sort")}
          aria-label="Sort the review queue"
          className="max-w-36 border-line bg-surface-1 text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {INBOX_SORT_LABELS[params.sort]}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {INBOX_SORTS.map((sort) => (
            <SelectItem key={sort} value={sort} className="text-xs">
              {INBOX_SORT_LABELS[sort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterToolbar>
  );
}
