/**
 * `/tools` — everything that breaks in practice, in one place.
 *
 * The page is the answer to the second pain of v1: when it breaks, you cannot tell why. So it
 * is a column of diagnostics that each say *what is true right now* and offer the one button
 * that fixes it — update yt-dlp, test the cookies, rescan Navidrome, re-tag the drifted files.
 *
 * Nothing on this page is cached. A latency you read off a cache is not a latency, and a
 * "last scan" that is thirty seconds stale is worse than one that says it is loading.
 */
import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Download, Play, RefreshCw, Scan, ShieldCheck, Trash2, Wrench } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { LogViewer } from "#/components/log-viewer.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { ToneBadge, type Tone } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { bytes, timeAgo } from "#/lib/format.ts";
import {
  fetchTools,
  fixDrift,
  identifyFile,
  redownloadMissing,
  runCookiesTest,
  runNavidromeRescan,
  runSelftest,
  runServiceLatencies,
  runUrlTest,
  runYtdlpUpdate,
  startScan,
  trashFileAction,
} from "#/server/functions/tools.ts";
import { verifyAll } from "#/server/functions/verify.ts";
import { MigrateCard } from "#/components/tools/migrate-card.tsx";
import type { ToolsPayload } from "#/server/functions/tools.ts";
import type {
  DriftedTrack,
  DuplicateGroup,
  MissingFile,
  OrphanFile,
} from "#/server/services/scan.ts";
import type { ErrorCatalogEntry } from "#/server/toolbox/client.ts";
import type { UrlTest } from "#/server/services/tools.ts";

export const Route = createFileRoute("/_app/tools")({
  loader: async () => await fetchTools(),
  staticData: { crumbs: [{ label: "System" }, { label: "Tools" }] },
  component: Tools,
});

/* ------------------------------------------------------------------ */
/* one diagnostic row                                                  */
/* ------------------------------------------------------------------ */

function Diag({
  name,
  detail,
  tone = "ok",
  children,
  testId,
}: {
  readonly name: string;
  readonly detail: string;
  readonly tone?: Tone;
  readonly children?: React.ReactNode;
  readonly testId?: string;
}) {
  const DOT: Record<Tone, string> = {
    ok: "bg-ok",
    warn: "bg-warn",
    danger: "bg-danger",
    info: "bg-info",
    muted: "bg-fg-3",
    primary: "bg-primary",
  };
  return (
    <div
      data-testid={testId}
      className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
    >
      <span className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{name}</div>
        <div className="truncate text-2xs text-fg-2">{detail}</div>
      </div>
      <div className="flex shrink-0 gap-1.5">{children}</div>
    </div>
  );
}

function Panel({
  title,
  actions,
  children,
  testId,
}: {
  readonly title: string;
  readonly actions?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly testId?: string;
}) {
  return (
    <section
      data-testid={testId}
      className="overflow-hidden rounded-xl border border-line bg-surface-1"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="text-xs font-medium tracking-wide">{title}</h2>
        <div className="flex gap-1.5">{actions}</div>
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

function Tools() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [urlValue, setUrlValue] = useState("");
  const [urlResult, setUrlResult] = useState<UrlTest | null>(null);
  const [services, setServices] = useState(data.services);

  const act = (key: string, run: () => Promise<string>): void => {
    setBusy(key);
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
      <PageHeader
        title="Tools &amp; diagnostics"
        description="Everything that breaks in practice, in one place."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              void router.invalidate();
              toast("Re-checked.");
            }}
          >
            <RefreshCw className="size-4" aria-hidden="true" /> Re-check
          </Button>
        }
      />

      <div className="grid gap-3.5 xl:grid-cols-2">
        <div className="flex flex-col gap-3.5">
          <DownloaderPanel data={data} busy={busy} act={act} />
          <ServicesPanel
            services={services}
            onRefresh={() => {
              setBusy("services");
              void runServiceLatencies().then(
                (next) => {
                  setBusy(null);
                  setServices(next);
                },
                () => {
                  setBusy(null);
                },
              );
            }}
            busy={busy === "services"}
          />
          <UrlTestPanel
            value={urlValue}
            onChange={setUrlValue}
            result={urlResult}
            busy={busy === "url"}
            onRun={() => {
              setBusy("url");
              void runUrlTest({ data: { url: urlValue } }).then(
                (result) => {
                  setBusy(null);
                  setUrlResult(result);
                },
                (error: unknown) => {
                  setBusy(null);
                  toast(error instanceof Error ? error.message : "Extract failed.", "danger");
                },
              );
            }}
          />
          <ErrorDecoder entries={data.errors} problem={data.errorsProblem} />
        </div>

        <div className="flex flex-col gap-3.5">
          <ScanPanel data={data} busy={busy} act={act} />
          <MigrateCard />
          <Panel title="Worker log" testId="tools-log">
            <div className="p-3">
              <LogViewer events={data.log} emptyLabel="The journal is empty." />
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* downloader health                                                   */
/* ------------------------------------------------------------------ */

