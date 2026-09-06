/**
 * `/library/albums/:id` — one album, six tabs.
 *
 * Tracks · Metadata · DB vs files · Navidrome · MusicBrainz · History. The tab is in the URL,
 * so a link can point at "the metadata of this album as Navidrome reads it", which is the kind
 * of thing you want to send someone.
 *
 * The loader fetches only what the current tab needs. The album header is always read; the
 * file comparison opens every file through the toolbox and the history reads four hundred
 * journal lines, and neither has any business happening because you looked at the track list.
 *
 * The Navidrome tab is P07b's `VerifyTab`, mounted with one line. Two phases fill this page
 * and neither edits the other's markup.
 */
import { useState } from "react";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { PROFILE_IDS } from "@mm/domain";
import {
  Disc3,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import { CoverPicker } from "#/components/library/cover-picker.tsx";
import { SchemaBadge, SchemaHeading, TagDiff } from "#/components/library/schema.tsx";
import { TagMapTable, type FormatColumns } from "#/components/library/tag-map-table.tsx";
import { VerifyTab } from "#/components/library/verify-tab.tsx";
import { bytes, clockTime, dateTime, mmss, pct, short } from "#/lib/format.ts";
import {
  chooseCover,
  fetchAlbum,
  fetchAlbumHistory,
  fetchCoverOptions,
  fetchFileComparison,
  fetchMissingTags,
  redownload,
  removeAlbum,
} from "#/server/functions/library.ts";
import { fetchAlbumVerification } from "#/server/functions/verify.ts";
import { startRetag } from "#/server/functions/retag.ts";
import type { AlbumTrackRow } from "#/server/services/library.ts";

const TABS = ["tracks", "metadata", "tags", "verify", "mb", "history"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, string> = {
  tracks: "Tracks",
  metadata: "Metadata",
  tags: "DB vs files",
  verify: "Navidrome",
  mb: "MusicBrainz",
  history: "History",
};

const search = z.object({
  tab: z.enum(TABS).default("tracks"),
  profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
  /** Show the Vorbis / ID3 / MP4 key columns instead of the source column. */
  keys: z.boolean().default(false),
});

export const Route = createFileRoute("/_app/library/albums/$id")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => ({ tab: params.tab }),
  loader: async ({ params, deps }) => {
    const album = await fetchAlbum({ data: { id: params.id } });
    if (album === null) return { album: null, comparison: null, history: null, verify: null };
    const [comparison, history, verify] = await Promise.all([
      deps.tab === "tags" ? fetchFileComparison({ data: { id: params.id } }) : null,
      deps.tab === "history" ? fetchAlbumHistory({ data: { id: params.id } }) : null,
      deps.tab === "verify" ? fetchAlbumVerification({ data: { albumId: params.id } }) : null,
    ]);
    return { album, comparison, history, verify };
  },
  staticData: { crumbs: [{ label: "Library", to: "/library" }, { label: "Album" }] },
  component: Album,
});

