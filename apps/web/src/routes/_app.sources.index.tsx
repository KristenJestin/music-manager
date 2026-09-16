/**
 * `/sources` — the playlists and channels this installation watches.
 *
 * One table and one add form. The add form is on the page rather than behind a dialog because
 * adding a source is the first thing anybody does here and an empty page with a button that
 * opens a dialog is one click of nothing.
 *
 * The auto-accept switch carries a sentence saying what it costs you, every time, next to the
 * control rather than in a tooltip: it is the one setting in this app that lets the algorithm
 * confirm an import without you, and `docs/04-pipeline-et-matching.md` is explicit that this
 * is an exception rather than a convenience.
 */
import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { TimeAgo } from "#/components/time-ago.tsx";
import { Toggle } from "#/components/settings/controls.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import {
  Skeleton,
  SkeletonPage,
  SkeletonPageHeader,
  SkeletonTable,
} from "#/components/skeleton.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  addWatchedSource,
  fetchWatchedSources,
  patchWatchedSource,
  removeWatchedSource,
  scanWatchedSourceNow,
} from "#/server/functions/watched-sources.ts";
import type { WatchedSourceSummary } from "#/server/services/watched-sources.ts";

export const Route = createFileRoute("/_app/sources/")({
  loader: async () => await fetchWatchedSources(),
  staticData: { crumbs: [{ label: "Watched sources" }] },
  component: WatchedSources,
  pendingComponent: WatchedSourcesPending,
});

/** The "watch a URL" card, then the seven-column table of what is already watched. */
function WatchedSourcesPending() {
  return (
    <SkeletonPage name="sources" label="Loading the watched sources…">
      <SkeletonPageHeader actions={3} />
      <div className="mb-3.5 rounded-lg border border-line bg-surface-1 p-3.5">
        <div className="flex flex-wrap items-end gap-2">
          <Skeleton className="h-8 min-w-0 flex-1 rounded-lg" />
          <Skeleton className="h-8 w-48 rounded-lg" />
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
        <Skeleton className="mt-2.5 h-5 w-64" />
      </div>
      <SkeletonTable
        rows={6}
        columns={["w-1/3", "w-16", "w-20", "w-24", "w-1/6", "w-16", "w-20"]}
      />
    </SkeletonPage>
  );
}

const SCAN_TONE = {
  never: "muted",
  ok: "ok",
  partial: "warn",
  failed: "danger",
} as const;

