/**
 * Settings → API & agents (`prototypes/A-console` page `/settings/api`).
 *
 * Four blocks, in the prototype's order: the explanation, the tokens, the MCP endpoint with a
 * CLI example, and the webhooks. Unlike the other Settings tabs this one has **no Save
 * button**, and that is not an omission: nothing here is a preference. A key is minted or
 * revoked, a webhook is created or deleted — each is an act with an immediate effect, and a
 * form that batched them behind Save would let you tick "revoke" and then walk away without
 * having revoked anything.
 *
 * The one piece of real interaction design is the **secret panel**. A key's plaintext exists
 * for the length of one response and is then unrecoverable, so it is shown in a panel that
 * says so, with a copy button, and it stays until dismissed rather than disappearing on the
 * next re-render.
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Bot, Check, Copy, Plus, Send, Trash2 } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { ChipMulti, FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import type { ApiKeyView, WebhookView } from "@mm/contracts";
import {
  createKey,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  fetchApiSettings,
  revokeKey,
  testWebhookEndpoint,
  toggleWebhookEndpoint,
} from "#/server/functions/settings-api.ts";

export const Route = createFileRoute("/_app/settings/api")({
  loader: async () => await fetchApiSettings(),
  staticData: { crumbs: [{ label: "API & agents" }] },
  component: ApiSettings,
});

/** "3 days ago", or "never". A timestamp column that reads as prose. */
function ago(iso: string | null): string {
  if (iso === null) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return `${String(Math.round(hours / 24))}d ago`;
}