function Album() {
  const { album, comparison, history, verify } = Route.useLoaderData();
  const params = Route.useSearch();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [covers, setCovers] = useState<Awaited<ReturnType<typeof fetchCoverOptions>>>([]);

  if (album === null) {
    return (
      <Callout tone="warn">
        No album with that id. It may have been deleted —{" "}
        <Link to="/library">back to the library</Link>.
      </Callout>
    );
  }

  const quality = album.quality;
  const profiled = params.profile !== "global";
  const score = profiled ? quality.byProfile[params.profile as never] : quality.score;

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

  const queueRetag = (dryRun: boolean): void => {
    act(dryRun ? "dry" : "retag", async () => {
      const run = await startRetag({
        data: { scope: "album", targetId: id, dryRun, onlyBehind: false },
      });
      return `${dryRun ? "Dry run" : "Re-tag"} queued for ${String(run.total)} file(s) — projection v${String(run.schemaVersion)}, from the raw cache.`;
    });
  };

  const openCoverPicker = (): void => {
    setBusy("cover");
    void fetchCoverOptions({ data: { id } }).then(
      (options) => {
        setBusy(null);
        setCovers(options);
        setCoverOpen(true);
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : "No candidates.", "danger");
      },
    );
  };

  return (
    <>
      {/* ---- header ---- */}
      <div className="mb-4 flex flex-wrap items-start gap-5">
        <Cover size="xl" seed={album.album.id} label={album.album.title} />
        <div className="min-w-0 grow">
          <div className="text-2xs tracking-wider text-fg-2 uppercase">
            {album.identifiers.releaseType ?? "album"}
            {album.album.year === null ? "" : ` · ${String(album.album.year)}`}
          </div>
          <h1 className="text-xl font-semibold" data-testid="album-title">
            {album.album.title}
          </h1>
          <div className="text-xs text-fg-1">
            <Link
              to="/library/artists"
              search={{ q: album.album.albumArtist }}
              className="text-primary"
            >
              {album.album.albumArtist}
            </Link>
            {album.identifiers.label === null ? null : ` · ${album.identifiers.label}`}
            {album.identifiers.country === null ? null : ` · ${album.identifiers.country}`}
            {album.identifiers.media === null ? null : ` · ${album.identifiers.media}`}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ToneBadge tone={quality.presentCount === quality.trackCount ? "ok" : "warn"}>
              {quality.presentCount}/{quality.trackCount} tracks
            </ToneBadge>
            <ToneBadge tone={scoreTone(score)} title="Metadata completeness">
              {pct(score)}
              {profiled ? ` in ${params.profile}` : ""}
            </ToneBadge>
            <SchemaBadge version={quality.schemaVersion} current={album.currentSchema} />
            <ToneBadge tone={quality.lyricsCount > 0 ? "ok" : "muted"}>
              lyrics {quality.lyricsCount}/{quality.presentCount}
            </ToneBadge>
            <ToneBadge tone={quality.replayGainCount > 0 ? "ok" : "muted"}>ReplayGain</ToneBadge>
            {quality.untagged ? (
              <ToneBadge
                tone="info"
                title="No MusicBrainz release: the tags come from YouTube alone."
              >
                untagged
              </ToneBadge>
            ) : null}
            <ToneBadge outline>{bytes(album.sizeBytes)}</ToneBadge>
            <span className="font-mono text-2xs text-fg-3">{album.album.folder}</span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="album-fetch-missing"
            onClick={() => {
              act("fetch", async () => {
                const result = await fetchMissingTags({ data: { albumId: id } });
                return result.gained.length === 0
                  ? `Asked ${String(result.tracks)} track(s) again (${String(result.requests)} request(s)); the sources had nothing new.`
                  : `Gained ${result.gained.join(", ")} — ${pct(result.scoreBefore)} → ${pct(result.scoreAfter)}.`;
              });
            }}
          >
            <Sparkles className="size-4" aria-hidden="true" /> Fetch missing
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="album-retag"
            onClick={() => {
              queueRetag(false);
            }}
          >
            <Tag className="size-4" aria-hidden="true" /> Re-tag
          </Button>
          <Button variant="outline" disabled={busy !== null} onClick={openCoverPicker}>
            <ImageIcon className="size-4" aria-hidden="true" /> Cover
          </Button>
          {album.wizardImportId === null ? null : (
            <Button
              variant="outline"
              nativeButton={false}
              title="Re-pick the release in the import wizard's step 2, then re-run the match."
              render={
                <Link to="/import/new" search={{ importId: album.wizardImportId, step: 2 }} />
              }
            >
              <Disc3 className="size-4" aria-hidden="true" /> Change release
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              act("redownload", async () => {
                const plans = await redownload({ data: { albumId: id } });
                const total = plans.reduce((sum, plan) => sum + plan.tracks, 0);
                return `${String(total)} track(s) queued for re-download; the mapping is kept.`;
              });
            }}
          >
            <Download className="size-4" aria-hidden="true" /> Re-download
          </Button>
          <Button
            variant="destructive"
            disabled={busy !== null}
            data-testid="album-delete"
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* ---- tabs ---- */}
      <div className="mb-3 flex flex-wrap gap-1 border-b border-line" data-testid="album-tabs">
        {TABS.map((tab) => (
          <Link
            key={tab}
            to="/library/albums/$id"
            params={{ id }}
            search={{ ...params, tab }}
            data-testid={`album-tab-${tab}`}
            className={cn(
              "-mb-px border-b-2 px-2.5 py-1.5 text-xs",
              tab === params.tab
                ? "border-primary text-primary"
                : "border-transparent text-fg-2 hover:text-fg-1",
            )}
          >
            {TAB_LABEL[tab]}
          </Link>
        ))}
      </div>

      {params.tab === "tracks" ? <TracksTab album={album} /> : null}
      {params.tab === "metadata" ? (
        <MetadataTab
          album={album}
          profile={params.profile}
          keys={params.keys}
          onProfile={(profile) => {
            void navigate({
              to: "/library/albums/$id",
              params: { id },
              search: { ...params, profile: profile as typeof params.profile },
            });
          }}
          onKeys={(keys) => {
            void navigate({
              to: "/library/albums/$id",
              params: { id },
              search: { ...params, keys },
            });
          }}
          onRetag={queueRetag}
          busy={busy !== null}
        />
      ) : null}
      {params.tab === "tags" ? <CompareTab comparison={comparison} onRetag={queueRetag} /> : null}
      {params.tab === "verify" ? (
        verify === null ? null : (
          <VerifyTab
            payload={verify}
            onVerified={() => {
              void router.invalidate();
            }}
          />
        )
      ) : null}
      {params.tab === "mb" ? <MusicBrainzTab album={album} /> : null}
      {params.tab === "history" ? <HistoryTab history={history ?? []} /> : null}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${album.album.title}”?`}
        description="The audio files, their .lrc sidecars and cover.jpg are removed from disk, and the album and track rows are removed from the database."
        consequence={
          <>
            <span className="font-mono">{quality.presentCount}</span> audio file(s) ·{" "}
            <span className="font-mono">{bytes(album.sizeBytes)}</span> · folder{" "}
            <span className="font-mono">{album.album.folder}</span>
            <p className="mt-1.5 text-2xs text-fg-3">
              The raw source cache is <em>not</em> touched, so re-importing this album later costs
              no network traffic. Anything else in the folder is left where it is.
            </p>
          </>
        }
        confirmLabel="Delete the album"
        busy={busy === "delete"}
        onConfirm={() => {
          setBusy("delete");
          void removeAlbum({ data: { id } }).then(
            (result) => {
              setBusy(null);
              setConfirmDelete(false);
              toast(
                `Deleted ${String(result.files)} file(s), ${String(result.sidecars)} sidecar(s), ${String(result.rows)} row(s).`,
                "ok",
              );
              void navigate({ to: "/library" });
            },
            (error: unknown) => {
              setBusy(null);
              toast(error instanceof Error ? error.message : "Delete failed.", "danger");
            },
          );
        }}
      />

      <CoverPicker
        open={coverOpen}
        onOpenChange={setCoverOpen}
        options={covers}
        busy={busy === "choose-cover"}
        onChoose={(url) => {
          setBusy("choose-cover");
          void chooseCover({ data: { id, url } }).then(
            (result) => {
              setBusy(null);
              setCoverOpen(false);
              toast(
                `${result.path} written (${bytes(result.bytes)}); ${String(result.tracks)} document(s) updated. Re-tag to embed it.`,
                "ok",
              );
              void router.invalidate();
            },
            (error: unknown) => {
              setBusy(null);
              toast(error instanceof Error ? error.message : "Could not prepare it.", "danger");
            },
          );
        }}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

type AlbumData = NonNullable<Awaited<ReturnType<typeof fetchAlbum>>>;

function TracksTab({ album }: { readonly album: AlbumData }) {
  const navigate = useNavigate();
  const columns: Column<AlbumTrackRow>[] = [
    {
      key: "n",
      header: "#",
      numeric: true,
      className: "w-10",
      cell: (row) => (
        <span className="text-fg-3">
          {row.discNumber !== null && row.discNumber > 1 ? `${String(row.discNumber)}-` : ""}
          {String(row.trackNumber ?? 0).padStart(2, "0")}
        </span>
      ),
    },
    {
      key: "title",
      header: "Title",
      cell: (row) => <span className="font-medium">{row.title}</span>,
    },
    { key: "length", header: "Length", numeric: true, cell: (row) => mmss(row.duration) },
    {
      key: "source",
      header: "Source",
      cell: (row) =>
        row.videoId === null ? (
          <span className="text-fg-3">—</span>
        ) : (
          <a
            href={`https://youtu.be/${row.videoId}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-2xs text-fg-2 hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {row.videoId}
          </a>
        ),
    },
    {
      key: "recording",
      header: "Recording",
      cell: (row) => (
        <span className="font-mono text-2xs text-fg-3">{short(row.recordingMbid)}</span>
      ),
    },
    {
      key: "file",
      header: "File",
      className: "max-w-64",
      cell: (row) => (
        <span className="block truncate font-mono text-2xs text-fg-3" title={row.path}>
          {row.path.slice(row.path.lastIndexOf("/") + 1)}
        </span>
      ),
    },
    {
      key: "extras",
      header: "Extras",
      cell: (row) => (
        <span className="flex gap-1">
          {row.hasLyrics ? <ToneBadge tone="ok">lrc</ToneBadge> : null}
          {row.hasReplayGain ? <ToneBadge tone="ok">rg</ToneBadge> : null}
        </span>
      ),
    },
    {
      key: "score",
      header: "Metadata",
      cell: (row) => <ToneBadge tone={scoreTone(row.score)}>{pct(row.score)}</ToneBadge>,
    },
    {
      key: "schema",
      header: "Schema",
      cell: (row) => <SchemaBadge version={row.tagSchemaVersion} current={album.currentSchema} />,
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
      <DataTable
        data-testid="album-tracks"
        columns={columns}
        rows={album.tracks}
        rowKey={(row) => row.id}
        onRowClick={(row) => {
          void navigate({ to: "/library/tracks/$id", params: { id: row.id } });
        }}
        empty="No files placed for this album yet."
      />
    </div>
  );
}