function DownloaderPanel({
  data,
  busy,
  act,
}: {
  readonly data: ToolsPayload;
  readonly busy: string | null;
  readonly act: (key: string, run: () => Promise<string>) => void;
}) {
  const { downloader, cookies, navidrome, verified, tagSchema } = data;
  const versions = downloader.versions;
  const now = new Date();

  return (
    <Panel title="Downloader health" testId="tools-health">
      <Diag
        testId="diag-ytdlp"
        name="yt-dlp"
        tone={downloader.reachable ? (versions["yt-dlp"] === null ? "danger" : "ok") : "danger"}
        detail={
          downloader.reachable
            ? `${versions["yt-dlp"] ?? "not installed"} · ${downloader.channel}${downloader.pin === "" ? "" : ` · pinned ${downloader.pin}`} · auto-update ${downloader.autoUpdate ? downloader.updateCron : "off"}${downloader.fixtures ? " · fixtures mode" : ""}`
            : (downloader.error ?? "the toolbox is not answering")
        }
      >
        <Button
          size="xs"
          disabled={busy !== null}
          onClick={() => {
            act("update", async () => {
              const result = await runYtdlpUpdate();
              return result.updated
                ? `yt-dlp updated from ${result.from ?? "?"} to ${result.to ?? "?"}.`
                : `yt-dlp is unchanged (${result.to ?? result.from ?? "?"}).`;
            });
          }}
          data-testid="ytdlp-update"
        >
          Update
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            act("selftest", async () => {
              const result = await runSelftest({ data: { network: false } });
              const failed = result.checks.filter((check) => !check.ok);
              return failed.length === 0
                ? `Self-test OK: ${result.checks.map((check) => check.name).join(", ")}.`
                : `Self-test failed: ${failed.map((check) => `${check.name} (${check.detail})`).join(", ")}.`;
            });
          }}
          data-testid="ytdlp-selftest"
        >
          Self-test
        </Button>
        <Button
          size="xs"
          variant="ghost"
          nativeButton={false}
          render={
            <a
              href="https://github.com/yt-dlp/yt-dlp/releases"
              target="_blank"
              rel="noreferrer noopener"
            />
          }
        >
          Changelog
        </Button>
      </Diag>

      <Diag
        testId="diag-cookies"
        name="Cookies"
        tone={cookies.mode === "anonymous" ? "muted" : cookies.ok ? "ok" : "warn"}
        detail={
          cookies.mode === "anonymous"
            ? cookies.note
            : `${String(cookies.cookies)} cookie(s) · ${cookies.authenticated ? "session present" : "no session cookie"}${cookies.expiresAt === null ? "" : ` · first lapses ${timeAgo(cookies.expiresAt, now)}`}${cookies.problems.length === 0 ? "" : ` · ${cookies.problems[0] ?? ""}`}`
        }
      >
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            act("cookies", async () => {
              const result = await runCookiesTest();
              return result.ok ? "Cookies are a usable session." : result.note;
            });
          }}
          data-testid="cookies-test"
        >
          Test
        </Button>
      </Diag>

      <Diag
        testId="diag-binaries"
        name="ffmpeg / fpcalc / rsgain"
        tone={
          versions.ffmpeg !== null && versions.fpcalc !== null && versions.rsgain !== null
            ? "ok"
            : "warn"
        }
        detail={`${versions.ffmpeg ?? "missing"} · ${versions.fpcalc ?? "missing"} · ${versions.rsgain ?? "missing"} — from ${data.toolbox.url}`}
      />

      <Diag
        testId="diag-navidrome"
        name="Navidrome"
        tone={navidrome.ok ? "ok" : navidrome.configured ? "danger" : "muted"}
        detail={
          navidrome.ok
            ? `${navidrome.server} ${navidrome.serverVersion} · ${String(navidrome.latencyMs)} ms · ${navidrome.songCount === null ? "never scanned" : `${String(navidrome.songCount)} songs`}${navidrome.scanning ? " · scanning now" : ""}`
            : (navidrome.error ?? "not configured")
        }
      >
        <Button
          size="xs"
          variant="outline"
          disabled={busy !== null || !navidrome.configured}
          onClick={() => {
            act("rescan", async () => {
              const result = await runNavidromeRescan({ data: { full: false } });
              return result.started ? "Rescan requested." : (result.error ?? "Rescan refused.");
            });
          }}
          data-testid="navidrome-rescan"
        >
          Rescan
        </Button>
      </Diag>

      <Diag
        testId="diag-readback"
        name="Navidrome read-back"
        tone={verified.withMismatch > 0 ? "warn" : verified.albums === 0 ? "muted" : "ok"}
        detail={
          verified.albums === 0
            ? "No album has been read back yet."
            : `${String(verified.albums)} album(s) compared${verified.lastAt === null ? "" : `, last ${timeAgo(verified.lastAt, now)}`} · ${String(verified.withMismatch)} with a mismatch`
        }
      >
        <Button
          size="xs"
          disabled={busy !== null || !navidrome.configured}
          onClick={() => {
            act("verify", async () => {
              const report = await verifyAll({ data: {} });
              return `Read back ${String(report.verified)} album(s): ${String(report.clean)} clean, ${String(report.withMismatch)} with a mismatch, ${String(report.notFound)} not indexed.`;
            });
          }}
          data-testid="verify-library"
        >
          <ShieldCheck className="size-3.5" aria-hidden="true" /> Verify library
        </Button>
      </Diag>

      <Diag
        testId="diag-schema"
        name={`Tag schema v${String(tagSchema.version)}`}
        tone={tagSchema.behind === null ? "muted" : tagSchema.behind > 0 ? "warn" : "ok"}
        detail={
          tagSchema.behind === null
            ? "— files behind · the re-tag queue reports the count on the Quality page"
            : `${String(tagSchema.behind)} file(s) behind · re-tag runs from the raw cache, with no re-download`
        }
      >
        <Button
          size="xs"
          variant="outline"
          nativeButton={false}
          render={<Link to="/library/quality" />}
        >
          Quality
        </Button>
      </Diag>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* service latencies                                                   */
