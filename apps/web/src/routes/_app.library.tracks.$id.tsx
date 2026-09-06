/**
 * `/library/tracks/:id` — one file, and everything known about it.
 *
 * The page is laid out as the answer to three questions, in the order people ask them:
 * *what is in this file* (the tags, with their provenance), *where did it come from* (the
 * video, the fingerprint, the confidence at import) and *what is missing*.
 *
 * The tag list is the **document**, not the file: the database is the source of truth, and the
 * file is a projection of it. The album's "DB vs files" tab is where the two are compared;
 * this page shows what we hold, and the source of every field, which is the thing no other
 * screen shows.
 */
import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Download, Tag, Trash2 } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { ConfirmDialog } from "#/components/library/confirm-dialog.tsx";
import { SchemaBadge } from "#/components/library/schema.tsx";
import { bytes, dateTime, mmss, pct, short } from "#/lib/format.ts";
import { fetchTrack, redownload, removeTrack } from "#/server/functions/library.ts";
import { startRetag } from "#/server/functions/retag.ts";
import type { TrackDocument } from "@mm/domain";
import { PROFILE_IDS, tagByField } from "@mm/domain";

export const Route = createFileRoute("/_app/library/tracks/$id")({
  loader: async ({ params }) => await fetchTrack({ data: { id: params.id } }),
  staticData: { crumbs: [{ label: "Library", to: "/library" }, { label: "Track" }] },
  component: TrackPage,
});

/** Render one document value as text, whatever shape it has. */
function render(value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(render).join(" · ");
  const record = value as Record<string, unknown>;
  if ("synced" in record || "plain" in record) return "(lyrics)";
  if ("url" in record) return String(record["url"]);
  if ("name" in record && "role" in record)
    return `${String(record["name"])} (${String(record["role"])})`;
  return JSON.stringify(value);
}

