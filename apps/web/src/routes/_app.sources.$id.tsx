/**
 * `/sources/$id` — one watched source: its policy, its last scan, and every video it has seen.
 *
 * The item table is the honest answer to "why is this not in my library?". A video is either
 * an import you can click through to, or a row with a sentence saying which filter refused it
 * — never absent. A source that quietly drops things is a source nobody can trust.
 */
import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ImportStatusBadge, ToneBadge } from "#/components/status-badge.tsx";
import { TimeAgo } from "#/components/time-ago.tsx";
import { FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  fetchWatchedSource,
  patchWatchedSource,
  scanWatchedSourceNow,
} from "#/server/functions/watched-sources.ts";
import type { WatchedSourceDetail } from "#/server/services/watched-sources.ts";

export const Route = createFileRoute("/_app/sources/$id")({
  loader: async ({ params }) => await fetchWatchedSource({ data: { id: params.id } }),
  staticData: { crumbs: [{ label: "Watched sources", to: "/sources" }, { label: "Source" }] },
  component: WatchedSourceDetailPage,
});

const ITEM_TONE = {
  new: "info",
  imported: "ok",
  skipped: "muted",
  ignored: "muted",
} as const;

type Item = WatchedSourceDetail["items"][number];

function WatchedSourceDetailPage() {
  const { detail } = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const now = new Date();
  const [busy, setBusy] = useState(false);
  const [threshold, setThreshold] = useState(
    detail?.source.autoAcceptThreshold === null || detail?.source.autoAcceptThreshold === undefined
      ? ""
      : String(detail.source.autoAcceptThreshold),
  );

  if (detail === null) {
    return (
      <>
        <PageHeader title="Watched source" description="It is not there any more." />
        <Callout tone="warn">
          No source with that id. <Link to="/sources">Back to the list</Link>.
        </Callout>
      </>
    );
  }

  const source = detail.source;

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

  const columns: Column<Item>[] = [
    {
      key: "title",
      header: "Video",
      cell: (item) => (
        <div className="min-w-0">
          <div className="truncate font-medium">
            {item.title === "" ? item.videoId : item.title}
          </div>
          <div className="truncate font-mono text-2xs text-fg-2">{item.videoId}</div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (item) => <ToneBadge tone={ITEM_TONE[item.status]}>{item.status}</ToneBadge>,
    },
    {
      key: "import",
      header: "Import",
      cell: (item) =>
        item.job === null ? (
          <span className="text-2xs text-fg-3">{item.reason ?? "—"}</span>
        ) : (
          <span className="flex items-center gap-2">
            <ImportStatusBadge status={item.job.status} />
            <Link
              to="/imports/$id"
              params={{ id: item.job.id }}
              className="font-mono text-2xs underline"
              onClick={(event) => {
                event.stopPropagation();
              }}
            >
              {item.job.id}
            </Link>
          </span>
        ),
    },
    {
      key: "seen",
      header: "First seen",
      cell: (item) => <TimeAgo at={item.firstSeenAt} now={now} className="text-fg-2" />,
    },
  ];

  return (
    <>
      <PageHeader
        title={source.label === "" ? source.url : source.label}
        description={source.url}
        actions={
          <>
            <Button variant="outline" nativeButton={false} render={<Link to="/sources" />}>
              <ArrowLeft className="size-4" aria-hidden="true" /> All sources
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              data-testid="source-detail-scan"
              onClick={() => {
                act(
                  async () => await scanWatchedSourceNow({ data: { id: source.id } }),
                  "Scan queued.",
                );
              }}
            >
              <RotateCcw className="size-4" aria-hidden="true" /> Scan now
            </Button>
          </>
        }
      />

      {source.lastError === null ? null : (
        <Callout tone="danger" className="mb-3.5" data-testid="source-last-error">
          The last scan failed: {source.lastError.message}
          {source.lastError.hint === undefined ? null : ` — ${source.lastError.hint}`}
        </Callout>
      )}

      <div className="mb-3.5 grid gap-3.5 lg:grid-cols-2">
        <KeyValueList
          className="rounded-lg border border-line bg-surface-1 p-3.5"
          items={[
            { label: "Kind", value: source.kind },
            { label: "Enabled", value: source.enabled ? "yes" : "paused" },
            { label: "Last scan", value: source.lastScanStatus },
            {
              label: "Videos seen",
              value: `${String(detail.total)} — ${String(detail.imported)} imported, ${String(detail.skipped)} skipped`,
            },
            {
              label: "Duration filter",
              value:
                source.minDuration === null && source.maxDuration === null
                  ? "none"
                  : `${source.minDuration === null ? "0" : String(source.minDuration)}–${source.maxDuration === null ? "∞" : String(source.maxDuration)} s`,
            },
          ]}
        />

        <Section
          title="Policy"
          description="What this source may do on its own. Everything it may not do waits in the Inbox."
        >
          <FormRow
            label="Enabled"
            help="A paused source keeps its history and is skipped by the cron."
          >
            <Toggle
              testId="source-detail-enabled"
              checked={source.enabled}
              onChange={(next) => {
                act(
                  async () =>
                    await patchWatchedSource({ data: { id: source.id, patch: { enabled: next } } }),
                  next ? "Watching it again." : "Paused.",
                );
              }}
            />
          </FormRow>
          <FormRow
            label="Auto-accept"
            help="Confirms an import without you when the match is safe and unambiguous. It bypasses the review step."
          >
            <Toggle
              testId="source-detail-auto-accept"
              checked={source.autoAccept}
              onChange={(next) => {
                act(
                  async () =>
                    await patchWatchedSource({
                      data: { id: source.id, patch: { autoAccept: next } },
                    }),
                  next
                    ? "Unambiguous matches will be confirmed for you."
                    : "Every import will wait for you.",
                );
              }}
            />
          </FormRow>
          <FormRow
            label="Threshold override"
            help="Blank uses the installation's own. A source that mixes edits and live sets should ask for more."
          >
            <Input
              data-testid="source-detail-threshold"
              className="h-7 w-24 font-mono text-xs"
              placeholder="default"
              value={threshold}
              onChange={(event) => {
                setThreshold(event.target.value);
              }}
              onBlur={() => {
                const next = threshold.trim() === "" ? null : Number(threshold);
                if (next !== null && (Number.isNaN(next) || next < 0 || next > 1)) {
                  toast("A threshold is a number between 0 and 1.", "danger");
                  return;
                }
                act(
                  async () =>
                    await patchWatchedSource({
                      data: { id: source.id, patch: { autoAcceptThreshold: next } },
                    }),
                  "Threshold saved.",
                );
              }}
            />
          </FormRow>
        </Section>
      </div>

      <DataTable
        data-testid="source-items"
        columns={columns}
        rows={detail.items}
        rowKey={(item) => item.id}
        empty="Nothing seen yet. Scan it, or wait for the schedule."
      />
    </>
  );
}
