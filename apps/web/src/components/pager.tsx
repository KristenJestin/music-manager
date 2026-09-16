/**
 * The footer of a paged table: "51–100 of 388", and two arrows.
 *
 * `/library/tracks` grew this inline and `/imports` needed exactly the same thing, so it lives
 * here rather than being written twice with two different off-by-ones. The page itself is
 * never held in component state — every caller keeps it in the URL, so a reload and a shared
 * link land on the same page — and this component only says which way to move.
 *
 * The arrows are icon-only, so they carry an `aria-label` and are ordinary buttons: reachable
 * by Tab, pressable by Space, disabled at the ends rather than merely inert.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";

export interface PagerProps {
  /** Zero-based. */
  readonly page: number;
  readonly pageSize: number;
  /** Rows in the whole filtered set, not on this page. */
  readonly total: number;
  /** Rows actually rendered on this page. */
  readonly shown: number;
  readonly onPage: (page: number) => void;
  /** What the rows are called, for the labels a screen reader reads out. */
  readonly noun?: string;
  readonly "data-testid"?: string;
}

export function Pager({
  page,
  pageSize,
  total,
  shown,
  onPage,
  noun = "rows",
  "data-testid": testId = "pager",
}: PagerProps) {
  const from = page * pageSize;
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  const atStart = page <= 0;
  const atEnd = from + shown >= total;

  return (
    <div
      data-testid={testId}
      data-page={page}
      className="flex items-center justify-between border-t border-line px-3 py-1.5 text-2xs text-fg-2"
    >
      <span data-testid={`${testId}-range`}>
        {total === 0 ? 0 : from + 1}–{Math.min(total, from + shown)} of {total}
        {total === 0 ? "" : ` ${noun}`}
        {last > 0 ? (
          <span className="ml-2 text-fg-3">
            page {page + 1} of {last + 1}
          </span>
        ) : null}
      </span>
      <span className="flex gap-1.5">
        <Button
          size="xs"
          variant="outline"
          aria-label={`Previous page of ${noun}`}
          data-testid={`${testId}-prev`}
          disabled={atStart}
          onClick={() => {
            onPage(page - 1);
          }}
        >
          <ChevronLeft className="size-3" aria-hidden="true" />
        </Button>
        <Button
          size="xs"
          variant="outline"
          aria-label={`Next page of ${noun}`}
          data-testid={`${testId}-next`}
          disabled={atEnd}
          onClick={() => {
            onPage(page + 1);
          }}
        >
          <ChevronRight className="size-3" aria-hidden="true" />
        </Button>
      </span>
    </div>
  );
}