function TrackPage() {
  const detail = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (detail === null) {
    return (
      <Callout tone="warn">
        No track with that id. <Link to="/library/tracks">Back to the tracks</Link>.
      </Callout>
    );
  }

  const { track, album, document, source, job } = detail;
  const fields = document === null ? [] : entriesOf(document);

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

  return (
    <>
      <div className="mb-4 flex flex-wrap items-start gap-4">
        <Cover size="lg" seed={album?.id ?? track.id} label={track.title} />
        <div className="min-w-0 grow">
          <div className="text-2xs tracking-wider text-fg-2 uppercase">
            Track {String(track.trackNumber ?? 0).padStart(2, "0")}
            {album === null ? "" : ` · ${album.title}`}
          </div>
          <h1 className="text-lg font-semibold" data-testid="track-title">
            {track.title}
          </h1>
          <div className="text-xs text-fg-1">
            {track.artist ?? "unknown artist"} ·{" "}
            <span className="font-mono">{mmss(track.duration)}</span> · {track.format ?? "?"} ·{" "}
            {bytes(track.size)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ToneBadge tone={scoreTone(detail.score)}>{pct(detail.score)}</ToneBadge>
            <SchemaBadge version={track.tagSchemaVersion} current={detail.currentSchema} />
            {detail.lyrics === null ? null : <ToneBadge tone="ok">lyrics</ToneBadge>}
            <span className="font-mono text-2xs text-fg-3">{track.path}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="track-retag"
            onClick={() => {
              act("retag", async () => {
                const run = await startRetag({
                  data: { scope: "track", targetId: id, dryRun: false, onlyBehind: false },
                });
                return `Re-tag queued (run ${run.runId}), projection v${String(run.schemaVersion)}.`;
              });
            }}
          >
            <Tag className="size-4" aria-hidden="true" /> Re-tag
          </Button>
          <Button
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              act("redownload", async () => {
                const plans = await redownload({ data: { trackId: id } });
                return plans.length === 0
                  ? "This file has no import behind it, so there is nothing to re-download."
                  : "Queued for re-download; the mapping is kept.";
              });
            }}
          >
            <Download className="size-4" aria-hidden="true" /> Re-download
          </Button>
          <Button
            variant="destructive"
            disabled={busy !== null}
            onClick={() => {
              setConfirmDelete(true);
            }}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-3">
          <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2">
              <h2 className="text-xs font-medium">The document</h2>
              <span className="text-2xs text-fg-3">
                {fields.length} field(s) · the database, not the file
              </span>
            </header>
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-2xs tracking-wider text-fg-2 uppercase">
                  <th className="px-2.5 py-1.5 text-left font-medium">Field</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Value</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Source</th>
                  <th className="px-2.5 py-1.5 text-left font-medium">Fetched</th>
                </tr>
              </thead>
              <tbody data-testid="track-document">
                {fields.map((entry) => (
                  <tr key={entry.field} className="border-b border-line last:border-b-0">
                    <td className="px-2.5 py-1 font-mono text-2xs">{entry.vorbis}</td>
                    <td className="max-w-96 px-2.5 py-1">
                      <span className="block truncate" title={entry.value}>
                        {entry.value}
                      </span>
                    </td>
                    <td className="px-2.5 py-1 text-2xs text-fg-2">
                      {entry.source}
                      {entry.locked ? " · locked" : ""}
                    </td>
                    <td className="px-2.5 py-1 font-mono text-2xs text-fg-3">
                      {entry.fetchedAt.slice(0, 10)}
                    </td>
                  </tr>
                ))}
                {fields.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-2.5 py-6 text-center text-fg-2">
                      No document for this file. It was not produced by an import.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </section>

          {detail.lyrics === null ? null : (
            <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
              <header className="border-b border-line px-3.5 py-2">
                <h2 className="text-xs font-medium">Lyrics</h2>
              </header>
              <pre className="max-h-72 overflow-auto px-3.5 py-2 font-mono text-2xs whitespace-pre-wrap text-fg-2">
                {detail.lyrics}
              </pre>
            </section>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <section className="rounded-xl border border-line bg-surface-1 p-3.5">
            <h2 className="mb-2 text-xs font-medium">Source</h2>
            <KeyValueList
              items={[
                {
                  label: "YouTube",
                  value:
                    source === null ? (
                      "none"
                    ) : (
                      <a
                        href={`https://youtu.be/${source.videoId}`}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-2xs hover:text-primary"
                      >
                        {source.videoId}
                      </a>
                    ),
                },
                { label: "Uploader", value: source?.uploader ?? "unknown" },
                {
                  label: "Import",
                  value:
                    job === null ? (
                      "none"
                    ) : (
                      <Link
                        to="/imports/$id"
                        params={{ id: job.id }}
                        className="font-mono text-2xs hover:text-primary"
                      >
                        {job.id}
                      </Link>
                    ),
                },
                { label: "Downloaded", value: dateTime(track.createdAt) },
                {
                  label: "Fingerprint",
                  value:
                    source?.fingerprintOk === null || source === null ? (
                      "not measured"
                    ) : (
                      <ToneBadge tone={source.fingerprintOk === true ? "ok" : "warn"}>
                        AcoustID {source.fingerprintOk === true ? "agrees" : "disagreed"}
                      </ToneBadge>
                    ),
                },
                {
                  label: "Confidence",
                  value: source === null ? "not scored" : pct(source.confidence),
                },
              ]}
            />
          </section>

          <section className="rounded-xl border border-line bg-surface-1 p-3.5">
            <h2 className="mb-2 text-xs font-medium">Identifiers</h2>
            <KeyValueList
              items={[
                {
                  label: "Recording",
                  value: (
                    <span className="font-mono text-2xs">{short(track.recordingMbid, 36)}</span>
                  ),
                },
                {
                  label: "Track",
                  value: <span className="font-mono text-2xs">{short(track.trackMbid, 36)}</span>,
                },
                {
                  label: "Album",
                  value:
                    album === null ? (
                      "none"
                    ) : (
                      <Link
                        to="/library/albums/$id"
                        params={{ id: album.id }}
                        className="hover:text-primary"
                      >
                        {album.title}
                      </Link>
                    ),
                },
              ]}
            />
          </section>

          <section className="rounded-xl border border-line bg-surface-1 p-3.5">
            <h2 className="mb-2 text-xs font-medium">Visible in</h2>
            <div className="flex flex-col gap-1">
              {PROFILE_IDS.map((profile) => (
                <div key={profile} className="flex items-center justify-between text-xs">
                  <span className="text-fg-2">{profile}</span>
                  <ToneBadge tone={scoreTone(detail.byProfile[profile])}>
                    {pct(detail.byProfile[profile])}
                  </ToneBadge>
                </div>
              ))}
            </div>
            <p className="mt-2 text-3xs text-fg-3">
              A profile scores only what that consumer reads back. It never changes what is written:
              the superset goes into the file whatever this list says.
            </p>
          </section>

          {detail.missing.length === 0 ? null : (
            <section className="rounded-xl border border-line bg-surface-1 p-3.5">
              <h2 className="mb-2 text-xs font-medium">Missing ({detail.missing.length})</h2>
              <div className="flex flex-wrap gap-1">
                {detail.missing.slice(0, 40).map((field) => {
                  const tag = tagByField(field);
                  return (
                    <span
                      key={field}
                      title={tag?.source}
                      className={cn(
                        "rounded-sm px-1.5 py-0.5 font-mono text-3xs",
                        tag?.level === "required"
                          ? "bg-danger-soft text-danger"
                          : tag?.level === "recommended"
                            ? "bg-warn-soft text-warn"
                            : "bg-muted-soft text-fg-2",
                      )}
                    >
                      {tag?.vorbis ?? field}
                    </span>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete “${track.title}”?`}
        description="The audio file and its .lrc sidecar are removed from disk, and the row is removed from the database."
        consequence={
          <span className="font-mono text-2xs">
            {track.path} · {bytes(track.size)}
          </span>
        }
        confirmLabel="Delete the file"
        busy={busy === "delete"}
        onConfirm={() => {
          setBusy("delete");
          void removeTrack({ data: { id } }).then(
            (result) => {
              setBusy(null);
              setConfirmDelete(false);
              toast(`Deleted ${String(result.files)} file(s).`, "ok");
              void router.navigate({ to: "/library/tracks" });
            },
            (error: unknown) => {
              setBusy(null);
              toast(error instanceof Error ? error.message : "Delete failed.", "danger");
            },
          );
        }}
      />
    </>
  );
}

interface DocumentEntry {
  readonly field: string;
  readonly vorbis: string;
  readonly value: string;
  readonly source: string;
  readonly fetchedAt: string;
  readonly locked: boolean;
}

/** The document's fields in tag-map order, rendered for a table. */
function entriesOf(document: TrackDocument): DocumentEntry[] {
  return Object.entries(document.fields)
    .map(([field, held]) => ({
      field,
      vorbis: tagByField(field)?.vorbis ?? field.toUpperCase(),
      value: render(held.value),
      source: held.source,
      fetchedAt: held.fetchedAt,
      locked: held.locked,
    }))
    .sort((a, b) => a.vorbis.localeCompare(b.vorbis));
}
