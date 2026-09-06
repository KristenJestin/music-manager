/**
 * The honest placeholder.
 *
 * The sidebar shows Library and System from day one, because the shape of the app is part of
 * what P06 delivers. Their pages say which phase builds them rather than 404-ing — a dead link
 * teaches you the app is broken, a dated placeholder teaches you the app is unfinished, and
 * only one of those is true.
 */
import { Link } from "@tanstack/react-router";
import { Construction } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { PageHeader } from "#/components/page-header.tsx";

export function ComingSoon({
  title,
  phase,
  what,
}: {
  readonly title: string;
  readonly phase: string;
  readonly what: string;
}) {
  return (
    <>
      <PageHeader title={title} description={what} />
      <div
        data-testid="coming-soon"
        className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-1 px-6 py-16 text-center"
      >
        <Construction className="size-8 text-fg-3" aria-hidden="true" />
        <p className="text-fg-1">Coming in {phase}.</p>
        <p className="max-w-form text-xs text-fg-2">{what}</p>
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={<Link to="/" />}
          className="mt-2"
        >
          Back to the dashboard
        </Button>
      </div>
    </>
  );
}
