/**
 * The tag map, as a table (`docs/03-metadonnees.md` §2, §5).
 *
 * One component, two callers: Settings › Metadata shows the reference table, and an album's
 * Metadata tab shows the same table coloured by what that album actually holds. They are the
 * same table on purpose — the whole claim of §2 is that there is *one* map, and a Console that
 * drew it twice would eventually draw it two ways.
 *
 * The rows come from `@mm/domain` through `quality.tagMapRows()`. Nothing here restates a tag
 * name, a level or a format key: this file decides what the table looks like and nothing about
 * what is in it.
 *
 * **A profile filter changes the view, never the files.** That sentence is on the page as well
 * as in this comment, because it is the single most misreadable thing in the app: choosing
 * "Navidrome" makes the table show the 78 fields Navidrome indexes, and does not make us stop
 * writing the other 25.
 */
import { Fragment } from "react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { ToneBadge, type Tone } from "#/components/status-badge.tsx";
import type { TagMapRow, TagState } from "#/server/services/quality.ts";

export type FormatColumns = "vorbis" | "id3v24" | "mp4" | "all" | "source";

const LEVEL_TONE: Record<string, Tone> = {
  required: "danger",
  recommended: "warn",
  optional: "muted",
};

const STATE_TONE: Record<TagState, Tone> = {
  present: "ok",
  missing: "danger",
  na: "muted",
  unknown: "muted",
};

const STATE_LABEL: Record<TagState, string> = {
  present: "present",
  missing: "missing",
  na: "n/a",
  unknown: "—",
};

const GROUP_LABEL: Record<string, string> = {
  identity: "Identity and position",
  release: "Release",
  credits: "Credits and relations",
  classification: "Classification",
  identifiers: "Identifiers",
  loudness: "Loudness",
  analysis: "Analysis",
  "lyrics-artwork": "Lyrics and artwork",
  provenance: "Provenance",
};

export interface ProfileDot {
  readonly id: string;
  readonly name: string;
}

export interface TagMapTableProps {
  readonly rows: readonly TagMapRow[];
  /** Which key columns to show. `source` shows where the value comes from instead. */
  readonly columns: FormatColumns;
  /** Restrict the rows to the fields one consumer reads. `all` shows the superset. */
  readonly profile: string;
  readonly profiles: readonly ProfileDot[];
  /** Show the per-album status column. Off in Settings, where there is no album. */
  readonly showStatus?: boolean;
  /** Offered next to a missing field. */
  readonly onFetch?: (field: string) => void;
  readonly testId?: string;
}

const FORMAT_HEAD: Record<string, string> = {
  vorbis: "Vorbis",
  id3v24: "ID3v2.4",
  mp4: "MP4",
};

function keysFor(columns: FormatColumns): readonly ("vorbis" | "id3v24" | "mp4")[] {
  if (columns === "all") return ["vorbis", "id3v24", "mp4"];
  if (columns === "source") return [];
  return [columns];
}

export function TagMapTable({
  rows,
  columns,
  profile,
  profiles,
  showStatus = false,
  onFetch,
  testId = "tag-map",
}: TagMapTableProps) {
  const shown =
    profile === "all" || profile === "global"
      ? rows
      : rows.filter((row) => row.readers.includes(profile as never));

  const keys = keysFor(columns);
  const groups = [...new Set(shown.map((row) => row.group))];
  const span = 3 + keys.length + (columns === "source" ? 1 : 0) + (showStatus ? 2 : 0);

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface-1">
      <table className="w-full text-xs" data-testid={testId}>
        <thead>
          <tr className="border-b border-line text-2xs tracking-wider text-fg-2 uppercase">
            <th className="px-2.5 py-1.5 text-left font-medium">Field</th>
            {keys.map((key) => (
              <th key={key} className="px-2.5 py-1.5 text-left font-medium">
                {FORMAT_HEAD[key]}
              </th>
            ))}
            {columns === "source" ? (
              <th className="px-2.5 py-1.5 text-left font-medium">Source</th>
            ) : null}
            <th className="px-2.5 py-1.5 text-left font-medium">Level</th>
            <th className="px-2.5 py-1.5 text-center font-medium" title="Which consumers index it">
              Read by
            </th>
            {showStatus ? (
              <>
                <th className="px-2.5 py-1.5 text-left font-medium">Status</th>
                <th className="px-2.5 py-1.5" />
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group}>
              <tr className="border-b border-line bg-surface-2">
                <td
                  colSpan={span}
                  className="px-2.5 py-1 text-2xs tracking-wider text-fg-2 uppercase"
                >
                  {GROUP_LABEL[group] ?? group}
                </td>
              </tr>
              {shown
                .filter((row) => row.group === group)
                .map((row) => (
                  <tr
                    key={row.field}
                    data-testid={`tag-row-${row.field}`}
                    data-state={row.state}
                    className={cn(
                      "border-b border-line last:border-b-0 hover:bg-surface-2",
                      showStatus && row.state === "missing" && "bg-danger-soft/30",
                    )}
                  >
                    <td className="px-2.5 py-1.5">
                      <div className="font-mono">{row.field}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-3xs text-fg-3">
                        {row.multi ? <span title="One tag per value">multi</span> : null}
                        {row.albumScope ? (
                          <span title="Must be identical on every track of the album">
                            album-scope
                          </span>
                        ) : null}
                        {row.note === "" ? null : <span className="truncate">{row.note}</span>}
                      </div>
                    </td>
                    {keys.map((key) => (
                      <td key={key} className="px-2.5 py-1.5 font-mono text-2xs text-fg-2">
                        {(key === "vorbis" ? row.vorbis : key === "id3v24" ? row.id3 : row.mp4) ??
                          "—"}
                      </td>
                    ))}
                    {columns === "source" ? (
                      <td className="px-2.5 py-1.5 text-2xs text-fg-2">{row.source}</td>
                    ) : null}
                    <td className="px-2.5 py-1.5">
                      <ToneBadge tone={LEVEL_TONE[row.level] ?? "muted"}>{row.level}</ToneBadge>
                    </td>
                    <td className="px-2.5 py-1.5">
                      <span className="flex justify-center gap-0.5">
                        {profiles.map((entry) => (
                          <span
                            key={entry.id}
                            title={`${entry.name}: ${row.readers.includes(entry.id as never) ? "reads it" : "not known to read it"}`}
                            className={cn(
                              "size-1.5 rounded-full",
                              row.readers.includes(entry.id as never) ? "bg-ok" : "bg-line-strong",
                            )}
                          />
                        ))}
                      </span>
                    </td>
                    {showStatus ? (
                      <>
                        <td className="px-2.5 py-1.5">
                          <ToneBadge tone={STATE_TONE[row.state]} title={row.reason ?? undefined}>
                            {STATE_LABEL[row.state]}
                          </ToneBadge>
                          {row.state === "present" && row.tracks > 0 ? (
                            <span className="ml-1.5 font-mono text-3xs text-fg-3">
                              {row.tracks}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2.5 py-1.5 text-right">
                          {row.state === "missing" && onFetch !== undefined ? (
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => {
                                onFetch(row.field);
                              }}
                            >
                              Fetch
                            </Button>
                          ) : null}
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
