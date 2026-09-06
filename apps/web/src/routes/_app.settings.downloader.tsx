/**
 * Settings → Downloader.
 *
 * The one page in the app where the answer to "why did it stop working" usually lives, so it
 * opens with the state of the binary itself rather than with a form: version, channel, when it
 * last checked, and the two buttons that fix it.
 *
 * Concurrency is shown and disabled on purpose. `docs/06-stack.md` fixes it at one, and a
 * field you can edit implies a choice that does not exist.
 */
import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Download, Play, Save } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { Callout } from "#/components/callout.tsx";
import { ChipGroup, FormRow, ReadOnly, Section, Toggle } from "#/components/settings/controls.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  fetchDownloaderSettings,
  saveDownloaderSettings,
  type DownloaderForm,
} from "#/server/functions/settings-downloader.ts";
import { runSelftest, runYtdlpUpdate, runCookiesTest } from "#/server/functions/tools.ts";

export const Route = createFileRoute("/_app/settings/downloader")({
  loader: async () => await fetchDownloaderSettings(),
  staticData: { crumbs: [{ label: "Downloader" }] },
  component: DownloaderSettings,
});

function DownloaderSettings() {
  const loaded = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<DownloaderForm>(loaded.values);
  const [busy, setBusy] = useState<string | null>(null);
  const health = loaded.health;

  const set = <K extends keyof DownloaderForm>(key: K, value: DownloaderForm[K]): void => {
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
    <div className="flex flex-col gap-3.5" data-testid="settings-downloader">
      <Callout tone={health.reachable ? "info" : "danger"} data-testid="ytdlp-banner">
        <div>
          <b>yt-dlp {health.versions["yt-dlp"] ?? "not installed"}</b> · channel {health.channel}
          {health.pin === "" ? null : <> · pinned {health.pin}</>} · auto-update{" "}
          {health.autoUpdate ? health.updateCron : "off"}
          {health.fixtures ? " · fixtures mode (never updated)" : ""}
          {health.reachable ? null : <> — {health.error ?? "the toolbox is not answering"}</>}
          <div className="mt-2 flex gap-1.5">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                run("update", async () => {
                  const result = await runYtdlpUpdate();
                  return result.updated
                    ? `Updated from ${result.from ?? "?"} to ${result.to ?? "?"} via ${result.method}.`
                    : `Already current (${result.to ?? "?"}).`;
                });
              }}
              data-testid="downloader-update"
            >
              <Download className="size-3.5" aria-hidden="true" /> Update now
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                run("selftest", async () => {
                  const result = await runSelftest({ data: { network: false } });
                  const failed = result.checks.filter((check) => !check.ok);
                  return failed.length === 0
                    ? "Self-test OK."
                    : `Self-test failed: ${failed.map((check) => check.name).join(", ")}.`;
                });
              }}
            >
              <Play className="size-3.5" aria-hidden="true" /> Self-test
            </Button>
            <Button
              size="sm"
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
          </div>
        </div>
      </Callout>

      <Section
        title="Updates"
        description="Decision 012: a stale downloader is the single largest cause of breakage, so this is on by default."
      >
        <FormRow label="Auto-update" help="Runs the cron below and reports what changed.">
          <Toggle
            checked={form.ytdlpAutoUpdate}
            onChange={(next) => {
              set("ytdlpAutoUpdate", next);
            }}
            label={form.ytdlpAutoUpdate ? "on" : "off"}
            testId="toggle-autoupdate"
          />
        </FormRow>
        <FormRow label="Schedule" help="A five-field cron expression, in the server's timezone.">
          <Input
            className="w-40 font-mono text-xs"
            value={form.ytdlpUpdateCron}
            data-testid="input-cron"
            onChange={(event) => {
              set("ytdlpUpdateCron", event.target.value);
            }}
          />
        </FormRow>
        <FormRow label="Release channel">
          <ChipGroup
            value={form.ytdlpChannel}
            options={[
              { value: "stable", label: "stable" },
              { value: "nightly", label: "nightly" },
              { value: "master", label: "master" },
            ]}
            onChange={(next) => {
              set("ytdlpChannel", next);
            }}
            testId="chips-channel"
          />
        </FormRow>
        <FormRow label="Pin version" help="Leave empty to follow the channel.">
          <Input
            className="w-40 font-mono text-xs"
            placeholder="2026.08.14"
            value={form.ytdlpPin}
            onChange={(event) => {
              set("ytdlpPin", event.target.value);
            }}
          />
        </FormRow>
        <FormRow
          label="On update failure"
          help="What happens when the refresh itself fails. An Inbox item is raised either way."
        >
          <ChipGroup
            value={form.ytdlpOnUpdateFailure}
            options={[
              { value: "warn", label: "warn and carry on" },
              { value: "pause_downloads", label: "pause downloads" },
              { value: "rollback", label: "keep the old build" },
            ]}
            onChange={(next) => {
              set("ytdlpOnUpdateFailure", next);
            }}
          />
        </FormRow>
      </Section>

      <Section
        id="cookies"
        title="Authentication"
        description="Needed for age-gated videos and to get past “Sign in to confirm you're not a bot”."
      >
        <FormRow label="Cookies">
          <ChipGroup
            value={form.cookiesMode}
            options={[
              { value: "anonymous", label: "None (anonymous)" },
              { value: "file", label: "cookies.txt file" },
              { value: "paste", label: "Paste cookies.txt" },
            ]}
            onChange={(next) => {
              set("cookiesMode", next);
            }}
            testId="chips-cookies"
          />
        </FormRow>
        {form.cookiesMode === "file" ? (
          <FormRow
            label="cookies.txt path"
            help="As the toolbox container sees it. On a server, prefer pasting the jar."
          >
            <Input
              data-testid="setting-cookiesFile"
              className="w-full max-w-form font-mono text-xs"
              placeholder="/data/cookies.txt"
              value={form.cookiesFile}
              onChange={(event) => {
                set("cookiesFile", event.target.value);
              }}
            />
            <CookiesTestButton busy={busy !== null} onRun={run} />
          </FormRow>
        ) : form.cookiesMode === "paste" ? (
          /*
           * The third option (owner review B6). On a real server nobody has a path inside the
           * toolbox container, but everybody has a browser export in the clipboard. The jar is
           * stored in the settings like any other credential — masked on the way to the
           * browser — and the toolbox writes it to a private temporary file for each call.
           */
          <FormRow
            label="cookies.txt content"
            help="Paste the Netscape export whole. Stored server-side; never shown again."
          >
            <div className="flex w-full max-w-form flex-col gap-1.5">
              <Textarea
                data-testid="setting-cookiesText"
                rows={6}
                spellCheck={false}
                className="font-mono text-xs"
                placeholder={"# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t…"}
                value={form.cookiesText}
                onFocus={(event) => {
                  // The stored jar arrives as its mask. Clicking in means "replace it".
                  if (event.target.value.startsWith("set (")) set("cookiesText", "");
                }}
                onChange={(event) => {
                  set("cookiesText", event.target.value);
                }}
              />
              <div className="flex items-center gap-1.5">
                <CookiesTestButton busy={busy !== null} onRun={run} />
                <span className="text-2xs text-fg-3">
                  Test reads the jar that is <b>saved</b>, so save first.
                </span>
              </div>
            </div>
          </FormRow>
        ) : (
          <FormRow label="Anonymous mode">
            <p className="text-2xs text-fg-2">
              yt-dlp uses no session. Most of YouTube needs none; age-gated videos and bot checks
              will fail, and the error decoder says so by name when they do.
            </p>
          </FormRow>
        )}
        <FormRow label="Proxy" help="Advanced. Only if bot checks persist from this address.">
          <Input
            className="w-full max-w-form font-mono text-xs"
            placeholder="socks5://host:1080"
            value={form.downloadProxy}
            onChange={(event) => {
              set("downloadProxy", event.target.value);
            }}
          />
        </FormRow>
      </Section>

      <Section title="Anti-ban" description="A metronome is what gets an address blocked.">
        <FormRow label="Concurrency" help="Always 1. Fixed by docs/06-stack.md, not configurable.">
          <ReadOnly value="1" note="one download at a time, installation-wide" />
        </FormRow>
        <FormRow label="Delay between downloads" help="Random jitter, in milliseconds.">
          <Input
            className="w-24 text-xs"
            type="number"
            value={form.downloadJitterMinMs}
            data-testid="input-jitter-min"
            onChange={(event) => {
              set("downloadJitterMinMs", Number(event.target.value));
            }}
          />
          <span className="text-2xs text-fg-3">to</span>
          <Input
            className="w-24 text-xs"
            type="number"
            value={form.downloadJitterMaxMs}
            onChange={(event) => {
              set("downloadJitterMaxMs", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="Retries and backoff"
          help="Attempts per track, then the first and the ceiling of the exponential backoff."
        >
          <Input
            className="w-20 text-xs"
            type="number"
            value={form.downloadMaxAttempts}
            onChange={(event) => {
              set("downloadMaxAttempts", Number(event.target.value));
            }}
          />
          <Input
            className="w-28 text-xs"
            type="number"
            value={form.downloadBackoffBaseMs}
            onChange={(event) => {
              set("downloadBackoffBaseMs", Number(event.target.value));
            }}
          />
          <Input
            className="w-28 text-xs"
            type="number"
            value={form.downloadBackoffMaxMs}
            onChange={(event) => {
              set("downloadBackoffMaxMs", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="Player client"
          help="yt-dlp's `player_client` extractor argument. Empty means its own default."
        >
          <Input
            className="w-full max-w-form font-mono text-xs"
            placeholder="web_safari,android"
            value={form.ytdlpPlayerClient}
            onChange={(event) => {
              set("ytdlpPlayerClient", event.target.value);
            }}
          />
        </FormRow>
        <FormRow
          label="Format selector"
          help="Never re-encode: `bestaudio` takes what YouTube already has."
        >
          <Input
            className="w-full max-w-form font-mono text-xs"
            value={form.downloadFormat}
            onChange={(event) => {
              set("downloadFormat", event.target.value);
            }}
          />
        </FormRow>
        <FormRow
          label="Extra yt-dlp arguments"
          help="One per line. The escape hatch for the next YouTube change."
        >
          <textarea
            className="min-h-16 w-full max-w-form rounded-md border border-line-strong bg-surface-2 px-2 py-1.5 font-mono text-2xs"
            value={form.ytdlpExtraArgs.join("\n")}
            data-testid="input-extra-args"
            onChange={(event) => {
              set(
                "ytdlpExtraArgs",
                event.target.value.split("\n").filter((line) => line.trim() !== ""),
              );
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Tools"
        description="The binaries live in the toolbox image, so these are what it reports, not what you choose."
      >
        <FormRow label="ffmpeg">
          <ReadOnly value={health.versions.ffmpeg ?? "missing"} />
        </FormRow>
        <FormRow label="fpcalc (Chromaprint)">
          <ReadOnly value={health.versions.fpcalc ?? "missing"} />
        </FormRow>
        <FormRow label="rsgain">
          <ReadOnly value={health.versions.rsgain ?? "missing"} />
        </FormRow>
      </Section>

      <div className="flex justify-end">
        <Button
          disabled={busy !== null}
          data-testid="downloader-save"
          onClick={() => {
            run("save", async () => {
              const result = await saveDownloaderSettings({ data: form });
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

/**
 * The Test button, identical for a path and for a pasted jar (owner review B6).
 *
 * It tests what the pipeline would use, which is the *saved* setting: a button that tested
 * the unsaved textarea would answer a question about a jar no download will ever see.
 */
function CookiesTestButton({
  busy,
  onRun,
}: {
  readonly busy: boolean;
  readonly onRun: (key: string, task: () => Promise<string>) => void;
}) {
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={busy}
      data-testid="cookies-test"
      onClick={() => {
        onRun("cookies", async () => {
          const result = await runCookiesTest();
          return result.ok
            ? `${result.source}: ${String(result.cookies)} cookie(s), a usable session.`
            : `${result.source}: ${result.note} ${result.problems.join("; ")}`;
        });
      }}
    >
      Test
    </Button>
  );
}