function MetadataTab({
  album,
  profile,
  keys,
  onProfile,
  onKeys,
  onRetag,
  busy,
}: {
  readonly album: AlbumData;
  readonly profile: string;
  readonly keys: boolean;
  readonly onProfile: (profile: string) => void;
  readonly onKeys: (keys: boolean) => void;
  readonly onRetag: (dryRun: boolean) => void;
  readonly busy: boolean;
}) {
  const quality = album.quality;
  const profiled = profile !== "global";
  const score = profiled ? quality.byProfile[profile as never] : quality.score;
  const behind = quality.filesBehind > 0;
  const columns: FormatColumns = keys ? "all" : "source";

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2" data-testid="metadata-controls">
        <span className="text-2xs text-fg-2">Read by</span>
        {["global", ...PROFILE_IDS].map((entry) => (
          <button
            key={entry}
            type="button"
            data-testid={`profile-${entry}`}
            aria-pressed={entry === profile}
            onClick={() => {
              onProfile(entry);
            }}
            className={cn(
              "inline-flex h-6 items-center rounded-xl border px-2.5 text-xs",
              entry === profile
                ? "border-primary bg-primary-soft text-primary"
                : "border-line-strong bg-surface-2 text-fg-1 hover:bg-surface-3",
            )}
          >
            {entry === "global" ? "Global (superset)" : entry}
          </button>
        ))}
        <span className="grow" />
        <button
          type="button"
          data-testid="format-keys-toggle"
          aria-pressed={keys}
          onClick={() => {
            onKeys(!keys);
          }}
          className={cn(
            "inline-flex h-6 items-center rounded-xl border px-2.5 text-xs",
            keys
              ? "border-primary bg-primary-soft text-primary"
              : "border-line-strong bg-surface-2 text-fg-1 hover:bg-surface-3",
          )}
        >
          Format keys
        </button>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={profiled ? `Visible in ${profile}` : "Completeness (global)"}
          value={pct(score)}
          tone={scoreTone(score)}
          sub={profiled ? "of the fields it indexes" : "of the fields that apply"}
        />
        <StatTile
          label="Tracks"
          value={`${quality.presentCount}/${quality.trackCount}`}
          sub={`${quality.naCount} field(s) n/a for this release`}
        />
        <StatTile
          label="Missing"
          value={quality.missing.length}
          tone={quality.missing.length === 0 ? "ok" : "warn"}
          sub={`${quality.missing.filter((entry) => entry.level === "required").length} required`}
        />
        <StatTile
          label="Behind schema"
          value={quality.filesBehind}
          tone={behind ? "warn" : "ok"}
          sub={`projection v${album.currentSchema}`}
        />
      </div>

      <Callout tone={behind ? "warn" : "ok"} className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <SchemaHeading current={album.currentSchema} overridden={album.schemaOverridden} />{" "}
            {behind ? (
              <>
                {quality.filesBehind} file(s) were written by an older projection. The re-tag reads
                the raw cache — no network, no re-download, the audio stream is not touched — and
                shows a diff per file first.
              </>
            ) : (
              <>
                Every file of this album carries{" "}
                <code className="font-mono">MUSICMANAGER_TAGSCHEMA={album.currentSchema}</code>.
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              data-testid="metadata-retag"
              onClick={() => {
                onRetag(false);
              }}
            >
              <Tag className="size-3.5" aria-hidden="true" /> Re-tag now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              data-testid="metadata-dry-run"
              onClick={() => {
                onRetag(true);
              }}
            >
              Dry run
            </Button>
          </div>
        </div>
      </Callout>

      {quality.missing.length === 0 ? (
        <Callout tone="ok" className="mb-3">
          Every field of {profiled ? `the ${profile} profile` : "the superset"} that has a value is
          written for this album.
        </Callout>
      ) : (
        <div className="mb-3 overflow-hidden rounded-xl border border-line bg-surface-1">
          <div className="border-b border-line px-3.5 py-2 text-xs font-medium">
            What is missing{profiled ? ` in ${profile}` : ""}
          </div>
          <ul className="divide-y divide-line">
            {quality.missing
              .filter(
                (entry) =>
                  !profiled ||
                  album.tagMap
                    .find((row) => row.field === entry.field)
                    ?.readers.includes(profile as never) === true,
              )
              .slice(0, 30)
              .map((entry) => (
                <li key={entry.field} className="flex items-center gap-2.5 px-3.5 py-1.5">
                  <ToneBadge
                    tone={
                      entry.level === "required"
                        ? "danger"
                        : entry.level === "recommended"
                          ? "warn"
                          : "muted"
                    }
                  >
                    {entry.level}
                  </ToneBadge>
                  <span className="font-mono text-xs">{entry.vorbis}</span>
                  <span className="grow truncate text-2xs text-fg-3">{entry.source}</span>
                  <span className="font-mono text-2xs text-fg-3">{entry.tracks} track(s)</span>
                  <span className="text-2xs text-fg-2">{entry.action}</span>
                </li>
              ))}
          </ul>
        </div>
      )}

      <TagMapTable
        rows={album.tagMap}
        columns={columns}
        profile={profile}
        profiles={PROFILE_IDS.map((id) => ({ id, name: id }))}
        showStatus
      />
    </>
  );
}

function CompareTab({
  comparison,
  onRetag,
}: {
  readonly comparison: Awaited<ReturnType<typeof fetchFileComparison>> | null;
  readonly onRetag: (dryRun: boolean) => void;
}) {
  const rows = comparison ?? [];
  const drifting = rows.filter(
    (row) =>
      row.diff !== null &&
      (row.diff.added.length > 0 || row.diff.changed.length > 0 || row.diff.removed.length > 0),
  );
  /*
   * A file that could not be read is not a file that agrees.
   *
   * The summary used to count only *drift*, so an album whose files were all missing from
   * disk was announced as "They agree" above fourteen rows each saying "The file is not on
   * disk" — the page contradicting itself in one screen. A row we could not compare is
   * counted here and named separately below.
   */
  const unreadable = rows.filter((row) => row.error !== null);
  const settled = drifting.length === 0 && unreadable.length === 0;

  return (
    <>
      <Callout tone={settled ? "ok" : "warn"} className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            Every file was opened through the toolbox&rsquo;s{" "}
            <code className="font-mono">/probe</code> and compared, key by key, with what the
            database says it should hold.{" "}
            {settled
              ? "They agree."
              : [
                  drifting.length === 0
                    ? null
                    : `${String(drifting.length)} of ${String(rows.length)} file(s) differ`,
                  unreadable.length === 0 ? null : `${String(unreadable.length)} could not be read`,
                ]
                  .filter((part): part is string => part !== null)
                  .join(", ") + "."}{" "}
            The database is the source of truth, so &ldquo;fix&rdquo; means writing it back out.
          </div>
          <Button
            size="sm"
            data-testid="compare-fix"
            onClick={() => {
              onRetag(false);
            }}
          >
            Write DB → files
          </Button>
        </div>
      </Callout>

      <div className="flex flex-col gap-2" data-testid="db-vs-files">
        {rows.map((row) => (
          <div key={row.libraryTrackId} className="rounded-xl border border-line bg-surface-1 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="truncate font-mono text-2xs text-fg-1">{row.path}</span>
              {row.error === null ? null : <ToneBadge tone="danger">{row.error}</ToneBadge>}
            </div>
            {row.diff === null ? null : (
              <TagDiff
                added={row.diff.added}
                removed={row.diff.removed}
                changed={row.diff.changed}
                unchanged={row.diff.unchanged}
                emptyLabel="The file holds exactly what the database says."
              />
            )}
          </div>
        ))}
        {rows.length === 0 ? <Callout tone="info">No files to compare.</Callout> : null}
      </div>
    </>
  );
}

function MusicBrainzTab({ album }: { readonly album: AlbumData }) {
  const ids = album.identifiers;
  const mb = (kind: string, id: string | null) =>
    id === null || id === "" ? (
      <span className="text-fg-3">—</span>
    ) : (
      <a
        href={`https://musicbrainz.org/${kind}/${id}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-mono text-2xs hover:text-primary"
      >
        {id}
        <ExternalLink className="size-3" aria-hidden="true" />
      </a>
    );

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-line bg-surface-1 p-3.5">
        <h2 className="mb-2 text-xs font-medium">Identifiers</h2>
        <KeyValueList
          items={[
            { label: "Release", value: mb("release", ids.releaseMbid) },
            { label: "Release group", value: mb("release-group", ids.releaseGroupMbid) },
            { label: "Artist", value: mb("artist", ids.artistMbid) },
            { label: "Barcode", value: ids.barcode ?? "—" },
            { label: "Catalog number", value: ids.catalogNumber ?? "—" },
            { label: "Label", value: ids.label ?? "—" },
            { label: "Country", value: ids.country ?? "—" },
            { label: "Media", value: ids.media ?? "—" },
            { label: "Genres", value: ids.genres.length === 0 ? "—" : ids.genres.join(", ") },
          ]}
        />
        {album.wizardImportId === null ? null : (
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            nativeButton={false}
            render={<Link to="/import/new" search={{ importId: album.wizardImportId, step: 2 }} />}
          >
            <Disc3 className="size-3.5" aria-hidden="true" /> Change release…
          </Button>
        )}
      </div>
      <div className="rounded-xl border border-line bg-surface-1 p-3.5">
        <h2 className="mb-2 text-xs font-medium">Matching decision</h2>
        {album.decision === null ? (
          <p className="text-xs text-fg-2">
            No decision recorded. This album was not matched through the wizard — an import without
            MusicBrainz, or a release supplied on the command line.
          </p>
        ) : (
          <>
            <p className="text-xs text-fg-1">
              Chosen by <span className="font-medium">{album.decision.decidedBy}</span> on{" "}
              {dateTime(album.decision.at)}.
            </p>
            <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-line bg-surface-2 p-2 font-mono text-3xs text-fg-2">
              {JSON.stringify(album.decision.choice, null, 2)}
            </pre>
          </>
        )}
        {album.imports.length === 0 ? null : (
          <div className="mt-3">
            <h3 className="mb-1 text-2xs tracking-wider text-fg-2 uppercase">Imports</h3>
            <ul className="flex flex-col gap-1">
              {album.imports.map((job) => (
                <li key={job.id}>
                  <Link
                    to="/imports/$id"
                    params={{ id: job.id }}
                    className="font-mono text-2xs hover:text-primary"
                  >
                    {job.id}
                  </Link>{" "}
                  <span className="text-2xs text-fg-3">
                    {job.status} · {dateTime(job.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function HistoryTab({
  history,
}: {
  readonly history: Awaited<ReturnType<typeof fetchAlbumHistory>>;
}) {
  if (history.length === 0) {
    return <Callout tone="info">No journal lines: no import produced these files.</Callout>;
  }
  return (
    <div
      className="max-h-[36rem] overflow-auto rounded-xl border border-line bg-surface-1 p-2"
      data-testid="album-history"
    >
      {history.map((line) => (
        <div key={line.id} className="log-grid gap-2 px-1.5 py-0.5 text-2xs">
          <span className="font-mono text-fg-3">{clockTime(line.at)}</span>
          <span
            className={cn(
              "font-mono",
              line.level === "error"
                ? "text-danger"
                : line.level === "warn"
                  ? "text-warn"
                  : "text-fg-3",
            )}
          >
            {line.type}
          </span>
          <span className="text-fg-1">{line.message}</span>
        </div>
      ))}
    </div>
  );
}
