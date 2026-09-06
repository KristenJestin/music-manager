/**
 * `/library/quality` — metadata completeness, and the tag schema.
 *
 * The page exists to be **worked down**: albums are sorted worst first, the filters name the
 * specific complaints ("no lyrics", "YouTube cover", "behind schema"), and every row carries
 * the two buttons that fix it — fetch what is missing, or re-tag what is stale.
 *
 * The profile selector is the other half. Scoring "as Navidrome reads it" answers a different
 * question from "how complete is this": one is about the server you run, the other is about
 * the archive you are building. Both are shown, and the page says in as many words that a
 * profile changes the view and never the files.
 *
 * Progress on a running re-tag arrives over the existing SSE journal rather than by polling:
 * the worker writes `retag.progress` lines as it goes, and this page listens for them.
 */
import { useState } from "react";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { PROFILE_IDS } from "@mm/domain";
import { Layers, Settings2, ShieldCheck, Sparkles, Tag } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { FilterChips } from "#/components/library/filter-chips.tsx";
import { RetagProgressBar, SchemaBadge, SchemaHeading } from "#/components/library/schema.tsx";
import { useRetagProgress } from "#/hooks/use-retag-progress.ts";
import { pct } from "#/lib/format.ts";
import { QUALITY_FILTERS, QUALITY_FILTER_LABELS } from "#/lib/library-filters.ts";
import { fetchQuality } from "#/server/functions/quality.ts";
import { fetchMissingTags } from "#/server/functions/library.ts";
import { startRetag, stopRetag } from "#/server/functions/retag.ts";

const search = z.object({
  filter: z.enum(QUALITY_FILTERS).default("all"),
  profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
});

export const Route = createFileRoute("/_app/library/quality")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchQuality({ data: { filter: deps.filter, profile: deps.profile } }),
  staticData: { crumbs: [{ label: "Library", to: "/library" }, { label: "Quality" }] },
  component: Quality,
});

