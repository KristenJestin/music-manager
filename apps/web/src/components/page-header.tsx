/**
 * The title block every page opens with: what this page is, one line of context, the actions.
 */
import type { ReactNode } from "react";
import { cn } from "cn";

export interface PageHeaderProps {
  readonly title: string;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      data-slot="page-header"
      className={cn("mb-5 flex items-end justify-between gap-4", className)}
    >
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description === undefined ? null : <p className="mt-0.5 text-fg-2">{description}</p>}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}
