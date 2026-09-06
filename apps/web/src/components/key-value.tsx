/**
 * A two-column definition list — the Console's way of showing "the facts about this thing".
 *
 * A real `<dl>` rather than a table: these are labelled values, not rows of the same shape,
 * and a screen reader should read them as pairs.
 */
import { Fragment, type ReactNode } from "react";
import { cn } from "cn";

export interface KeyValueItem {
  readonly label: string;
  readonly value: ReactNode;
  /** Drop the pair entirely when its value is empty. */
  readonly hideWhenEmpty?: boolean;
}

export interface KeyValueListProps {
  readonly items: readonly KeyValueItem[];
  readonly className?: string;
}

export function KeyValueList({ items, className }: KeyValueListProps) {
  const shown = items.filter(
    (item) =>
      item.hideWhenEmpty !== true ||
      (item.value !== null && item.value !== undefined && item.value !== ""),
  );
  return (
    <dl data-slot="key-value" className={cn("kv-grid gap-x-3.5 gap-y-1.5 text-xs", className)}>
      {shown.map((item) => (
        <Fragment key={item.label}>
          <dt className="text-fg-2">{item.label}</dt>
          <dd className="m-0 min-w-0">{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
