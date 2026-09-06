/**
 * Settings → Integrations: Navidrome, notifications, backup.
 *
 * The Navidrome block is the one that matters, because it is what makes the `verify` step of
 * `docs/03-metadonnees.md` §7 real. "Test" runs against the values *in the form*, not the
 * stored ones, so you find out whether a password works before you commit it.
 *
 * The notifications block is stored and not delivered — P08 owns the transports. That is said
 * on the page rather than implied by a switch that does nothing.
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Download, Plug, Save, Upload } from "lucide-react";
import { NOTIFIABLE_EVENTS } from "@mm/contracts";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { ChipGroup, ChipMulti, FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  exportBackup,
  fetchIntegrationSettings,
  importBackup,
  rescanNavidrome,
  saveIntegrationSettings,
  testNavidrome,
  testNotification,
  type IntegrationsForm,
} from "#/server/functions/settings-integrations.ts";
import type { NavidromeStatus } from "#/server/services/navidrome.ts";

export const Route = createFileRoute("/_app/settings/integrations")({
  loader: async () => await fetchIntegrationSettings(),
  staticData: { crumbs: [{ label: "Integrations" }] },
  component: Integrations,
});

function Integrations() {
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<IntegrationsForm>({
    ...loaded.values,
    // Empty means "unchanged". Never prefilled with anything derived from the real value.
    navidromePassword: "",
    smtpPassword: "",
    notificationsTarget: "",
  });
  const [status, setStatus] = useState<NavidromeStatus>(loaded.navidrome);
  const [busy, setBusy] = useState<string | null>(null);

  const set = <K extends keyof IntegrationsForm>(key: K, value: IntegrationsForm[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const run = (key: string, task: () => Promise<string>): void => {
    setBusy(key);
    void task().then(
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
    <div className="flex flex-col gap-3.5" data-testid="settings-integrations">
      <Section
        title="Navidrome"
        description="The read-back of docs/03 §7: what a server gives back is the only proof a tag arrived."
      >
        <FormRow
          label="Read back after every import"
          help="Off means the verify step only checks the files exist on disk."
        >
          <Toggle
            checked={form.navidromeEnabled}
            onChange={(next) => {
              set("navidromeEnabled", next);
            }}
            label={form.navidromeEnabled ? "on" : "off"}
            testId="toggle-navidrome"
          />
        </FormRow>
        <FormRow label="URL" help="The server root, without `/rest`.">
          <Input
            className="w-full max-w-form font-mono text-xs"
            placeholder="http://localhost:4533"
            value={form.navidromeUrl}
            data-testid="navidrome-url"
            onChange={(event) => {
              set("navidromeUrl", event.target.value);
            }}
          />
        </FormRow>
        <FormRow label="User">
          <Input
            className="w-56 font-mono text-xs"
            value={form.navidromeUser}
            data-testid="navidrome-user"
            onChange={(event) => {
              set("navidromeUser", event.target.value);
            }}
          />
        </FormRow>
        <FormRow
          label="Password"
          help="Sent as the Subsonic token+salt pair, never in clear. Leave empty to keep the stored one."
        >
          <Input
            className="w-56 font-mono text-xs"
            type="password"
            placeholder={loaded.passwordMask === "" ? "not set" : loaded.passwordMask}
            value={form.navidromePassword}
            data-testid="navidrome-password"
            onChange={(event) => {
              set("navidromePassword", event.target.value);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null}
            data-testid="navidrome-test"
            onClick={() => {
              setBusy("test");
              void testNavidrome({
                data: {
                  url: form.navidromeUrl,
                  user: form.navidromeUser,
                  password: form.navidromePassword,
                },
              }).then(
                (result) => {
                  setBusy(null);
                  setStatus(result);
                  toast(
                    result.ok
                      ? `${result.server} ${result.serverVersion} answered in ${String(result.latencyMs)} ms.`
                      : (result.error ?? "No answer."),
                    result.ok ? "ok" : "danger",
                  );
                },
                (error: unknown) => {
                  setBusy(null);
                  toast(error instanceof Error ? error.message : "Test failed.", "danger");
                },
              );
            }}
          >
            <Plug className="size-3.5" aria-hidden="true" /> Test
          </Button>
        </FormRow>
        <FormRow label="Status">
          <span className="flex flex-wrap items-center gap-2 text-2xs">
            {status.ok ? (
              <>
                <ToneBadge tone="ok">connected</ToneBadge>
                <span className="text-fg-2">
                  {status.server} {status.serverVersion} · API {status.apiVersion} ·{" "}
                  {status.openSubsonic ? "OpenSubsonic" : "Subsonic only"} ·{" "}
                  {status.songCount === null
                    ? "never scanned"
                    : `${String(status.songCount)} songs`}
                </span>
              </>
            ) : (
              <>
                <ToneBadge tone={status.configured ? "danger" : "muted"}>
                  {status.configured ? "not answering" : "not configured"}
                </ToneBadge>
                <span className="text-fg-2">{status.error ?? ""}</span>
              </>
            )}
          </span>
        </FormRow>
        <FormRow
          label="Scan before verifying"
          help="Off when a Navidrome cron already scans often enough; a scan per import is wasteful on a large library."
        >
          <Toggle
            checked={form.navidromeRescanOnVerify}
            onChange={(next) => {
              set("navidromeRescanOnVerify", next);
            }}
            label={form.navidromeRescanOnVerify ? "on" : "off"}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={busy !== null || !status.configured}
            onClick={() => {
              run("rescan", async () => {
                const result = await rescanNavidrome({ data: { full: false } });
                return result.started ? "Rescan requested." : (result.error ?? "Rescan refused.");
              });
            }}
          >
            Rescan now
          </Button>
        </FormRow>
        <FormRow
          label="Wait for the scan"
          help="Milliseconds before the verify step gives up on a running scan."
        >
          <Input
            className="w-32 text-xs"
            type="number"
            value={form.navidromeWaitTimeoutMs}
            onChange={(event) => {
              set("navidromeWaitTimeoutMs", Number(event.target.value));
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Notifications"
        description="One channel, told about the events you tick. For machine-to-machine callbacks with a signature and retries, use the webhooks on Settings › API & agents instead."
      >
        <FormRow label="Enabled">
          <Toggle
            checked={form.notificationsEnabled}
            onChange={(next) => {
              set("notificationsEnabled", next);
            }}
            label={form.notificationsEnabled ? "on" : "off"}
            testId="toggle-notifications"
          />
        </FormRow>
        <FormRow label="Channel">
          <ChipGroup
            value={form.notificationsChannel}
            options={[
              { value: "none", label: "None" },
              { value: "ntfy", label: "ntfy" },
              { value: "discord", label: "Discord" },
              { value: "email", label: "Email (SMTP)" },
            ]}
            onChange={(next) => {
              set("notificationsChannel", next);
            }}
            testId="chips-notify-channel"
          />
        </FormRow>
        <FormRow
          label="Target"
          help={
            form.notificationsChannel === "email"
              ? "The destination e-mail address."
              : form.notificationsChannel === "discord"
                ? "The Discord incoming-webhook URL."
                : "The full ntfy topic URL, e.g. https://ntfy.sh/my-topic."
          }
        >
          <Input
            className="w-full max-w-form font-mono text-xs"
            placeholder={
              loaded.notificationsTargetMask === ""
                ? "not set"
                : `${loaded.notificationsTargetMask} — leave empty to keep`
            }
            value={form.notificationsTarget}
            data-testid="input-notifications-target"
            onChange={(event) => {
              set("notificationsTarget", event.target.value);
            }}
          />
        </FormRow>
        <FormRow label="Notify on">
          <ChipMulti
            values={form.notificationsEvents}
            options={NOTIFIABLE_EVENTS.map((event) => ({ value: event, label: event }))}
            onChange={(next) => {
              set("notificationsEvents", next);
            }}
            testId="chips-notify-events"
          />
        </FormRow>
        <FormRow label="Send a test" help="Delivers now, whatever the events above say.">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || form.notificationsChannel === "none"}
            data-testid="notifications-test"
            onClick={() => {
              run("notify", async () => {
                const outcome = await testNotification({
                  data: {
                    channel: form.notificationsChannel,
                    target: form.notificationsTarget,
                  },
                });
                if (!outcome.delivered) throw new Error(outcome.reason);
                return `Test notification delivered over ${outcome.channel}.`;
              });
            }}
          >
            <Plug className="size-3.5" aria-hidden="true" />
            Test
          </Button>
        </FormRow>
      </Section>

      {form.notificationsChannel !== "email" ? null : (
        <Section
          title="SMTP"
          description="Used only by the e-mail channel. Port 465 implies TLS; anything else uses STARTTLS when it is on."
        >
          <FormRow label="Host">
            <Input
              className="w-full max-w-form font-mono text-xs"
              value={form.smtpHost}
              data-testid="input-smtp-host"
              onChange={(event) => {
                set("smtpHost", event.target.value);
              }}
            />
          </FormRow>
          <FormRow label="Port">
            <Input
              className="w-32 text-xs"
              type="number"
              value={form.smtpPort}
              onChange={(event) => {
                set("smtpPort", Number(event.target.value));
              }}
            />
          </FormRow>
          <FormRow label="STARTTLS">
            <Toggle
              checked={form.smtpTls}
              onChange={(next) => {
                set("smtpTls", next);
              }}
              label={form.smtpTls ? "on" : "off"}
            />
          </FormRow>
          <FormRow label="Username" help="Empty sends unauthenticated.">
            <Input
              className="w-full max-w-form font-mono text-xs"
              value={form.smtpUser}
              onChange={(event) => {
                set("smtpUser", event.target.value);
              }}
            />
          </FormRow>
          <FormRow label="Password">
            <Input
              className="w-full max-w-form font-mono text-xs"
              type="password"
              placeholder={
                loaded.smtpPasswordMask === ""
                  ? "not set"
                  : `${loaded.smtpPasswordMask} — leave empty to keep`
              }
              value={form.smtpPassword}
              onChange={(event) => {
                set("smtpPassword", event.target.value);
              }}
            />
          </FormRow>
          <FormRow label="From" help="Defaults to the username when empty.">
            <Input
              className="w-full max-w-form font-mono text-xs"
              value={form.smtpFrom}
              onChange={(event) => {
                set("smtpFrom", event.target.value);
              }}
            />
          </FormRow>
        </Section>
      )}

      <Section
        title="Backup"
        description="Documents and the raw source cache (docs/03 §8). Restoring is re-projecting, so no audio is carried and no credential is exported."
      >
        <FormRow label="Export" help="One JSON file: settings, metadata documents, source cache.">
          <Button
            variant="outline"
            disabled={busy !== null}
            data-testid="backup-export"
            onClick={() => {
              setBusy("export");
              void exportBackup().then(
                (payload) => {
                  setBusy(null);
                  const blob = new Blob([JSON.stringify(payload, null, 2)], {
                    type: "application/json",
                  });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `music-manager-${payload.exportedAt.slice(0, 10)}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                  toast(
                    `${String(payload.counts["documents"] ?? 0)} document(s) and ${String(payload.counts["cache"] ?? 0)} cached response(s) exported.`,
                    "ok",
                  );
                },
                (error: unknown) => {
                  setBusy(null);
                  toast(error instanceof Error ? error.message : "Export failed.", "danger");
                },
              );
            }}
          >
            <Download className="size-4" aria-hidden="true" /> Export JSON
          </Button>
        </FormRow>
        <FormRow
          label="Import"
          help="Applies the settings block. Documents and cache are reported but not merged into a live database."
        >
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 py-1.5 text-xs hover:bg-surface-3">
            <Upload className="size-4" aria-hidden="true" /> Choose a file
            <input
              type="file"
              accept="application/json"
              className="sr-only"
              data-testid="backup-import"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file === undefined) return;
                setBusy("import");
                void file.text().then(
                  (text) => {
                    let payload: unknown;
                    try {
                      payload = JSON.parse(text);
                    } catch {
                      setBusy(null);
                      toast("That file is not JSON.", "danger");
                      return;
                    }
                    void importBackup({ data: { payload: payload as never } }).then(
                      (result) => {
                        setBusy(null);
                        toast(
                          `${String(result.settings)} setting(s) applied${result.skipped.length === 0 ? "" : `, ${String(result.skipped.length)} skipped`}.`,
                          "ok",
                        );
                        void router.invalidate();
                      },
                      (error: unknown) => {
                        setBusy(null);
                        toast(error instanceof Error ? error.message : "Import failed.", "danger");
                      },
                    );
                  },
                  () => {
                    setBusy(null);
                    toast("That file could not be read.", "danger");
                  },
                );
              }}
            />
          </label>
        </FormRow>
      </Section>

      <Callout tone="neutral">
        <div>
          Credentials are never exported and never returned by the API — a backup you cannot paste
          into a support thread is a backup nobody makes.
        </div>
      </Callout>

      <div className="flex justify-end">
        <Button
          disabled={busy !== null}
          data-testid="integrations-save"
          onClick={() => {
            run("save", async () => {
              const result = await saveIntegrationSettings({ data: form });
              return `${String(result.saved)} setting(s) saved.`;
            });
          }}
        >
          <Save className="size-4" aria-hidden="true" /> Save
        </Button>
      </div>
    </div>
  );
}
