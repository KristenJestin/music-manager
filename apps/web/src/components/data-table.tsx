/**
 * The Console's dense table.
 *
 * A thin, typed wrapper over the shadcn `Table` primitives, so that the twelve tables of this
 * app agree on padding, header casing, the numeric column and the row-hover action strip
 * without any of them restating it. Columns are declared, not written as JSX, which is what
 * makes "add a column" a one-line change everywhere.
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";

export interface Column<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly cell: (row: T, index: number) => ReactNode;
  /** Right-aligned and monospaced — durations, sizes, counts. */
  readonly numeric?: boolean;
  /** Only visible while the row is hovered: the per-row action strip. */
  readonly actions?: boolean;
  readonly className?: string;
  readonly headClassName?: string;
}

export interface DataTableProps<T> {
  readonly columns: readonly Column<T>[];
  readonly rows: readonly T[];
  readonly rowKey: (row: T, index: number) => string;
  readonly onRowClick?: (row: T) => void;
  readonly rowClassName?: (row: T) => string | undefined;
  readonly empty?: ReactNode;
  readonly className?: string;
  readonly "data-testid"?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowClassName,
  empty = "Nothing here.",
  className,
  "data-testid": testId,
}: DataTableProps<T>) {
  return (
    <Table data-testid={testId} className={cn("text-xs", className)}>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((column) => (
            <TableHead
              key={column.key}
              className={cn(
                "h-8 px-2.5 text-2xs font-medium tracking-wider text-fg-2 uppercase",
                column.numeric === true && "text-right",
                column.headClassName,
              )}
            >
              {column.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={columns.length} className="py-8 text-center text-fg-2">
              {empty}
            </TableCell>
          </TableRow>
        ) : (
          rows.map((row, index) => (
            <TableRow
              key={rowKey(row, index)}
              className={cn(
                "group/row border-line hover:bg-surface-2",
                onRowClick === undefined ? "" : "cursor-pointer",
                rowClassName?.(row),
              )}
              onClick={
                onRowClick === undefined
                  ? undefined
                  : () => {
                      onRowClick(row);
                    }
              }
            >
              {columns.map((column) => (
                <TableCell
                  key={column.key}
                  className={cn(
                    "border-line px-2.5 py-1.5 align-middle",
                    column.numeric === true && "text-right font-mono",
                    column.actions === true &&
                      "opacity-0 transition-opacity group-hover/row:opacity-100",
                    column.className,
                  )}
                >
                  {column.cell(row, index)}
                </TableCell>
              ))}
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
