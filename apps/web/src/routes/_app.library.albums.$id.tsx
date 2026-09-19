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
  FileUp,
  ExternalLink,
  Image as ImageIcon,
  ListVideo,
  Lock,
  Play,
  Sparkles,
  Tag,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { AdoptFileDialog, type AdoptFileChoice } from "#/components/adopt-file-dialog.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover, albumCoverSources } from "#/components/cover.tsx";
import { primaryCoverUrl } from "#/lib/cover-sources.ts";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { MbLink, type MbEntity } from "#/components/mb-link.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { PlayButton } from "#/components/play-button.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { usePlayer, libraryTrack } from "#/components/shell/player-context.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import { CoverPicker } from "#/components/library/cover-picker.tsx";
import { FieldEditor, FieldSource, RelocateOffer } from "#/components/library/field-editor.tsx";
import { SchemaBadge, SchemaHeading, TagDiff } from "#/components/library/schema.tsx";
import { TagMapTable, type FormatColumns } from "#/components/library/tag-map-table.tsx";
import { VerifyTab } from "#/components/library/verify-tab.tsx";
import {
  SkeletonDetailHeader,
  SkeletonPage,
  SkeletonTable,
  SkeletonTabs,
} from "#/components/skeleton.tsx";
import { artistKey } from "#/lib/artist-links.ts";
import { interleaveSlots, slotKey, type AlbumSlot, type MissingTrack } from "#/lib/album-slots.ts";
import { bytes, clockTime, dateTime, mmss, pct, short } from "#/lib/format.ts";
import {
  adoptMissingTrack,
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
import { setAlbumField, unlockField } from "#/server/functions/overrides.ts";
import { runRelocate } from "#/server/functions/relocate.ts";
import { startRetag } from "#/server/functions/retag.ts";
import type { AlbumTrackRow } from "#/server/services/library.ts";
import type { AdriftReason } from "#/server/services/quality.ts";
import type { RelocatePlan } from "#/server/services/relocate.ts";

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

/**
 * Name the cause rather than making the reader guess at it.
 *
 * The three halves want different sentences because they are different accidents: somebody
 * changed the album's identity, somebody changed a field, or somebody changed the file. Shown
 * together when an album has managed more than one.
 */
function adriftExplanation(reasons: readonly AdriftReason[]): string {
  const parts = [
    reasons.includes("sources")
      ? "the release confirmed for this album is not the one its files were tagged from, so they still carry the previous edition's identifiers"
      : null,
    reasons.includes("document")
      ? "the database holds values that were never written into the files"
      : null,
    // The only one of the three that is a measurement rather than a comparison of two rows: the
    // scan opened the file. Saying so is what tells the reader it was not the app that moved.
    reasons.includes("file")
      ? "the last library scan read tags out of the files that this album's documents do not project — somebody edited them outside the app"
      : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "the files no longer match the database.";
  if (parts.length === 1) return `${parts[0] ?? ""}.`;
  return `${parts.slice(0, -1).join("; ")}; and ${parts.at(-1) ?? ""}.`;
}

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
  pendingComponent: AlbumPending,
});

/**
 * The album header — 160 px cover, the credit, the badge row, the six actions — then the tab
 * strip, then the tracklist.
 *
 * The loader also runs on a *tab* change (`loaderDeps` carries `tab`), so this is what the
 * DB-vs-files and Navidrome tabs show while their extra query runs, not only what a cold
 * arrival shows. The body is drawn as the Tracks tab because that is the default and the
 * widest of the six; the header and the strip above it are identical whichever lands.
 */
function AlbumPending() {
  return (
    <SkeletonPage name="library-album" label="Loading the album…">
      <SkeletonDetailHeader actions={5} badges={6} />
      <SkeletonTabs count={TABS.length} />
      <SkeletonTable
        rows={10}
        columns={["w-6", "w-1/3", "w-1/5", "w-12", "w-16", "w-16", "w-1/4"]}
      />
    </SkeletonPage>
  );
}

