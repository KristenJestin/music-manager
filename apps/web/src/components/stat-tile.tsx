/**
 * One dashboard tile: a label, one big number, one line of detail.
 *
 * The number is monospaced so that a row of six tiles lines up, and the tile is a link when
 * there is somewhere to go — which there almost always is, because a count you cannot click
 * through to is a number you have to go and find again.
 */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "cn";
import type { Tone } from "#/components/status-badge.tsx";

const VALUE_TONE: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  info: "text-info",
  muted: "text-foreground",
  primary: "text-primary",
};

export interface StatTileProps {
  readonly label: string;
  readonly value: ReactNode;
  readonly sub?: ReactNode;
  readonly tone?: Tone;
  readonly icon?: ReactNode;
  /** Where clicking the tile goes. Omit for a tile that is only a readout. */
  readonly to?: LinkProps["to"];
  readonly search?: LinkProps["search"];
  readonly className?: string;
}

export function StatTile({
  label,
  value,
  sub,
  tone = "muted",
  icon,
  to,
  search,
  className,
}: StatTileProps) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2 text-2xs tracking-wider text-fg-2 uppercase">
        {label}
        {icon}
      </span>
      <span className={cn("font-mono text-2xl font-semibold tracking-tight", VALUE_TONE[tone])}>
        {value}
      </span>
      {sub === undefined ? null : <span className="text-2xs text-fg-3">{sub}</span>}
    </>
  );

  const shell = cn(
    "flex flex-col gap-1.5 rounded-lg border border-line bg-surface-1 px-3.5 py-3",
    to === undefined ? "" : "cursor-pointer hover:border-line-strong hover:bg-surface-2",
    className,
  );

  if (to === undefined) {
    return (
      <div data-slot="stat-tile" className={shell}>
        {body}
      </div>
    );
  }
  return (
    <Link data-slot="stat-tile" to={to} search={search} className={shell}>
      {body}
    </Link>
  );
}
