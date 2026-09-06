/**
 * A relative time that does not throw the page away on hydration.
 *
 * "3 min ago" is computed from the clock, and the server's clock reading is taken a moment
 * before the browser's. When that moment crosses a boundary — and "just now" lasts thirty
 * seconds, so it is crossed constantly — the server sends one string and React renders
 * another. React does not merely warn about a text mismatch: it discards the server HTML and
 * re-renders the entire tree on the client. On a page whose shell carries the journal that is
 * a second, complete hydration on every single load, and it showed up in the E2E logs as
 * *“Hydration failed because the server rendered text didn't match the client”* on `/`.
 *
 * Nothing about the value is wrong — both readings were correct when they were taken — so the
 * difference is *declared*, with `suppressHydrationWarning`. React then keeps the server's
 * text and lets the next render replace it, which is exactly the intended behaviour.
 *
 * Use this rather than calling `timeAgo` into JSX. Where the relative time is glued into a
 * longer sentence, put `suppressHydrationWarning` on the element that holds the sentence: the
 * attribute only covers an element's own text children, so it has to sit on the element whose
 * text actually differs.
 */
import { timeAgo } from "#/lib/format.ts";

export interface TimeAgoProps {
  readonly at: Date | string | null | undefined;
  /**
   * The reading of "now" this page was rendered against. Passed in rather than taken here so
   * that a table of thirty rows dates them all against one instant instead of thirty.
   */
  readonly now?: Date;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function TimeAgo({ at, now, className, "data-testid": testId }: TimeAgoProps) {
  return (
    <span suppressHydrationWarning className={className} data-testid={testId}>
      {timeAgo(at, now)}
    </span>
  );
}