function WatchedSources() {
  const { sources } = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const now = new Date();

  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [autoAccept, setAutoAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doomed, setDoomed] = useState<WatchedSourceSummary | null>(null);

  const act = (run: () => Promise<unknown>, message: string): void => {
    setBusy(true);
    void run().then(
      () => {
        setBusy(false);
        toast(message, "ok");
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(false);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  const add = (): void => {
    if (url.trim() === "") return;
    act(async () => {
      await addWatchedSource({
        data: {
          url: url.trim(),
          ...(label.trim() === "" ? {} : { label: label.trim() }),
          autoAccept,
        },
      });
      setUrl("");
      setLabel("");
    }, "Watching it. Scan it now, or wait for the schedule.");
  };

  const columns: Column<WatchedSourceSummary>[] = [
    {
      key: "source",
      header: "Source",
      cell: (entry) => (
        <div className="min-w-0">
          <div className="truncate font-medium">
            {entry.source.label === "" ? entry.source.url : entry.source.label}
          </div>
          <div className="truncate text-2xs text-fg-2">{entry.source.url}</div>
        </div>
      ),
    },
    {
      key: "kind",
      header: "Kind",
      cell: (entry) => <ToneBadge outline>{entry.source.kind}</ToneBadge>,
    },
    {
      key: "auto",
      header: "Auto-accept",
      cell: (entry) =>
        entry.source.autoAccept ? (
          <ToneBadge tone="warn">on</ToneBadge>
        ) : (
          <ToneBadge tone="muted" outline>
            off
          </ToneBadge>
        ),
    },
    {
      key: "videos",
      header: "Videos",
      numeric: true,
      cell: (entry) => (
        <span title={`${String(entry.skipped)} skipped`}>
          {entry.imported}/{entry.total}
        </span>
      ),
    },
    {
      key: "scan",
      header: "Last scan",
      cell: (entry) => (
        <span className="flex items-center gap-2">
          <ToneBadge tone={SCAN_TONE[entry.source.lastScanStatus]} outline>
            {entry.source.lastScanStatus}
          </ToneBadge>
          {entry.source.lastScanAt === null ? null : (
            <TimeAgo at={entry.source.lastScanAt} now={now} className="text-fg-2" />
          )}
        </span>
      ),
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (entry) => (
        <span
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Toggle
            testId={`source-enabled-${entry.source.id}`}
            checked={entry.source.enabled}
            onChange={(next) => {
              act(
                async () =>
                  await patchWatchedSource({
                    data: { id: entry.source.id, patch: { enabled: next } },
                  }),
                next ? "Watching it again." : "Paused. The cron will skip it.",
              );
            }}
          />
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (entry) => (
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="outline"
            data-testid={`source-scan-${entry.source.id}`}
            onClick={(event) => {
              event.stopPropagation();
              act(
                async () => await scanWatchedSourceNow({ data: { id: entry.source.id } }),
                "Scan queued. The worker picks it up next poll.",
              );
            }}
          >
            Scan now
          </Button>
          <Button
            size="xs"
            variant="outline"
            data-testid={`source-delete-${entry.source.id}`}
            onClick={(event) => {
              event.stopPropagation();
              setDoomed(entry);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Watched sources"
        description="A playlist or a channel, scanned on a schedule. Every new video becomes an import."
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                void router.invalidate();
                toast("Refreshed.");
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Refresh
            </Button>
            <Button
              variant="outline"
              data-testid="sources-scan-all"
              disabled={busy}
              onClick={() => {
                act(
                  async () => await scanWatchedSourceNow({ data: {} }),
                  "Scanning every enabled source.",
                );
              }}
            >
              Scan all
            </Button>
          </>
        }
      />

      <div
        className="mb-3.5 rounded-lg border border-line bg-surface-1 p-3.5"
        data-testid="source-add"
      >
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-2xs text-fg-2">
            Playlist or channel URL
            <Input
              data-testid="source-url"
              className="h-8 text-xs"
              placeholder="https://www.youtube.com/@artist"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-2xs text-fg-2">
            Label (optional)
            <Input
              data-testid="source-label"
              className="h-8 w-48 text-xs"
              placeholder="taken from the listing"
              value={label}
              onChange={(event) => {
                setLabel(event.target.value);
              }}
            />
          </label>
          <Button data-testid="source-add-submit" disabled={busy} onClick={add}>
            <Plus className="size-4" aria-hidden="true" /> Watch
          </Button>
        </div>
        <div className="mt-2.5 flex items-center gap-2">
          <Toggle
            testId="source-auto-accept"
            label="Auto-accept unambiguous matches"
            checked={autoAccept}
            onChange={setAutoAccept}
          />
        </div>
        {autoAccept ? (
          <Callout tone="warn" className="mt-2.5">
            This source will <strong>confirm imports without you</strong> whenever the match is safe
            and unambiguous — no review step, no wizard. Everything below that bar still waits in
            the Inbox, and every automatic confirmation is logged against{" "}
            <code>watched-source</code>.
          </Callout>
        ) : null}
      </div>

      <DataTable
        data-testid="sources-table"
        columns={columns}
        rows={sources}
        rowKey={(entry) => entry.source.id}
        onRowClick={(entry) => {
          void router.navigate({ to: "/sources/$id", params: { id: entry.source.id } });
        }}
        empty={
          <span>
            Nothing watched yet. Paste a playlist or channel URL above — or read{" "}
            <Link to="/settings/sources" className="underline">
              what a scan is allowed to do
            </Link>{" "}
            first.
          </span>
        }
      />

      <ConfirmDialog
        open={doomed !== null}
        onOpenChange={(open) => {
          if (!open) setDoomed(null);
        }}
        title="Stop watching this source?"
        description={doomed?.source.url ?? ""}
        consequence={
          doomed === null ? null : (
            <>
              {doomed.total} remembered video(s) are forgotten with it. The {doomed.imported}{" "}
              import(s) it already opened are <strong>kept</strong>, and so is everything they put
              in the library.
            </>
          )
        }
        confirmLabel="Stop watching"
        busy={busy}
        onConfirm={() => {
          const id = doomed?.source.id;
          if (id === undefined) return;
          setDoomed(null);
          act(async () => await removeWatchedSource({ data: { id } }), "No longer watched.");
        }}
        testId="source-delete-confirm"
      />
    </>
  );
}
