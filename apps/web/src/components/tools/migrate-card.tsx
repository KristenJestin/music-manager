/**
 * Tools › Migrate from v1 (P11 § Interface).
 *
 * One card, four states, in the order somebody actually uses them:
 *
 *  1. **the form** — where v1's database is, where its library is;
 *  2. **the preview** — a dry run, which reads everything and writes nothing, so you find out
 *     what the migration thinks *before* it touches a file;
 *  3. **the run** — behind an explicit backup confirmation, following the worker live;
 *  4. **the report** — the counters, the discrepancies and the errors of the last run.
 *
 * The connection string is a password field and is never read back: what the card shows after
 * a run is the redacted `dbLabel` the server stored, because a secret round-tripped through a
 * form value ends up in a screenshot eventually.
 *
 * Its own component rather than another panel inside `routes/_app.tools.tsx`: that route is a
 * page several phases extend at once, and this card is one additive line in it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { AlertTriangle, Database, Eye, Play } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useMigrationProgress } from "#/hooks/use-migration-progress.ts";
import { timeAgo } from "#/lib/format.ts";
import {
  confirmMigrationBackup,
  fetchMigration,
  startMigration,
  type MigrationPayload,
  type MigrationRunView,
} from "#/server/functions/migrate.ts";

/**
 * The card loads its own payload rather than taking it from the route.
 *
 * That is what makes mounting it a genuinely additive one-liner in
 * `routes/_app.tools.tsx` — no new field in `fetchTools`, no second phase editing the same
 * loader. The cost is a first paint without it, which for a diagnostics panel on a page that
 * already refuses to cache anything is the right trade.
 */