/* ------------------------------------------------------------------ */

function ServicesPanel({
  services,
  onRefresh,
  busy,
}: {
  readonly services: ToolsPayload["services"];
  readonly onRefresh: () => void;
  readonly busy: boolean;
}) {
  return (
    <Panel
      title="Services"
      testId="tools-services"
      actions={
        <Button size="xs" variant="outline" disabled={busy} onClick={onRefresh}>
          <RefreshCw className="size-3.5" aria-hidden="true" /> {busy ? "Pinging…" : "Ping"}
        </Button>
      }
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 px-3.5 py-3 text-xs sm:grid-cols-3">
        {services.map((service) => (
          <div
            key={service.name}
            className="flex items-center gap-2"
            data-testid={`svc-${service.name}`}
          >
            <span
              className={`size-1.5 shrink-0 rounded-full ${service.ok ? "bg-ok" : service.enabled ? "bg-danger" : "bg-fg-3"}`}
              aria-hidden="true"
            />
            <span className="truncate">{service.label}</span>
            <span className="ml-auto font-mono text-2xs text-fg-2">
              {service.enabled ? (service.ok ? `${String(service.latencyMs)} ms` : "—") : "off"}
            </span>
          </div>
        ))}
      </div>
      <p className="border-t border-line px-3.5 py-2 text-2xs text-fg-3">
        The cheapest call each service answers, so this page never spends anybody&apos;s rate limit.
        A key that is not set shows as a client error, not as an outage.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* test a URL                                                          */
/* ------------------------------------------------------------------ */

function UrlTestPanel({
  value,
  onChange,
  onRun,
  result,
  busy,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onRun: () => void;
  readonly result: UrlTest | null;
  readonly busy: boolean;
}) {
  return (
    <Panel title="Test a URL" testId="tools-url">
      <div className="flex flex-col gap-2 p-3.5">
        <div className="flex gap-2">
          <Input
            className="flex-1 font-mono text-xs"
            placeholder="https://www.youtube.com/watch?v=…"
            value={value}
            data-testid="url-input"
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && value.trim() !== "") onRun();
            }}
          />
          <Button disabled={busy || value.trim() === ""} onClick={onRun} data-testid="url-extract">
            <Play className="size-4" aria-hidden="true" /> {busy ? "Extracting…" : "Extract"}
          </Button>
        </div>
        <p className="text-2xs text-fg-3">
          Runs the toolbox&apos;s <code className="font-mono">/extract</code> without downloading
          anything. Shows what the URL resolves to, or the decoded reason it did not.
        </p>
        {result === null ? null : result.ok ? (
          <Callout tone="ok" data-testid="url-result">
            <div>
              <b>{result.kind}</b> · {result.entries} entr{result.entries === 1 ? "y" : "ies"} ·{" "}
              {result.durationMs} ms
              {result.title === "" ? null : <> · {result.title}</>}
              <ul className="mt-1 list-disc pl-4 font-mono text-2xs">
                {result.sample.map((entry) => (
                  <li key={entry.title}>{entry.title}</li>
                ))}
              </ul>
            </div>
          </Callout>
        ) : (
          <Callout tone="danger" data-testid="url-result">
            <div>
              <b className="font-mono">{result.error?.code}</b> — {result.error?.message}
              {result.error?.hint === "" ? null : (
                <div className="mt-0.5 text-fg-2">{result.error?.hint}</div>
              )}
            </div>
          </Callout>
        )}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* error decoder                                                       */
/* ------------------------------------------------------------------ */

function ErrorDecoder({
  entries,
  problem,
}: {
  readonly entries: readonly ErrorCatalogEntry[];
  readonly problem: string | null;
}) {
  const columns: Column<ErrorCatalogEntry>[] = [
    {
      key: "code",
      header: "Code",
      className: "font-mono text-2xs",
      cell: (row) => row.code,
    },
    {
      key: "matches",
      header: "Matches",
      // `break-words` and a width, not `truncate`: a pattern is what you would grep a log for,
      // so it has to be readable in full even when it wraps onto three lines.
      className: "w-64 max-w-64 font-mono text-2xs break-words whitespace-normal text-fg-2",
      cell: (row) => ((row.patterns ?? []).length === 0 ? "—" : (row.patterns ?? []).join(" · ")),
    },
    { key: "cause", header: "Cause", cell: (row) => row.hint },
    {
      key: "action",
      header: "Fix",
      className: "w-40",
      cell: (row) => (row.action === "" ? <span className="text-fg-3">—</span> : row.action),
    },
  ];

  return (
    <Panel title="Error decoder" testId="tools-errors">
      {problem === null ? null : (
        <div className="p-3">
          <Callout tone="warn">
            <div>The toolbox did not hand over its taxonomy: {problem}</div>
          </Callout>
        </div>
      )}
      <DataTable
        data-testid="errors-table"
        columns={columns}
        rows={entries}
        rowKey={(row) => row.code}
        empty="The catalogue is empty."
      />
      <p className="border-t border-line px-3.5 py-2 text-2xs text-fg-3">
        Served by the toolbox&apos;s <code className="font-mono">GET /errors</code>, so this table
        and the codes the pipeline raises can never drift apart.
      </p>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* the library scan                                                    */
/* ------------------------------------------------------------------ */

function ScanPanel({
  data,
  busy,
  act,
}: {
  readonly data: ToolsPayload;
  readonly busy: string | null;
  readonly act: (key: string, run: () => Promise<string>) => void;
}) {
  const report = data.scan.report;
  const now = new Date();

  const orphanColumns: Column<OrphanFile>[] = [
    { key: "path", header: "Path", className: "font-mono text-2xs", cell: (row) => row.path },
    { key: "size", header: "Size", numeric: true, cell: (row) => bytes(row.size) },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (row) => (
        <div className="flex justify-end gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              act("identify", async () => {
                const result = await identifyFile({ data: { path: row.path } });
                const best = result.candidates[0];
                return best === undefined
                  ? "Fingerprinted, but AcoustID knows nothing about it."
                  : `Best match: ${best.title} — ${best.artist} (${(best.score * 100).toFixed(0)}%).`;
              });
            }}
          >
            Identify
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            onClick={() => {
              act("trash", async () => {
                const result = await trashFileAction({ data: { path: row.path } });
                return `Moved to ${result.to}.`;
              });
            }}
          >
            <Trash2 className="size-3.5" aria-hidden="true" /> Trash
          </Button>
        </div>
      ),
    },
  ];

  const missingColumns: Column<MissingFile>[] = [
    {
      key: "track",
      header: "Track",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate">{row.title}</div>
          <div className="truncate font-mono text-2xs text-fg-3">{row.path}</div>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (row) => (
        <div className="flex justify-end">
          <Button
            size="xs"
            disabled={busy !== null || row.importTrackId === null}
            onClick={() => {
              act("redownload", async () => {
                const result = await redownloadMissing({ data: { trackId: row.trackId } });
                return result.queued
                  ? "Re-download queued; the mapping is kept."
                  : "That track has no import to re-download from.";
              });
            }}
          >
            <Download className="size-3.5" aria-hidden="true" /> Re-download
          </Button>
        </div>
      ),
    },
  ];

  const driftColumns: Column<DriftedTrack>[] = [
    {
      key: "track",
      header: "Track",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate">{row.title}</div>
          <div className="truncate text-2xs text-fg-3">
            {row.fields
              .map((entry) => `${entry.field}: db ${entry.db} / file ${entry.file}`)
              .join(" · ")}
          </div>
        </div>
      ),
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (row) => (
        <div className="flex justify-end">
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              act("fix", async () => {
                await fixDrift({ data: { trackIds: [row.trackId] } });
                return "Queued for a re-tag; the file is rewritten from the document.";
              });
            }}
          >
            <Wrench className="size-3.5" aria-hidden="true" /> Fix
          </Button>
        </div>
      ),
    },
  ];

  const duplicateColumns: Column<DuplicateGroup>[] = [
    {
      key: "recording",
      header: "Recording",
      cell: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.title}</div>
          <div className="truncate font-mono text-2xs text-fg-3">
            {row.files.map((file) => file.path).join(" · ")}
          </div>
        </div>
      ),
    },
    {
      key: "count",
      header: "Copies",
      numeric: true,
      cell: (row) => row.files.length,
    },
  ];

  return (
    <Panel
      title="Library scan"
      testId="tools-scan"
      actions={
        <>
          <span className="self-center text-2xs text-fg-3">
            {data.scan.at === null
              ? "never run"
              : `last ${timeAgo(data.scan.at, now)}${data.scan.durationMs === null ? "" : ` · ${(data.scan.durationMs / 1000).toFixed(1)}s`}`}
          </span>
          <Button
            size="xs"
            disabled={busy !== null}
            onClick={() => {
              act("scan", async () => {
                await startScan({ data: {} });
                return "Scan queued. The worker walks the library and reports here.";
              });
            }}
            data-testid="scan-now"
          >
            <Scan className="size-3.5" aria-hidden="true" /> Scan now
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 p-3.5 sm:grid-cols-4">
        <StatTile label="Files" value={report?.filesSeen ?? data.library.tracks} />
        <StatTile
          label="Orphans"
          value={report?.orphans.length ?? 0}
          tone={(report?.orphans.length ?? 0) > 0 ? "warn" : "muted"}
        />
        <StatTile
          label="Missing"
          value={report?.missing.length ?? 0}
          tone={(report?.missing.length ?? 0) > 0 ? "danger" : "muted"}
        />
        <StatTile
          label="Tag drift"
          value={report?.drift.length ?? 0}
          tone={(report?.drift.length ?? 0) > 0 ? "warn" : "muted"}
        />
      </div>

      {report === null ? (
        <div className="p-3.5 pt-0">
          <Callout tone="info" data-testid="scan-empty">
            <div>
              The library has never been scanned. A scan walks the tree, compares it with the
              database and reports what does not line up. Nothing is deleted: a file you remove here
              is moved to the trash directory.
            </div>
          </Callout>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5 p-3.5 pt-0">
          {report.notes.length === 0 ? null : (
            <Callout tone="warn" data-testid="scan-notes">
              <div>
                {report.notes.map((note) => (
                  <div key={note}>{note}</div>
                ))}
              </div>
            </Callout>
          )}
          <ScanSection title="Orphan files (not in the database)" count={report.orphans.length}>
            <DataTable
              data-testid="scan-orphans"
              columns={orphanColumns}
              rows={report.orphans.slice(0, 25)}
              rowKey={(row) => row.path}
              empty="None — every file on disk has a row."
            />
          </ScanSection>
          <ScanSection
            title="Missing files (in the database, not on disk)"
            count={report.missing.length}
          >
            <DataTable
              data-testid="scan-missing"
              columns={missingColumns}
              rows={report.missing.slice(0, 25)}
              rowKey={(row) => row.trackId}
              empty="None — every row points at a file."
            />
          </ScanSection>
          <ScanSection title="Tag drift" count={report.drift.length}>
            <DataTable
              data-testid="scan-drift"
              columns={driftColumns}
              rows={report.drift.slice(0, 25)}
              rowKey={(row) => row.trackId}
              empty={`None — ${String(report.probed)} file(s) probed and every tag matched its document.`}
            />
          </ScanSection>
          <ScanSection title="Duplicates (same recording)" count={report.duplicates.length}>
            <DataTable
              data-testid="scan-duplicates"
              columns={duplicateColumns}
              rows={report.duplicates.slice(0, 25)}
              rowKey={(row) => row.recordingMbid}
              empty="None — no recording appears twice."
            />
          </ScanSection>
        </div>
      )}
    </Panel>
  );
}

function ScanSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="mb-1.5 flex items-center gap-2 text-2xs tracking-wider text-fg-2 uppercase">
        {title}
        <ToneBadge tone={count > 0 ? "warn" : "muted"} outline>
          {count}
        </ToneBadge>
      </h3>
      <div className="overflow-hidden rounded-lg border border-line">{children}</div>
    </div>
  );
}