function ApiSettings() {
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  /** The one secret currently on screen, if any. `null` the rest of the time. */
  const [revealed, setRevealed] = useState<{ label: string; secret: string; what: string } | null>(
    null,
  );

  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(["imports:write", "library:read"]);
  const [keyExpiry, setKeyExpiry] = useState("");

  const [hookUrl, setHookUrl] = useState("");
  const [hookEvents, setHookEvents] = useState<string[]>([]);

  const run = (id: string, task: () => Promise<string>): void => {
    setBusy(id);
    void task().then(
      (message) => {
        setBusy(null);
        toast(message, "ok");
        void router.invalidate();
      },
      (error: unknown) => {
        setBusy(null);
        toast(error instanceof Error ? error.message : String(error), "danger");
      },
    );
  };

  const copy = (value: string, what: string): void => {
    void navigator.clipboard.writeText(value).then(
      () => {
        toast(`${what} copied.`, "ok");
      },
      () => {
        toast("Could not reach the clipboard.", "warn");
      },
    );
  };

  const keyColumns: Column<ApiKeyView>[] = [
    {
      key: "name",
      header: "Name",
      cell: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "token",
      header: "Token",
      cell: (row) => <code className="font-mono text-2xs text-fg-3">{row.start ?? "mm_…"}…</code>,
    },
    {
      key: "scopes",
      header: "Scopes",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.scopes.map((scope) => (
            <ToneBadge key={scope} tone={scope === "*" ? "warn" : "muted"} outline>
              <span className="font-mono">{scope}</span>
            </ToneBadge>
          ))}
        </span>
      ),
    },
    {
      key: "used",
      header: "Last used",
      cell: (row) => (
        <span className="text-fg-3" title={row.lastRequest ?? "never"}>
          {ago(row.lastRequest)}
          {row.requestCount > 0 ? ` · ${String(row.requestCount)}` : ""}
        </span>
      ),
    },
    {
      key: "expires",
      header: "Expires",
      cell: (row) =>
        row.expiresAt === null ? (
          <span className="text-fg-3">never</span>
        ) : (
          <span title={row.expiresAt}>{new Date(row.expiresAt).toISOString().slice(0, 10)}</span>
        ),
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          className="text-danger"
          disabled={busy !== null}
          data-testid={`revoke-key-${row.id}`}
          onClick={() => {
            run(row.id, async () => {
              await revokeKey({ data: { id: row.id } });
              return `Revoked “${row.name}”.`;
            });
          }}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Revoke
        </Button>
      ),
    },
  ];

  const hookColumns: Column<WebhookView>[] = [
    {
      key: "url",
      header: "URL",
      cell: (row) => (
        <span className="flex min-w-0 flex-col">
          <code className="truncate font-mono text-2xs">{row.url}</code>
          {row.lastError === null ? null : (
            <span className="truncate text-2xs text-danger">{row.lastError}</span>
          )}
        </span>
      ),
    },
    {
      key: "events",
      header: "Events",
      cell: (row) => (
        <span className="flex flex-wrap gap-1">
          {row.events.length === 0 ? (
            <ToneBadge tone="info" outline>
              <span className="font-mono">all</span>
            </ToneBadge>
          ) : (
            row.events.map((event) => (
              <ToneBadge key={event} tone="muted" outline>
                <span className="font-mono">{event}</span>
              </ToneBadge>
            ))
          )}
        </span>
      ),
    },
    {
      key: "last",
      header: "Last delivery",
      cell: (row) =>
        row.lastDeliveryAt === null ? (
          <span className="text-fg-3">never</span>
        ) : (
          <span className="flex items-center gap-1.5">
            <ToneBadge tone={row.lastStatus !== null && row.lastStatus < 400 ? "ok" : "danger"}>
              {row.lastStatus ?? "error"}
            </ToneBadge>
            <span className="text-fg-3">{ago(row.lastDeliveryAt)}</span>
          </span>
        ),
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (row) => (
        <Toggle
          checked={row.enabled}
          onChange={(next) => {
            run(row.id, async () => {
              await toggleWebhookEndpoint({ data: { id: row.id, enabled: next } });
              return next ? "Enabled." : "Disabled.";
            });
          }}
          testId={`toggle-webhook-${row.id}`}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      actions: true,
      cell: (row) => (
        <span className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            data-testid={`test-webhook-${row.id}`}
            onClick={() => {
              run(row.id, async () => {
                const outcome = await testWebhookEndpoint({ data: { id: row.id } });
                if (!outcome.ok) {
                  throw new Error(outcome.error ?? "The endpoint refused the delivery.");
                }
                return `Test event delivered (${String(outcome.status ?? 200)}).`;
              });
            }}
          >
            <Send className="size-3.5" aria-hidden="true" />
            Test
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            disabled={busy !== null}
            onClick={() => {
              run(row.id, async () => {
                await deleteWebhookEndpoint({ data: { id: row.id } });
                return "Webhook deleted.";
              });
            }}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div className="grid gap-3.5" data-testid="settings-api">
      <Callout tone="info" icon={<Bot className="size-4" aria-hidden="true" />}>
        <span>
          <strong>Everything in the UI is an API call.</strong> OpenAPI at{" "}
          <a className="underline" href="/api/openapi.json">
            /api/openapi.json
          </a>{" "}
          with a browsable reference at{" "}
          <a className="underline" href="/api/docs">
            /api/docs
          </a>
          , an MCP server for agents at <code className="font-mono">/mcp</code>, and a CLI (&nbsp;
          <code className="font-mono">mm import &lt;url&gt; --release &lt;mbid&gt;</code>
          &nbsp;). Agents can queue imports, read candidates and resolve reviews, with the same
          preselection you see.
        </span>
      </Callout>

      {revealed === null ? null : (
        <Callout tone="warn" data-testid="revealed-secret">
          <span className="flex min-w-0 flex-col gap-1.5">
            <strong>
              Copy this {revealed.what} now: it is not stored and will never be shown again.
            </strong>
            <span className="flex items-center gap-2">
              <code
                className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface-2 px-2 py-1 font-mono text-2xs"
                data-testid="secret-value"
              >
                {revealed.secret}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  copy(revealed.secret, revealed.what);
                }}
              >
                <Copy className="size-3.5" aria-hidden="true" />
                Copy
              </Button>
              <Button
                variant="ghost"
                size="sm"
                data-testid="dismiss-secret"
                onClick={() => {
                  setRevealed(null);
                }}
              >
                <Check className="size-3.5" aria-hidden="true" />
                Done
              </Button>
            </span>
            <span className="text-2xs">for “{revealed.label}”</span>
          </span>
        </Callout>
      )}

      <Section
        title="API tokens"
        description="A token is equivalent to your session for the scopes you grant it. Send it as `x-api-key` or `Authorization: Bearer`."
      >
        <div className="py-2">
          <DataTable
            columns={keyColumns}
            rows={loaded.keys}
            rowKey={(row) => row.id}
            empty="No tokens yet. Create one below to let an agent or a script drive this app."
            data-testid="keys-table"
          />
        </div>
        <FormRow label="New token" help="Name it after whatever will hold it.">
          <Input
            className="w-56 text-xs"
            placeholder="claude-desktop"
            value={keyName}
            data-testid="key-name"
            onChange={(event) => {
              setKeyName(event.target.value);
            }}
          />
          <Input
            className="w-40 text-xs"
            type="number"
            placeholder="expires in days"
            value={keyExpiry}
            data-testid="key-expiry"
            onChange={(event) => {
              setKeyExpiry(event.target.value);
            }}
          />
          <Button
            disabled={busy !== null || keyName.trim() === "" || keyScopes.length === 0}
            data-testid="create-key"
            onClick={() => {
              run("create-key", async () => {
                const days = Number.parseInt(keyExpiry, 10);
                const created = await createKey({
                  data: {
                    name: keyName.trim(),
                    scopes: keyScopes,
                    expiresInDays: Number.isNaN(days) ? null : days,
                  },
                });
                setRevealed({
                  label: created.key.name,
                  secret: created.secret,
                  what: "API key",
                });
                setKeyName("");
                setKeyExpiry("");
                return `Created “${created.key.name}”.`;
              });
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Create
          </Button>
        </FormRow>
        <FormRow label="Scopes" help="`*` grants everything. A write scope implies its read.">
          <ChipMulti
            values={keyScopes}
            options={loaded.scopes.map((entry) => ({
              value: entry.scope,
              label: entry.scope,
            }))}
            onChange={setKeyScopes}
            testId="key-scopes"
          />
        </FormRow>
      </Section>

      <Section
        title="MCP server"
        description="Model Context Protocol over Streamable HTTP. Authenticate with an API token as a bearer."
      >
        <FormRow
          label="Endpoint"
          help="Tools: list_imports, get_import, create_import, get_candidates, confirm_mapping, list_inbox, resolve_inbox, search_library, get_album, retag, verify, get_settings, update_settings, ytdlp_update. Resources: mm://docs/*, mm://tagmap."
        >
          <Input
            readOnly
            className="w-full max-w-form font-mono text-xs"
            value={loaded.endpoints.mcp}
            data-testid="mcp-endpoint"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              copy(loaded.endpoints.mcp, "Endpoint");
            }}
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </Button>
        </FormRow>
        <FormRow label="Example" help="A token with the right scopes is all an agent needs.">
          <pre className="w-full max-w-full overflow-x-auto rounded-md border border-line bg-surface-2 px-3 py-2 font-mono text-2xs text-fg-2">
            {`$ mm --url ${loaded.endpoints.base.replace(/\/api\/v1$/, "")} --token mm_… \\
    import "https://music.youtube.com/playlist?list=OLAK5uy_…" --yes --follow

$ bunx @modelcontextprotocol/inspector --cli ${loaded.endpoints.mcp} \\
    --header "Authorization: Bearer mm_…" --method tools/list`}
          </pre>
        </FormRow>
      </Section>

      <Section
        title="Webhooks"
        description={
          "A signed POST per event. `x-mm-signature: t=<unix>,v1=<hex hmac-sha256>` computed " +
          "over the timestamp and the body together, retried with backoff."
        }
      >
        <div className="py-2">
          <DataTable
            columns={hookColumns}
            rows={loaded.webhooks}
            rowKey={(row) => row.id}
            empty="No webhooks. Add one to be told when an import finishes or needs you."
            data-testid="webhooks-table"
          />
        </div>
        <FormRow label="New webhook" help="Where to POST. http:// or https://.">
          <Input
            className="w-full max-w-form font-mono text-xs"
            placeholder="https://example.test/hooks/mm"
            value={hookUrl}
            data-testid="webhook-url"
            onChange={(event) => {
              setHookUrl(event.target.value);
            }}
          />
          <Button
            disabled={busy !== null || hookUrl.trim() === ""}
            data-testid="create-webhook"
            onClick={() => {
              run("create-webhook", async () => {
                const created = await createWebhookEndpoint({
                  data: {
                    name: hookUrl.trim(),
                    url: hookUrl.trim(),
                    events: hookEvents as never,
                  },
                });
                setRevealed({
                  label: created.webhook.url,
                  secret: created.secret,
                  what: "signing secret",
                });
                setHookUrl("");
                return "Webhook created.";
              });
            }}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add
          </Button>
        </FormRow>
        <FormRow label="Events" help="None selected means every event.">
          <ChipMulti
            values={hookEvents}
            options={loaded.events.map((event) => ({ value: event, label: event }))}
            onChange={setHookEvents}
            testId="webhook-events"
          />
        </FormRow>
      </Section>
    </div>
  );
}
