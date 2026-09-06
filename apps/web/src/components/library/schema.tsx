/**
 * The tag schema, as the Console shows it: a badge, a progress bar, and a diff.
 *
 * These three appear on four pages — the album's Metadata tab, `/library/quality`,
 * `/library/tracks` and Settings › Metadata — so they live here rather than being written
 * four times with four slightly different opinions about what "behind" looks like.
 *
 * The wording is deliberate throughout. A file that is *behind* is not a broken file: it was
 * written correctly by an older projection, and the fix reads the raw cache, touches no
 * network and re-encodes no audio. Saying "outdated" or colouring it red would make people
 * anxious about something that costs a background job.
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import { Layers, Minus, Plus, RefreshCw } from "lucide-react";
import { ToneBadge } from "#/components/status-badge.tsx";
import { ProgressBar } from "#/components/progress-bar.tsx";

/** `v1` / `v1 · behind` — what version a file carries, and whether that is current. */
export function SchemaBadge({
  version,
  current,
  className,
}: {
  readonly version: number | null;
  readonly current: number;
  readonly className?: string;
}) {
  if (version === null) {
    return (
      <ToneBadge tone="muted" className={className} title="No version recorded for this file.">
        unknown
      </ToneBadge>
    );
  }
  const behind = version < current;
  return (
    <ToneBadge
      tone={behind ? "warn" : "ok"}
      className={className}
      title={
        behind
          ? `Written by projection v${String(version)}; the current one is v${String(current)}. A re-tag reads the raw cache — no network, no re-download, the audio is not touched.`
          : `MUSICMANAGER_TAGSCHEMA=${String(version)}, which is current.`
      }
    >
      v{version}
      {behind ? " · behind" : ""}
    </ToneBadge>
  );
}

/** The run in flight, or the last one: counters, a bar, and what it is doing. */
export function RetagProgressBar({
  done,
  total,
  status,
  dryRun,
  className,
}: {
  readonly done: number;
  readonly total: number;
  readonly status: string;
  readonly dryRun: boolean;
  readonly className?: string;
}) {
  const value = total === 0 ? 0 : done / total;
  const tone =
    status === "failed"
      ? "danger"
      : status === "done"
        ? "ok"
        : status === "cancelled"
          ? "muted"
          : "info";
  return (
    <div className={cn("flex items-center gap-2", className)} data-testid="retag-progress">
      <ProgressBar className="w-40" value={value} tone={tone} label="Re-tag progress" />
      <span className="font-mono text-2xs text-fg-2">
        {done}/{total}
      </span>
      <ToneBadge tone={tone}>
        {dryRun ? "dry run · " : ""}
        {status}
      </ToneBadge>
    </div>
  );
}

export interface DiffLine {
  readonly key: string;
  readonly field?: string;
  readonly before?: string;
  readonly after?: string;
}

export interface TagDiffProps {
  readonly added: readonly DiffLine[];
  readonly removed: readonly DiffLine[];
  readonly changed: readonly DiffLine[];
  readonly unchanged: number;
  readonly emptyLabel?: string;
}

function Row({
  mark,
  tone,
  line,
}: {
  readonly mark: ReactNode;
  readonly tone: "ok" | "danger" | "warn";
  readonly line: DiffLine;
}) {
  const colour = tone === "ok" ? "text-ok" : tone === "danger" ? "text-danger" : "text-warn";
  return (
    <div className="grid grid-cols-[1rem_minmax(0,14rem)_1fr] items-start gap-2 py-0.5">
      <span className={cn("font-mono text-2xs", colour)}>{mark}</span>
      <span className="truncate font-mono text-2xs text-fg-1" title={line.field ?? line.key}>
        {line.key}
      </span>
      <span className="min-w-0 font-mono text-2xs break-words text-fg-2">
        {line.before === undefined ? null : (
          <span className="text-danger line-through">{line.before}</span>
        )}
        {line.before !== undefined && line.after !== undefined ? " → " : null}
        {line.after === undefined ? null : <span className="text-ok">{line.after}</span>}
      </span>
    </div>
  );
}

/**
 * One file's diff: what the new projection adds, changes and removes.
 *
 * `removed` deserves attention rather than reassurance — a key in the file that the projection
 * does not produce is either something another tagger wrote or something we stopped writing,
 * and both are worth a look before a re-tag drops it.
 */
export function TagDiff({
  added,
  removed,
  changed,
  unchanged,
  emptyLabel = "Nothing would change: the file already carries this projection.",
}: TagDiffProps) {
  const empty = added.length === 0 && removed.length === 0 && changed.length === 0;
  if (empty) {
    return (
      <p className="py-2 text-2xs text-fg-3">
        {emptyLabel} <span className="font-mono">{unchanged}</span> tag(s) identical.
      </p>
    );
  }
  return (
    <div data-testid="tag-diff">
      {added.map((line) => (
        <Row key={`+${line.key}`} mark={<Plus className="size-3" />} tone="ok" line={line} />
      ))}
      {changed.map((line) => (
        <Row key={`~${line.key}`} mark={<RefreshCw className="size-3" />} tone="warn" line={line} />
      ))}
      {removed.map((line) => (
        <Row key={`-${line.key}`} mark={<Minus className="size-3" />} tone="danger" line={line} />
      ))}
      <p className="mt-1.5 text-2xs text-fg-3">
        <span className="font-mono">{unchanged}</span> tag(s) unchanged ·{" "}
        <span className="font-mono text-ok">+{added.length}</span>{" "}
        <span className="font-mono text-warn">~{changed.length}</span>{" "}
        <span className="font-mono text-danger">−{removed.length}</span>
      </p>
    </div>
  );
}

/** The little "v3" chip with the layers icon that heads every schema section. */
export function SchemaHeading({
  current,
  overridden,
}: {
  readonly current: number;
  readonly overridden: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Layers className="size-3.5 text-fg-3" aria-hidden="true" />
      <span className="font-mono text-xs">v{current}</span>
      {overridden ? (
        <ToneBadge
          tone="warn"
          title='The setting "tagSchemaVersionOverride" is in force. The projection itself has not changed; this exists so the background re-tag can be exercised end to end.'
        >
          override
        </ToneBadge>
      ) : null}
    </span>
  );
}
