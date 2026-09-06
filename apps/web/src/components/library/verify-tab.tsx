/**
 * The album's "Navidrome" tab: what we wrote, next to what the server gives back.
 *
 * This is the one screen in the app that answers "will Feishin actually show this?", and it
 * answers it with evidence rather than with a claim — three columns, one row per field, and a
 * verdict. `not indexed` is styled as *neutral*, not as a failure, because it means "this
 * Navidrome version has no slot for MOOD", which is a fact about the consumer and not a
 * defect in our tags (`docs/03-metadonnees.md` §7).
 *
 * Exported as a component rather than written into the album route, so the album page (P07a)
 * mounts it with one line and the two phases never touch the same file.
 */
import { useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { ToneBadge, type Tone } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { timeAgo } from "#/lib/format.ts";
import { verifyOne } from "#/server/functions/verify.ts";
import type { AlbumVerifyPayload } from "#/server/functions/verify.ts";
import type { AlbumVerification, VerifyField } from "#/server/services/verify.ts";

const VERDICT: Record<VerifyField["status"], { label: string; tone: Tone }> = {
  ok: { label: "ok", tone: "ok" },
  mismatch: { label: "mismatch", tone: "danger" },
  not_indexed: { label: "not indexed", tone: "muted" },
};

export interface VerifyTabProps {
  readonly payload: AlbumVerifyPayload;
  /** Called after a re-verify so the route can invalidate its loader. */
  readonly onVerified?: (verification: AlbumVerification) => void;
}

export function VerifyTab({ payload, onVerified }: VerifyTabProps) {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [verification, setVerification] = useState<AlbumVerification | null>(payload.verification);
  const now = new Date();

  const reverify = (rescan: boolean): void => {
    setRunning(true);
    void verifyOne({ data: { albumId: payload.albumId, rescan } }).then(
      (result) => {
        setRunning(false);
        setVerification(result);
        onVerified?.(result);
        toast(
          result.note ??
            `${String(result.ok)} ok, ${String(result.mismatches)} mismatch, ${String(result.notIndexed)} not indexed.`,
          result.requiredMismatches.length > 0 ? "warn" : "ok",
        );
      },
      (error: unknown) => {
        setRunning(false);
        toast(error instanceof Error ? error.message : "The read-back did not run.", "danger");
      },
    );
  };

  const columns: Column<VerifyField>[] = [
    {
      key: "field",
      header: "Field",
      className: "font-mono text-2xs",
      cell: (row) => (
        <span className="flex items-center gap-1.5">
          {row.name}
          {row.required ? (
            <span className="text-2xs text-fg-3" title="Required by the tag map">
              R
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "written",
      header: "Written by Music Manager",
      cell: (row) => <span className="line-clamp-2">{row.written}</span>,
    },
    {
      key: "read",
      header: "Read back from Navidrome",
      cell: (row) => (
        <span className={row.status === "mismatch" ? "text-danger" : "text-fg-2"}>{row.read}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      className: "w-28",
      cell: (row) => (
        <ToneBadge tone={VERDICT[row.status].tone}>{VERDICT[row.status].label}</ToneBadge>
      ),
    },
  ];

  const server =
    payload.navidrome.ok && payload.navidrome.server !== ""
      ? `${payload.navidrome.server} ${payload.navidrome.serverVersion}`
      : "Navidrome";

  return (
    <div className="flex flex-col gap-3.5" data-testid="verify-tab">
      <Callout tone={payload.navidrome.ok ? "info" : "warn"} data-testid="verify-server">
        <div>
          <b>{server}</b>
          {payload.navidrome.ok ? (
            <>
              {" "}
              ·{" "}
              {payload.navidrome.songCount === null
                ? "no scan reported"
                : `${String(payload.navidrome.songCount)} songs indexed`}{" "}
              ·{" "}
              {verification === null
                ? "never verified"
                : `last verified ${timeAgo(verification.at, now)}`}
              .
            </>
          ) : (
            <> · {payload.navidrome.error ?? "not reachable"}</>
          )}
          <div className="mt-1 text-fg-2">
            Music Manager reads the album back through the OpenSubsonic API (
            <code className="font-mono">getAlbum</code> + <code className="font-mono">getSong</code>
            ) and compares it field by field with what it wrote. This is what Feishin and Symfonium
            actually see.
          </div>
        </div>
      </Callout>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Written vs indexed</h2>
          {verification === null ? (
            <ToneBadge tone="warn">not verified</ToneBadge>
          ) : verification.mismatches > 0 ? (
            <ToneBadge tone="danger">
              {verification.mismatches} mismatch{verification.mismatches === 1 ? "" : "es"}
            </ToneBadge>
          ) : (
            <ToneBadge tone="ok">{verification.fields.length} fields ok</ToneBadge>
          )}
          {verification !== null && verification.notIndexed > 0 ? (
            <ToneBadge tone="muted" outline>
              {verification.notIndexed} not indexed
            </ToneBadge>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="outline"
            disabled={running}
            onClick={() => {
              reverify(true);
            }}
            data-testid="verify-rescan"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" /> Rescan &amp; verify
          </Button>
          <Button
            size="xs"
            disabled={running}
            onClick={() => {
              reverify(false);
            }}
            data-testid="verify-now"
          >
            <ShieldCheck className="size-3.5" aria-hidden="true" />{" "}
            {running ? "Reading back…" : "Re-verify"}
          </Button>
        </div>
      </div>

      {verification === null ? (
        <Callout tone="warn" data-testid="verify-empty">
          <div>
            This album has never been read back. Trigger a rescan, then verify: a scan that has not
            run since the album was placed is the usual reason a freshly imported album is
            invisible.
          </div>
        </Callout>
      ) : verification.note !== null ? (
        <Callout tone="warn" data-testid="verify-note">
          <div>{verification.note}</div>
        </Callout>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
            <DataTable
              data-testid="verify-table"
              columns={columns}
              rows={verification.fields}
              rowKey={(row) => row.name}
              empty="Nothing was compared."
            />
          </div>
          <p className="text-2xs text-fg-3">
            <b>not indexed</b> is information, not an error: the field was written, and this server
            does not expose it. Only a required field that reads back <b>differently</b> opens an
            Inbox item.
          </p>
        </>
      )}
    </div>
  );
}