function Album() {
  const { album, comparison, history, verify } = Route.useLoaderData();
  const params = Route.useSearch();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const player = usePlayer();

  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [coverOpen, setCoverOpen] = useState(false);
  const [covers, setCovers] = useState<Awaited<ReturnType<typeof fetchCoverOptions>>>([]);
  /** The relocate a path-affecting edit just offered, waiting for a yes or a no. */
  const [offer, setOffer] = useState<RelocatePlan | null>(null);

  if (album === null) {
    return (
      <Callout tone="warn">
        No album with that id. It may have been deleted.{" "}
        <Link to="/library">back to the library</Link>.
      </Callout>
    );
  }

  const quality = album.quality;
  /** The tracks whose file is not on disk — `present` is a real `existsSync` (decision 090). */
  const missing = album.tracks.filter((track) => !track.present);
  const profiled = params.profile !== "global";
  const score = profiled ? quality.byProfile[params.profile as never] : quality.score;
  const { queue: albumQueue } = queueOf(album);

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
      return `${dryRun ? "Dry run" : "Re-tag"} queued for ${String(run.total)} file(s), from the raw cache (projection v${String(run.schemaVersion)}).`;
    });
  };

  /**
   * One album-scope override.
   *
   * The value is written on **every** track of the album, in one transaction — that is what
   * makes "one value per album-scope field" (§2.7) a property of the database rather than a
   * hope about the next re-tag. A name the path template uses comes back with a relocate plan,
   * which `RelocateOffer` puts behind a confirm.
   */
  const override = (label: string, run: () => Promise<AlbumOverrideAnswer>): void => {
    setBusy(label);
    void run().then(
      (result) => {
        setBusy(null);
        const names = result.changed.map((entry) => entry.vorbis).join(", ");
        toast(
          result.changed.length === 0
            ? "Nothing changed — the album already held that value."
            : `${names} written on ${String(result.changed[0]?.tracks ?? 0)} track(s)${
                result.retagRunId === null ? "" : "; re-tag queued"
              }.`,
          "ok",
        );
        if ((result.relocatePlan?.moves.length ?? 0) > 0) setOffer(result.relocatePlan);
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
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
        {/* The cover.jpg written beside the files, then the Cover Art Archive front. */}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <Cover
            size="xl"
            seed={album.album.id}
            label={album.album.title}
            src={albumCoverSources(album.album, "xl")}
          />
          {/*
           * Where this picture came from (decision 168).
           *
           * §4's cover ladder has four rungs and three of them are the Cover Art Archive, so
           * "source: coverartarchive" never distinguished the release's own cover from the one
           * borrowed off a sibling pressing. The document now carries the rung; this prints it.
           */}
          {quality.coverProvenance === null ? null : (
            <span
              data-testid="album-cover-provenance"
              title={quality.coverProvenance}
              className="w-40 truncate text-center text-3xs text-fg-3"
            >
              {quality.coverProvenance}
            </span>
          )}
        </div>
        <div className="min-w-0 grow">
          <div className="text-2xs tracking-wider text-fg-2 uppercase">
            {album.identifiers.releaseType ?? "album"}
            {album.album.year === null ? "" : ` · ${String(album.album.year)}`}
          </div>
          <h1 className="text-xl font-semibold" data-testid="album-title">
            {album.album.title}
          </h1>
          <div className="text-xs text-fg-1">
            {/* Their own page, keyed on the MBID the release credited when there is one. */}
            <Link
              to="/library/artists/$id"
              params={{
                id: artistKey({
                  name: album.album.albumArtist,
                  mbid: album.identifiers.artistMbid,
                }),
              }}
              data-testid="album-artist-link"
              className="text-primary"
            >
              {album.album.albumArtist}
            </Link>
            {album.identifiers.label === null ? null : ` · ${album.identifiers.label}`}
            {album.identifiers.country === null ? null : ` · ${album.identifiers.country}`}
            {album.identifiers.media === null ? null : ` · ${album.identifiers.media}`}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {/*
              `n/n` is only printable when the denominator is a *total*. This album said
              "1/1 tracks", green, at 97%, holding track 4 of a thirteen-track release, because
              both columns were the same file count. When the total is unknown — no release in
              the cache, no `totaltracks` in the files — the badge says how many tracks are
              here and admits it does not know how many there should be.
            */}
            {quality.totalKnown ? (
              <ToneBadge tone={quality.presentCount >= quality.trackCount ? "ok" : "warn"}>
                {quality.presentCount}/{quality.trackCount} tracks
              </ToneBadge>
            ) : (
              <ToneBadge
                tone="muted"
                data-testid="album-total-unknown"
                title="No MusicBrainz release for this album and no track totals in its tags, so how many tracks it should have is unknown."
              >
                {quality.presentCount}/? tracks
              </ToneBadge>
            )}
            {/*
              The album said "13/13 tracks · 50.6 MB" over a directory one file short, because
              only the "DB vs files" tab ever looked at the disk (DRIVE-1 §B5). `present` is a
              real `existsSync` per track (decision 090); the badge just stops hiding it.
            */}
            {missing.length === 0 ? null : (
              <ToneBadge
                tone="danger"
                // `album-missing`, and not the `album-incomplete` of the callout below: these
                // are two different facts. This badge counts rows whose *file* is not on the
                // disk; that callout counts tracks of the release the library never got. The
                // remedy differs too — re-download one, adopt the other — so the names do.
                data-testid="album-missing"
                title={`Not on disk: ${missing.map((track) => track.title).join(", ")}`}
              >
                {missing.length} file(s) missing
              </ToneBadge>
            )}
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
          {/*
            Back to where the audio came from.
            The provenance was already in the rows — `imports.url` is what was submitted, and
            each `import_tracks.raw` is the yt-dlp entry — and neither was ever shown, so an
            album's own YouTube playlist was three clicks and a copy-paste away. The playlist
            wins when the submitted URL is one (`list=` / `OLAK5uy_…`), and the first track's
            video is the fallback, which is also the answer for a single and for anything
            migrated from v1. Nothing at all when the provenance names no web address.
          */}
          {album.source === null ? null : (
            <a
              href={album.source.url}
              target="_blank"
              rel="noreferrer"
              data-testid="album-source-link"
              data-source-kind={album.source.kind}
              aria-label={album.source.label}
              title={album.source.url}
              className="mt-2 inline-flex items-center gap-1.5 text-2xs text-fg-2 hover:text-primary"
            >
              <ListVideo className="size-3.5" aria-hidden="true" />
              {album.source.kind === "playlist"
                ? "Source: the YouTube playlist this album was imported from"
                : "Source: the YouTube video this album was imported from"}
              <ExternalLink className="size-3" aria-hidden="true" />
            </a>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            data-testid="album-play"
            disabled={albumQueue.length === 0}
            title={
              albumQueue.length === 0
                ? "None of this album's files are on disk."
                : "Play the album, in order, from the first track."
            }
            onClick={() => {
              player.play(albumQueue, 0);
            }}
          >
            <Play className="size-4" aria-hidden="true" /> Play
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="album-fetch-missing"
            onClick={() => {
              act("fetch", async () => {
                const result = await fetchMissingTags({ data: { albumId: id } });
                return result.gained.length === 0
                  ? `Asked ${String(result.tracks)} track(s) again (${String(result.requests)} request(s)); the sources had nothing new.`
                  : `Gained ${result.gained.join(", ")}: ${pct(result.scoreBefore)} to ${pct(result.scoreAfter)}.`;
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

      {/*
        ---- the projection invariant, said out loud ----

        `AGENTS.md`: the database is the source of truth and the files are a regenerable
        projection of it. When that stops being true the owner used to find out from a library
        scan he had to think to ask for — and only if he knew a re-tag existed and remembered to
        run it. It is a state of *this album*, so it belongs on this album's page, with the one
        button that clears it beside it.

        `adrift.count` is deliberately not `filesBehind`: that one counts files written by an
        older projection *version*, which a re-matched album never is. See `quality.tracksAdrift`.
      */}
      {album.adrift.count === 0 ? null : (
        <Callout tone="warn" className="mb-3" data-testid="album-adrift">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <strong>{album.adrift.count} file(s) are behind the database</strong>
              {": "}
              {adriftExplanation(album.adrift.reasons)} The re-tag rebuilds each document from the
              raw cache and rewrites the tag block — offline, no re-download, the audio stream is
              not touched.
            </div>
            <Button
              size="sm"
              disabled={busy !== null}
              data-testid="album-adrift-retag"
              onClick={() => {
                act("adrift", async () => {
                  const run = await startRetag({
                    data: { scope: "album", targetId: id, selection: "adrift" },
                  });
                  return `Re-tag queued for ${String(run.total)} file(s) (projection v${String(run.schemaVersion)}).`;
                });
              }}
            >
              <Tag className="size-3.5" aria-hidden="true" /> Update the files
            </Button>
          </div>
        </Callout>
      )}

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
          onSetField={(field, value) => {
            override(field, async () => setAlbumField({ data: { id, edits: [{ field, value }] } }));
          }}
          onLockField={(field) => {
            override(field, async () =>
              setAlbumField({ data: { id, edits: [{ field, value: null, locked: true }] } }),
            );
          }}
          onReleaseField={(field) => {
            override(field, async () => unlockField({ data: { scope: "album", id, field } }));
          }}
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

      <RelocateOffer
        plan={offer}
        busy={busy === "relocate"}
        onOpenChange={(open) => {
          if (!open) setOffer(null);
        }}
        onConfirm={() => {
          setBusy("relocate");
          void runRelocate({ data: { albumId: id, dryRun: false } }).then(
            (report) => {
              setBusy(null);
              setOffer(null);
              toast(`Moved ${String(report.moved)} file(s).`, "ok");
              void router.invalidate();
            },
            (error: unknown) => {
              setBusy(null);
              toast(error instanceof Error ? error.message : "The move failed.", "danger");
            },
          );
        }}
      />

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

/** What the override server functions answer with. */
type AlbumOverrideAnswer = Awaited<ReturnType<typeof setAlbumField>>;
/**
 * The album as a play queue: its tracks in their own order, minus the ones whose file is not
 * on disk.
 *
 * Pressing play on track 7 must start at 7 and carry 8 through 14 with it, so the queue is the
 * whole album and the index is where you pressed. Filtering the missing files out *before*
 * indexing is what keeps that mapping right on an album with a hole in it.
 */
function queueOf(album: AlbumData): {
  readonly rows: readonly AlbumTrackRow[];
  readonly queue: readonly ReturnType<typeof libraryTrack>[];
} {
  // The player bar draws its tile at `sm`, so the queue carries the 160 px variant.
  const cover = primaryCoverUrl(albumCoverSources(album.album, "sm"));
  const rows = album.tracks.filter((track) => track.present);
  return {
    rows,
    queue: rows.map((track) =>
      libraryTrack({
        id: track.id,
        title: track.title,
        artist: track.artist ?? album.album.albumArtist,
        album: album.album.title,
        coverUrl: cover,
        durationSeconds: track.duration,
      }),
    ),
  };
}

/**
 * The tracklist, as the *record* rather than as the files.
 *
 * `library_albums` has been able to say `16/20` for a while and nothing could say which four
 * were missing, so an album that came out short was a number with no remedy behind it. The
 * four lines are now rows of this table, greyed, at their own positions, each with the one
 * button that fills it — because a hole you can see and a hole you can act on should not be
 * two different pages.
 *
 * The rows are `AlbumSlot`s and not `AlbumTrackRow`s: `interleaveSlots` merges what we hold
 * with what the release says on the couple `(mediumPosition, trackPosition)`, so disc 2's
 * track 1 sorts after disc 1's last and not beside disc 1's first. Every cell below therefore
 * answers for both kinds, and a missing row deliberately renders *nothing* in the columns that
 * describe a file — no duration, no score, no schema — rather than a dash that reads like a
 * measurement of something absent.
 */
function TracksTab({ album }: { readonly album: AlbumData }) {
  const navigate = useNavigate();
  const router = useRouter();
  const toast = useToast();
  const player = usePlayer();
  const { rows: playable, queue } = queueOf(album);

  /** The missing track whose dialog is open, if any. One dialog for the whole table. */
  const [adopting, setAdopting] = useState<MissingTrack | null>(null);
  const [busy, setBusy] = useState(false);

  const slots = interleaveSlots(album.tracks, album.missing.missing);
  /**
   * Whether to prefix the position with its disc.
   *
   * Read from the *rows* as well as from the release, and not from the release alone: an album
   * whose release is not in the local cache has `mediumCount: 0`, and a two-disc album in that
   * state would have lost the `2-` prefix it has always had here. The release is the better
   * answer when there is one — it knows about a disc we hold nothing from — and the rows are
   * the answer that never disappears.
   */
  const multiDisc =
    album.missing.mediumCount > 1 || album.tracks.some((track) => (track.discNumber ?? 1) > 1);

  const adopt = (choice: AdoptFileChoice): void => {
    const target = adopting;
    if (target === null) return;
    setBusy(true);
    void adoptMissingTrack({
      data: {
        albumId: album.album.id,
        mediumPosition: target.mediumPosition,
        trackPosition: target.trackPosition,
        source: choice,
      },
    }).then(
      (result) => {
        setBusy(false);
        setAdopting(null);
        toast(
          `“${result.trackTitle}” adopted; it carries on from ${result.nextStep ?? "here"} on its own.`,
          "ok",
        );
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(false);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  const columns: Column<AlbumSlot<AlbumTrackRow>>[] = [
    {
      key: "play",
      header: "",
      className: "w-9",
      cell: (slot) => {
        if (slot.kind === "missing") return null;
        const row = slot.track;
        const at = playable.findIndex((track) => track.id === row.id);
        const active = player.current?.id === `library:${row.id}`;
        return (
          <PlayButton
            data-testid="track-play"
            active={active}
            playing={player.playing}
            disabled={at === -1}
            title={at === -1 ? "The file is not on disk." : `Play from “${row.title}”`}
            onPlay={() => {
              if (active) player.toggle();
              else player.play(queue, at);
            }}
          />
        );
      },
    },
    {
      key: "n",
      header: "#",
      numeric: true,
      className: "w-10",
      cell: (slot) => (
        <span className="text-fg-3">
          {multiDisc ? `${String(slot.mediumPosition)}-` : ""}
          {slot.kind === "missing"
            ? // MusicBrainz's own spelling when it is not a plain number — `A2` on a vinyl —
              // and the column's two-digit padding when it is, so `01 · 2 · 03` cannot happen.
              /^\d+$/.test(slot.track.number)
              ? slot.track.number.padStart(2, "0")
              : slot.track.number
            : String(slot.track.trackNumber ?? 0).padStart(2, "0")}
        </span>
      ),
    },
    {
      key: "title",
      header: "Title",
      cell: (slot) =>
        slot.kind === "missing" ? (
          <span className="text-fg-3 italic" data-testid="missing-track-title">
            {slot.track.title}
          </span>
        ) : (
          <span className="font-medium">{slot.track.title}</span>
        ),
    },
    {
      key: "artist",
      header: "Artist",
      cell: (slot) => (
        // The credited artist, which on a compilation is not the album artist — and on `Cars`
        // it is the whole of what tells Chuck Berry's *Route 66* from John Mayer's.
        <span className={slot.kind === "missing" ? "text-fg-3" : "text-fg-2"}>
          {slot.track.artist ?? album.album.albumArtist}
        </span>
      ),
    },
    {
      key: "length",
      header: "Length",
      numeric: true,
      cell: (slot) =>
        slot.kind === "missing" ? (
          <span className="text-fg-3">{mmss(slot.track.lengthSeconds)}</span>
        ) : (
          mmss(slot.track.duration)
        ),
    },
    {
      key: "source",
      header: "Source",
      cell: (slot) => {
        if (slot.kind === "missing") {
          return (
            <span className="text-fg-3" data-testid="missing-track-source">
              never published
            </span>
          );
        }
        const row = slot.track;
        return row.videoId === null ? (
          <span className="text-fg-3">no video</span>
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
        );
      },
    },
    {
      key: "recording",
      header: "Recording",
      cell: (slot) => (
        // Both kinds carry one: a missing track's comes from the release, which is how you go
        // and look the recording up before deciding what file to give it.
        <span className="font-mono text-2xs text-fg-3">{short(slot.track.recordingMbid)}</span>
      ),
    },
    {
      key: "file",
      header: "File",
      className: "max-w-64",
      cell: (slot) =>
        slot.kind === "missing" ? (
          <span className="text-fg-3">—</span>
        ) : (
          <span className="block truncate font-mono text-2xs text-fg-3" title={slot.track.path}>
            {slot.track.path.slice(slot.track.path.lastIndexOf("/") + 1)}
          </span>
        ),
    },
    {
      key: "extras",
      header: "Extras",
      cell: (slot) => {
        if (slot.kind === "missing") {
          return (
            <ToneBadge
              tone="warn"
              data-testid="missing-track-badge"
              title="The release has this track and the library never got it. Give it a file or an address."
            >
              missing
            </ToneBadge>
          );
        }
        const row = slot.track;
        return (
          <span className="flex gap-1">
            {/*
              First, and in `danger`: a track that says `lrc` and `rg` and 99% about a file that
              is not there is worse than one that says nothing (DRIVE-1 §B5).
            */}
            {row.present ? null : (
              <ToneBadge
                tone="danger"
                data-testid="track-missing"
                title="The file is not on disk. Re-download it from the album's actions."
              >
                missing
              </ToneBadge>
            )}
            {row.hasLyrics ? <ToneBadge tone="ok">lrc</ToneBadge> : null}
            {row.hasReplayGain ? <ToneBadge tone="ok">rg</ToneBadge> : null}
          </span>
        );
      },
    },
    {
      key: "score",
      header: "Metadata",
      cell: (slot) =>
        slot.kind === "missing" ? null : (
          <ToneBadge tone={scoreTone(slot.track.score)}>{pct(slot.track.score)}</ToneBadge>
        ),
    },
    {
      key: "schema",
      header: "Schema",
      cell: (slot) =>
        slot.kind === "missing" ? null : (
          <SchemaBadge version={slot.track.tagSchemaVersion} current={album.currentSchema} />
        ),
    },
    {
      key: "fill",
      header: "",
      actions: true,
      className: "w-9",
      cell: (slot) =>
        slot.kind === "missing" ? (
          <Button
            size="icon-sm"
            variant="outline"
            data-testid="missing-track-adopt"
            aria-label={`Give ${slot.track.title} a file or an address`}
            title="Give this track a file or an address — it downloads, tags and files that track alone"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation();
              setAdopting(slot.track);
            }}
          >
            <FileUp className="size-3" aria-hidden="true" />
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/*
        Said above the table as well as in it, because the table is long and the four greyed
        rows are scattered through it. `unavailable` gets its own sentence: an empty list with
        no tracklist behind it is not an album that is complete, and the two look identical.
      */}
      {album.missing.unavailable !== null &&
      album.missing.presentCount < album.missing.trackCount ? (
        <Callout tone="info" data-testid="album-incomplete-unknown">
          This album is{" "}
          <strong>
            {album.missing.presentCount} of {album.missing.trackCount}
          </strong>{" "}
          tracks, and which ones are missing cannot be worked out here:{" "}
          {album.missing.unavailable === "no-release"
            ? "it was imported without MusicBrainz, so there is no tracklist to compare it against. Re-import it against a release."
            : "its release has never been fetched on this installation, so the tracklist is not in the local cache. Refetch it from MusicBrainz once, and everything after that is offline."}
        </Callout>
      ) : null}

      {album.missing.missing.length === 0 ? null : (
        <Callout tone="warn" data-testid="album-incomplete">
          <strong>
            {album.missing.missing.length} track(s) of this release are not in the library
          </strong>
          : they are listed below, greyed, at their own positions. The album was created anyway
          because the rest downloaded. Give one a file you have or an address to fetch it from, and
          that track alone is downloaded, tagged and filed — the others are not touched.
        </Callout>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="album-tracks"
          columns={columns}
          rows={slots}
          rowKey={(slot) =>
            slot.kind === "missing"
              ? `missing:${slotKey(slot.mediumPosition, slot.trackPosition)}`
              : slot.track.id
          }
          rowClassName={(slot) =>
            // `cursor-default` undoes the pointer `DataTable` puts on every row when the table
            // is clickable: a missing row is not, and a cursor that says otherwise is a promise
            // the row cannot keep.
            slot.kind === "missing" ? "bg-surface-2/40 text-fg-3 cursor-default" : undefined
          }
          onRowClick={(slot) => {
            // A missing row has no track page to open; its one action is the button on it.
            if (slot.kind === "missing") return;
            void navigate({ to: "/library/tracks/$id", params: { id: slot.track.id } });
          }}
          empty="No files placed for this album yet."
        />
      </div>

      {adopting === null ? null : (
        <AdoptFileDialog
          open
          onOpenChange={(open) => {
            if (!open) setAdopting(null);
          }}
          trackTitle={adopting.title}
          description={`“${adopting.title}” is on this album's release and no file of it is in the library yet. Give it a file you already have, or an address to fetch it from, and it alone is downloaded, tagged and filed.`}
          busy={busy}
          onAdopt={adopt}
        />
      )}
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
  onSetField,
  onLockField,
  onReleaseField,
}: {
  readonly album: AlbumData;
  readonly profile: string;
  readonly keys: boolean;
  readonly onProfile: (profile: string) => void;
  readonly onKeys: (keys: boolean) => void;
  readonly onRetag: (dryRun: boolean) => void;
  readonly busy: boolean;
  readonly onSetField: (field: string, value: string) => void;
  readonly onLockField: (field: string) => void;
  readonly onReleaseField: (field: string) => void;
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
          value={`${quality.presentCount}/${quality.totalKnown ? quality.trackCount : "?"}`}
          sub={
            quality.totalKnown
              ? `${quality.naCount} field(s) n/a for this release`
              : "the release total is unknown"
          }
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

      {quality.divergences.length === 0 ? null : (
        <div
          className="mb-3 overflow-hidden rounded-xl border border-warn-edge bg-surface-1"
          data-testid="album-divergences"
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2 text-xs font-medium">
            <span>Album-scope fields that differ between tracks</span>
            <ToneBadge tone="warn">-{quality.penalty.toFixed(2)} on the album score</ToneBadge>
            <span className="grow" />
            <span className="text-2xs font-normal text-fg-3">
              tracks {pct(quality.meanTrackScore)} · album {pct(quality.score)}
            </span>
          </div>
          <ul className="divide-y divide-line">
            {quality.divergences.map((entry) => (
              <li key={`${entry.field}-${String(entry.medium)}`} className="px-3.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{entry.vorbis}</span>
                  {entry.medium === null ? null : (
                    <ToneBadge tone="muted">disc {entry.medium}</ToneBadge>
                  )}
                  <span className="grow truncate text-2xs text-fg-3">{entry.rule}</span>
                  <span className="text-2xs text-fg-2">{entry.action}</span>
                  {/*
                   * The other half of the remedy. A re-tag unifies the field on whatever rule
                   * the tag map gives it; locking says *which* value the album carries, and a
                   * locked value beats every rule for ever (§2.7, step 1).
                   */}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    data-testid={`divergence-lock-${entry.field}`}
                    onClick={() => {
                      onLockField(entry.field);
                    }}
                  >
                    <Lock className="size-3.5" aria-hidden="true" /> Lock for the album
                  </Button>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {entry.values.slice(0, 6).map((value) => (
                    <li key={value.value} className="flex gap-2 text-2xs">
                      <span className="shrink-0 font-mono text-fg-3">
                        {value.tracks.length} track(s)
                      </span>
                      <span className="truncate text-fg-1">{value.value}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <div className="border-t border-line px-3.5 py-2 text-2xs text-fg-2">
            A field of album scope must carry the same value on every track, or Navidrome, Plex and
            Jellyfin group the files into two albums. The re-tag below writes the album&apos;s value
            on every file; it reads the raw cache and downloads nothing.
          </div>
        </div>
      )}

      {/*
       * Typing an album field by hand — the clean equivalent of v1's forced metadata.
       *
       * It is on the album and not on each track because these sixteen fields are *facts about
       * the album*: §2.7 says the value must be identical on every file or Navidrome, Plex and
       * Jellyfin split the record in two. Every edit here is written on every track in one
       * transaction, so the constraint holds in the database rather than in a convention.
       */}
      <div
        className="mb-3 overflow-hidden rounded-xl border border-line bg-surface-1"
        data-testid="album-fields"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <h3 className="text-xs font-medium">Album fields</h3>
          <span className="grow text-2xs text-fg-3">
            written on every track of the album · a locked value survives every rebuild
          </span>
        </div>
        <table className="w-full text-xs">
          <tbody>
            {album.albumFields.map((entry) => (
              <tr
                key={entry.field}
                data-testid={`album-field-${entry.field}`}
                className={cn(
                  "border-b border-line last:border-b-0",
                  entry.locked ? "bg-primary-soft/30" : null,
                )}
              >
                <td className="w-44 px-2.5 py-1 font-mono text-2xs text-fg-2">{entry.vorbis}</td>
                <td className="px-2.5 py-1">
                  <FieldEditor
                    field={entry.field}
                    vorbis={entry.vorbis}
                    value={entry.value}
                    multi={entry.multi}
                    locked={entry.locked}
                    busy={busy}
                    onSave={(value) => {
                      onSetField(entry.field, value);
                    }}
                    onLock={() => {
                      onLockField(entry.field);
                    }}
                    onRelease={() => {
                      onReleaseField(entry.field);
                    }}
                  />
                </td>
                <td className="w-40 px-2.5 py-1">
                  {entry.source === null ? (
                    <span className="text-2xs text-fg-3">not set</span>
                  ) : (
                    <FieldSource
                      source={entry.source}
                      locked={entry.locked}
                      note={entry.note ?? undefined}
                    />
                  )}
                </td>
                <td className="w-24 px-2.5 py-1 text-right">
                  {entry.divergent ? <ToneBadge tone="warn">differs</ToneBadge> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout tone={behind ? "warn" : "ok"} className="mb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <SchemaHeading current={album.currentSchema} overridden={album.schemaOverridden} />{" "}
            {behind ? (
              <>
                {quality.filesBehind} file(s) were written by an older projection. The re-tag reads
                the raw cache (no network, no re-download, the audio stream is not touched) and
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
            Write DB to files
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
  const mb = (kind: MbEntity, id: string | null) => <MbLink kind={kind} mbid={id} />;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="rounded-xl border border-line bg-surface-1 p-3.5">
        <h2 className="mb-2 text-xs font-medium">Identifiers</h2>
        <KeyValueList
          items={[
            { label: "Release", value: mb("release", ids.releaseMbid) },
            { label: "Release group", value: mb("release-group", ids.releaseGroupMbid) },
            { label: "Artist", value: mb("artist", ids.artistMbid) },
            { label: "Barcode", value: ids.barcode ?? "not set" },
            { label: "Catalog number", value: ids.catalogNumber ?? "not set" },
            { label: "Label", value: ids.label ?? "not set" },
            { label: "Country", value: ids.country ?? "not set" },
            { label: "Media", value: ids.media ?? "not set" },
            { label: "Genres", value: ids.genres.length === 0 ? "none" : ids.genres.join(", ") },
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
            No decision recorded. This album was not matched through the wizard: an import without
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
        <div key={line.id} className="event-grid gap-2 px-1.5 py-0.5 text-2xs">
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