function Quality() {
  const payload = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);

  /* The run in flight, followed live. The loader's row is the starting point. */
  const progress = useRetagProgress({
    initial: payload.active,
    onFinished: () => {
      void router.invalidate();
    },
  });

  const profiled = params.profile !== "global";
  const scoreOf = (quality: (typeof payload.rows)[number]["quality"]): number | null =>
    profiled ? quality.byProfile[params.profile as never] : quality.score;

  const act = (label: string, run: () => Promise<string>): void => {
    setBusy(label);
    void run().then(
      (message) => {
        setBusy(null);
        toast(message, "ok");
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  const toggle = (albumId: string): void => {
    setSelected((current) =>
      current.includes(albumId) ? current.filter((id) => id !== albumId) : [...current, albumId],
    );
  };

  const stats = payload.stats;
  const averageForProfile = profiled
    ? stats.averageByProfile[params.profile as never]
    : stats.averageScore;

  return (
    <>
      <PageHeader
        title="Metadata quality"
        description="Scored against the standard superset — the Picard tag mapping. Switch the profile to see what one server or player actually reads back; it never changes what we write."
        actions={
          <>
            <Button
              variant="outline"
              disabled={busy !== null || selected.length === 0}
              data-testid="quality-fetch-selection"
              onClick={() => {
                act("fetch", async () => {
                  let gained = 0;
                  for (const albumId of selected) {
                    const result = await fetchMissingTags({ data: { albumId } });
                    gained += result.gained.length;
                  }
                  return `Asked the sources again for ${String(selected.length)} album(s); ${String(gained)} field(s) gained.`;
                });
              }}
            >
              <Sparkles className="size-4" aria-hidden="true" /> Fetch missing
            </Button>
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/settings/metadata" />}
            >
              <Settings2 className="size-4" aria-hidden="true" /> Tag map
            </Button>
          </>
        }
      />

      {/* ---- the numbers ---- */}
      <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile
          label={profiled ? `Visible in ${params.profile}` : "Average score"}
          value={pct(averageForProfile)}
          tone={scoreTone(averageForProfile)}
          sub={`${stats.albums} album(s) rated`}
          icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
        />
        <StatTile
          label="Below 80%"
          value={stats.below80}
          tone={stats.below80 === 0 ? "ok" : "danger"}
          sub="needs attention first"
          to="/library/quality"
          search={{ filter: "below80", profile: params.profile }}
        />
        <StatTile
          label="No synced lyrics"
          value={stats.noLyrics}
          tone={stats.noLyrics === 0 ? "ok" : "warn"}
          sub="tracks · LRCLIB had nothing"
          to="/library/quality"
          search={{ filter: "lyrics", profile: params.profile }}
        />
        <StatTile
          label="YouTube cover"
          value={stats.youtubeCover}
          tone={stats.youtubeCover === 0 ? "ok" : "warn"}
          sub="albums · a thumbnail, not the archive"
          to="/library/quality"
          search={{ filter: "ytcover", profile: params.profile }}
        />
        <StatTile
          label="Drift"
          value={stats.driftTracks}
          tone={stats.driftTracks === 0 ? "ok" : "warn"}
          sub="tracks · file ≠ database"
          to="/library/quality"
          search={{ filter: "drift", profile: params.profile }}
        />
        <StatTile
          label="Behind tag schema"
          value={stats.filesBehind}
          tone={stats.filesBehind === 0 ? "ok" : "warn"}
          sub={`files · ${stats.filesCurrent} current`}
          icon={<Layers className="size-3.5" aria-hidden="true" />}
          to="/library/quality"
          search={{ filter: "schema", profile: params.profile }}
        />
      </div>

      {/* ---- the tag schema ---- */}
      <Callout
        tone={stats.filesBehind === 0 ? "ok" : "warn"}
        className="mb-3"
        data-testid="schema-callout"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <SchemaHeading current={stats.currentSchema} overridden={stats.schemaOverridden} />{" "}
            {stats.filesBehind === 0 ? (
              <>
                Every file in the library carries{" "}
                <code className="font-mono">MUSICMANAGER_TAGSCHEMA={stats.currentSchema}</code>.
              </>
            ) : (
              <>
                <span data-testid="files-behind" className="font-mono">
                  {stats.filesBehind}
                </span>{" "}
                file(s) across {stats.albumsBehind} album(s) were written by an older projection.
                The re-tag re-derives them from the raw source cache: no network, no re-download,
                the audio stream is never touched, and every file gets a diff before it is written.
              </>
            )}
            {progress === null ? null : (
              <div className="mt-2">
                <RetagProgressBar
                  done={progress.done}
                  total={progress.total}
                  status={progress.status}
                  dryRun={progress.dryRun}
                />
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {progress !== null &&
            (progress.status === "running" || progress.status === "pending") ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  act("stop", async () => {
                    await stopRetag({ data: { id: progress.runId } });
                    return "Re-tag stopping: the file in flight finishes, then it stops.";
                  });
                }}
              >
                Stop
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  disabled={busy !== null || stats.filesBehind === 0}
                  data-testid="retag-all"
                  onClick={() => {
                    act("retag", async () => {
                      const run = await startRetag({
                        data: { scope: "library", targetId: null, dryRun: false, onlyBehind: true },
                      });
                      return `Re-tag queued for ${String(run.total)} file(s) — projection v${String(run.schemaVersion)}, from the raw cache.`;
                    });
                  }}
                >
                  <Tag className="size-3.5" aria-hidden="true" /> Re-tag {stats.filesBehind} file(s)
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || stats.filesBehind === 0}
                  data-testid="retag-dry-run"
                  onClick={() => {
                    act("dry", async () => {
                      const run = await startRetag({
                        data: { scope: "library", targetId: null, dryRun: true, onlyBehind: true },
                      });
                      return `Dry run queued for ${String(run.total)} file(s); the diff appears below when it finishes.`;
                    });
                  }}
                >
                  Dry run (diff)
                </Button>
              </>
            )}
          </div>
        </div>
      </Callout>

      {/* ---- profile ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-2xs text-fg-2">Profile</span>
        <select
          data-testid="quality-profile"
          value={params.profile}
          onChange={(event) => {
            void navigate({
              to: "/library/quality",
              search: { ...params, profile: event.target.value as typeof params.profile },
            });
          }}
          className="h-7 rounded-lg border border-line bg-surface-1 px-2 text-xs"
        >
          <option value="global">Global (superset)</option>
          {payload.profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
              {profile.status === "verified" ? " ✓" : ""}
            </option>
          ))}
        </select>
        <span className="text-2xs text-fg-3">
          {profiled
            ? (() => {
                const entry = payload.profiles.find((item) => item.id === params.profile);
                return entry === undefined
                  ? ""
                  : `${String(entry.reads)} of ${String(entry.reads + entry.unread)} tags read back · ${entry.via} · ${entry.status}`;
              })()
            : `${payload.tagMap.length} tags written per track when every source has data`}
        </span>
      </div>

      <FilterChips
        testId="quality-filters"
        chips={QUALITY_FILTERS.map((filter) => ({
          value: filter,
          label: QUALITY_FILTER_LABELS[filter],
          count: payload.counts[filter],
        }))}
        active={params.filter}
        link={(filter) => ({ to: "/library/quality", search: { ...params, filter } })}
      >
        <span className="text-2xs text-fg-3">{selected.length} selected</span>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null || selected.length === 0}
          data-testid="retag-selection"
          onClick={() => {
            act("retag-selection", async () => {
              let files = 0;
              for (const albumId of selected) {
                const run = await startRetag({
                  data: { scope: "album", targetId: albumId, dryRun: false, onlyBehind: false },
                });
                files += run.total;
              }
              return `Re-tag queued for ${String(selected.length)} album(s), ${String(files)} file(s).`;
            });
          }}
        >
          Re-tag selection
        </Button>
      </FilterChips>

      {/* ---- the table ---- */}
      <div className="overflow-x-auto rounded-xl border border-line bg-surface-1">
        <table className="w-full text-xs" data-testid="quality-table">
          <thead>
            <tr className="border-b border-line text-2xs tracking-wider text-fg-2 uppercase">
              <th className="w-8 px-2.5 py-1.5" />
              <th className="w-10 px-2.5 py-1.5" />
              <th className="px-2.5 py-1.5 text-left font-medium">Album</th>
              <th className="w-40 px-2.5 py-1.5 text-left font-medium">
                {profiled ? params.profile : "Score"}
              </th>
              <th className="px-2.5 py-1.5 text-right font-medium">Tracks</th>
              <th className="px-2.5 py-1.5 text-left font-medium">Schema</th>
              <th className="px-2.5 py-1.5 text-left font-medium">Missing</th>
              <th className="px-2.5 py-1.5 text-left font-medium">Drift</th>
              <th className="px-2.5 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {payload.rows.map((row) => {
              const score = scoreOf(row.quality);
              return (
                <tr
                  key={row.albumId}
                  data-testid="quality-row"
                  data-album-title={row.title}
                  className="border-b border-line last:border-b-0 hover:bg-surface-2"
                >
                  <td className="px-2.5 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.title}`}
                      data-testid={`quality-select-${row.albumId}`}
                      checked={selected.includes(row.albumId)}
                      onChange={() => {
                        toggle(row.albumId);
                      }}
                    />
                  </td>
                  <td className="px-2.5 py-1.5">
                    <Cover size="sm" seed={row.albumId} label={row.title} />
                  </td>
                  <td className="px-2.5 py-1.5">
                    <Link
                      to="/library/albums/$id"
                      params={{ id: row.albumId }}
                      search={{ tab: "metadata", profile: params.profile, keys: false }}
                      className="font-medium hover:text-primary"
                    >
                      {row.title}
                    </Link>
                    <div className="text-2xs text-fg-3">
                      {row.albumArtist}
                      {row.year === null ? "" : ` · ${String(row.year)}`}
                      {row.quality.untagged ? " · untagged" : ""}
                    </div>
                  </td>
                  <td className="px-2.5 py-1.5">
                    <ScoreBar value={score} />
                    {profiled ? (
                      <div className="text-3xs text-fg-3">global {pct(row.quality.score)}</div>
                    ) : null}
                  </td>
                  <td
                    className={cn(
                      "px-2.5 py-1.5 text-right font-mono",
                      row.quality.presentCount < row.quality.trackCount && "text-danger",
                    )}
                  >
                    {row.quality.presentCount}/{row.quality.trackCount}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <SchemaBadge
                      version={row.quality.schemaVersion}
                      current={stats.currentSchema}
                    />
                  </td>
                  <td className="max-w-72 px-2.5 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {row.quality.missing.length === 0 ? (
                        <span className="text-fg-3">—</span>
                      ) : (
                        row.quality.missing.slice(0, 6).map((entry) => (
                          <span
                            key={entry.field}
                            title={`${entry.level} · ${entry.source} · missing on ${String(entry.tracks)} track(s)`}
                            className={cn(
                              "rounded-sm px-1 py-0.5 font-mono text-3xs",
                              entry.level === "required"
                                ? "bg-danger-soft text-danger"
                                : entry.level === "recommended"
                                  ? "bg-warn-soft text-warn"
                                  : "bg-muted-soft text-fg-2",
                            )}
                          >
                            {entry.vorbis}
                          </span>
                        ))
                      )}
                      {row.quality.missing.length > 6 ? (
                        <span className="text-3xs text-fg-3">
                          +{row.quality.missing.length - 6}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="px-2.5 py-1.5">
                    {row.quality.driftCount === 0 ? (
                      <span className="text-fg-3">—</span>
                    ) : (
                      <ToneBadge tone="warn">{row.quality.driftCount}</ToneBadge>
                    )}
                  </td>
                  <td className="px-2.5 py-1.5 text-right">
                    <Link
                      to="/library/albums/$id"
                      params={{ id: row.albumId }}
                      search={{ tab: "metadata", profile: params.profile, keys: false }}
                      className="text-2xs text-fg-2 hover:text-primary"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              );
            })}
            {payload.rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-8 text-center text-fg-2">
                  Nothing matches this filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <Callout tone="info" className="mt-3">
        Score = the share of applicable tags actually written, weighted by level (required ×3,
        recommended ×2, optional ×1). Tags a release says do not exist — no work relations, one
        disc, no explicit flag — are <b>n/a</b> and leave the denominator rather than counting
        against it. <b>Global</b> scores the superset; a <b>profile</b> scores only what that
        consumer reads back, and never changes what is written. The full table is in{" "}
        <Link to="/settings/metadata" className="text-primary">
          Settings › Metadata &amp; matching
        </Link>
        .
      </Callout>
    </>
  );
}