export function MigrateCard() {
  const router = useRouter();
  const toast = useToast();
  const [data, setData] = useState<MigrationPayload | null>(null);
  const [following, setFollowing] = useState(false);

  /**
   * The instant a run was queued from this card, or `null`.
   *
   * It is what tells a poll apart from a stale answer: "no run is going" is true both before
   * the worker has picked the job up and after it has finished, and stopping on the first of
   * those would leave the card waiting for ever on a result it had asked not to hear about.
   * A run whose row is newer than this moment is *our* run, and only that one ends the wait.
   */
  const queuedAt = useRef<number | null>(null);

  const reload = useCallback(() => {
    void fetchMigration().then(
      (next) => {
        setData(next);
        const newest = next.runs[0];
        const ours =
          queuedAt.current !== null &&
          newest !== undefined &&
          Date.parse(newest.createdAt) >= queuedAt.current - 2000;
        if (!next.running && ours) {
          queuedAt.current = null;
          setFollowing(false);
        }
      },
      () => {
        /* the rest of the page must not fail because this one card cannot load */
      },
    );
  }, []);
  useEffect(reload, [reload]);

  const acknowledged = data?.backupAcknowledgedAt ?? null;

  const [dbUrl, setDbUrl] = useState("");
  const [libraryPath, setLibraryPath] = useState("");
  const [renameToTemplate, setRenameToTemplate] = useState(false);
  const [hasBackup, setHasBackup] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const lines = useMigrationProgress({
    active: following || (data?.running ?? false),
    onFinished: () => {
      setFollowing(false);
      reload();
      void router.invalidate();
    },
  });

  /*
   * Both defaults are *derived*, not copied into state by an effect.
   *
   * The payload arrives after the first paint, and the obvious way to seed the two controls
   * from it is a `useEffect` that calls `setState`. That is a cascading render, and it is also
   * wrong the moment somebody has already typed: the effect would have to guess whether the
   * empty string means “untouched” or “deliberately cleared”. Reading through instead keeps
   * one source of truth per control — what the user typed, falling back to what the server
   * knows — and needs no effect at all.
   */
  const libraryRoot = data?.libraryRoot ?? "";
  const library = libraryPath === "" ? libraryRoot : libraryPath;
  const backupConfirmed = hasBackup || acknowledged !== null;

  const last = data?.runs[0] ?? null;

  /*
   * Poll while a run is in flight, as well as listening.
   *
   * The SSE stream is the fast path and is what makes progress feel live, but it is opened
   * *after* the job is queued: a run that fails in its first second — a v1 database that is
   * not there, the commonest first attempt — can be over before the listener attaches, and
   * the card would then wait for an event that has already been and gone. A slow poll costs
   * one query every two seconds, only while something is running, and it cannot miss.
   */
  useEffect(() => {
    if (!following && !(data?.running ?? false)) return;
    const timer = setInterval(reload, 2000);
    return () => {
      clearInterval(timer);
    };
  }, [following, data?.running, reload]);

  const ready = dbUrl.trim() !== "" && library.trim() !== "";

  const start = (dryRun: boolean): void => {
    setBusy(dryRun ? "preview" : "run");
    queuedAt.current = Date.now();
    const go = async (): Promise<void> => {
      if (!dryRun && acknowledged === null) await confirmMigrationBackup();
      await startMigration({
        data: {
          dbUrl: dbUrl.trim(),
          libraryPath: library.trim(),
          dryRun,
          renameToTemplate,
          resume: false,
          verify: false,
        },
      });
    };
    void go().then(
      () => {
        setBusy(null);
        setFollowing(true);
        toast(dryRun ? "Preview queued." : "Migration queued.", "ok");
        reload();
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  return (
    <section
      data-testid="tools-migrate"
      className="overflow-hidden rounded-xl border border-line bg-surface-1"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
        <h2 className="flex items-center gap-2 text-xs font-medium tracking-wide">
          <Database className="size-3.5 text-fg-2" aria-hidden="true" />
          Migrate from v1
        </h2>
        {last === null ? null : (
          <ToneBadge tone={last.failed > 0 ? "warn" : last.status === "failed" ? "danger" : "ok"}>
            {last.dryRun ? "preview" : "run"} {last.status}
          </ToneBadge>
        )}
      </header>

      <div className="flex flex-col gap-3 p-3.5">
        <p className="text-2xs text-fg-2">
          Take over the library and database of Music Manager v1. Files keep their v1 paths, so
          Navidrome keeps its play counts; nothing is downloaded.
        </p>

        {/* ---- the form ---- */}
        <label className="flex flex-col gap-1">
          <span className="text-2xs text-fg-2">v1 database</span>
          <Input
            type="password"
            data-testid="migrate-db"
            placeholder="postgres://user:password@host:5432/musicmanager"
            autoComplete="off"
            value={dbUrl}
            onChange={(event) => {
              setDbUrl(event.target.value);
            }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-2xs text-fg-2">v1 library</span>
          <Input
            data-testid="migrate-library"
            placeholder={libraryRoot}
            value={library}
            onChange={(event) => {
              setLibraryPath(event.target.value);
            }}
          />
          <span className="text-2xs text-fg-3">
            Must be the v2 library root, or a directory inside it — the migration keeps the v1
            paths, so the two are the same folder.
          </span>
        </label>

        <label className="flex items-start gap-2 text-2xs text-fg-2">
          <input
            type="checkbox"
            data-testid="migrate-rename"
            checked={renameToTemplate}
            onChange={(event) => {
              setRenameToTemplate(event.target.checked);
            }}
          />
          <span>
            Rename files to the v2 template.{" "}
            <span className="text-warn">
              Navidrome identifies files by path: renaming loses play counts and favourites.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-2xs text-fg-2">
          <input
            type="checkbox"
            data-testid="migrate-backup"
            checked={backupConfirmed}
            onChange={(event) => {
              setHasBackup(event.target.checked);
            }}
          />
          <span>
            I have a backup of the library and of the v1 database.
            {acknowledged === null ? null : (
              <span className="text-fg-3"> Confirmed {timeAgo(acknowledged)}.</span>
            )}
          </span>
        </label>

        <div className="flex flex-wrap gap-1.5">
          <Button
            variant="outline"
            size="sm"
            data-testid="migrate-preview"
            disabled={!ready || busy !== null || (data?.running ?? false)}
            onClick={() => {
              start(true);
            }}
          >
            <Eye className="size-4" aria-hidden="true" />
            {busy === "preview" ? "Queueing…" : "Preview (dry run)"}
          </Button>
          <Button
            size="sm"
            data-testid="migrate-run"
            disabled={!ready || !backupConfirmed || busy !== null || (data?.running ?? false)}
            onClick={() => {
              start(false);
            }}
          >
            <Play className="size-4" aria-hidden="true" />
            {busy === "run" ? "Queueing…" : "Migrate"}
          </Button>
        </div>

        {renameToTemplate ? (
          <Callout tone="warn" icon={<AlertTriangle className="size-4" aria-hidden="true" />}>
            Renaming is irreversible for Navidrome&rsquo;s statistics. Replay the migration on a
            copy of the library first.
          </Callout>
        ) : null}

        {/* ---- the live journal ---- */}
        {lines.length === 0 ? null : (
          <div
            data-testid="migrate-progress"
            className="max-h-40 overflow-auto rounded-lg border border-line bg-surface-2 p-2 font-mono text-2xs text-fg-2"
          >
            {lines.map((line) => (
              <div key={line.id} className={line.level === "error" ? "text-danger" : undefined}>
                {line.message}
              </div>
            ))}
          </div>
        )}

        {last === null ? (
          <p className="text-2xs text-fg-3">No migration has been run yet.</p>
        ) : (
          <MigrationSummary run={last} />
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* the report of the last run                                          */
/* ------------------------------------------------------------------ */

function MigrationSummary({ run }: { readonly run: MigrationRunView }) {
  const report = run.report;
  return (
    <div data-testid="migrate-report" className="flex flex-col gap-2 border-t border-line pt-3">
      <div className="flex flex-wrap items-baseline gap-2 text-2xs">
        <span className="font-medium">{run.dryRun ? "Last preview" : "Last migration"}</span>
        <span className="text-fg-3">{timeAgo(run.createdAt)}</span>
        <span className="text-fg-3">{run.database}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-2xs sm:grid-cols-4">
        <Stat label="tracks" value={report?.counts.migrated ?? run.migrated} />
        <Stat label="imports" value={report?.counts.importsCreated ?? run.importsCreated} />
        <Stat label="orphan files" value={report?.counts.orphanFiles ?? run.orphanFiles} />
        <Stat label="failures" value={report?.counts.failed ?? run.failed} tone="danger" />
      </dl>

      {run.dryRun ? (
        <p className="text-2xs text-fg-3" data-testid="migrate-writes">
          Dry run: {run.writes} row(s) written outside the migration&rsquo;s own tables — it must be
          0.
        </p>
      ) : null}

      {report === null ? null : (
        <>
          {report.albums.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5 text-2xs text-fg-2">
              {report.albums.map((album) => (
                <li key={`${album.folder}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    {album.artist} — {album.title}
                  </span>
                  <span className="shrink-0 text-fg-3">
                    {album.tracks} tr
                    {album.completeness === null
                      ? ""
                      : ` · ${String(Math.round(album.completeness * 100))}%`}
                    {album.replaygain ? " · rg" : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {report.discrepancies.length === 0 ? null : (
            <details data-testid="migrate-discrepancies" className="text-2xs text-fg-2">
              <summary className="cursor-pointer">
                {report.discrepancies.length} discrepancy(ies)
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5">
                {report.discrepancies.slice(0, 20).map((item, index) => (
                  <li key={`${item.kind}-${String(index)}`}>
                    <span className="text-fg-3">{item.kind}</span> {item.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: "danger";
}) {
  return (
    <div>
      <dt className="text-fg-3">{label}</dt>
      <dd className={tone === "danger" && value > 0 ? "text-danger" : undefined}>{value}</dd>
    </div>
  );
}
