/**
 * Settings › Watched sources.
 *
 * Three sections, in the order somebody configures them: what may be imported at all, when the
 * scan runs, and what a scan is allowed to confirm without being asked. The last one carries a
 * warning rather than a help string, because it is the single place in this app where the
 * algorithm may act on its own —
 * `docs/04-pipeline-et-matching.md` § Ce que l'algo ne fait jamais — and a knob like that
 * should read as an exception, not as one more toggle.
 *
 * These are the **defaults**. Auto-accept is decided per source on `/sources`, which is what
 * the link at the bottom is for.
 */
import { useState } from "react";
import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { SettingsForm } from "#/components/settings/settings-form.tsx";
import { FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { SkeletonSettingsTab } from "#/components/skeleton.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import {
  fetchWatchedSourcesSettings,
  saveWatchedSourcesSettings,
} from "#/server/functions/settings-sources.ts";

export const Route = createFileRoute("/_app/settings/sources")({
  loader: async () => await fetchWatchedSourcesSettings(),
  staticData: { crumbs: [{ label: "Watched sources" }] },
  component: WatchedSourcesSettings,
  pendingComponent: WatchedSourcesSettingsPending,
});

/** Three short blocks: what may be imported, when the scan runs, what it may confirm alone. */
function WatchedSourcesSettingsPending() {
  return (
    <SkeletonSettingsTab
      name="sources"
      label="Loading the watched-source settings…"
      rows={[2, 2, 2]}
    />
  );
}

function WatchedSourcesSettings() {
  const payload = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();
  const hydrated = useHydrated();
  const [saving, setSaving] = useState(false);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(payload.fields.map((field) => [field.key, field.value])),
  );

  const value = <T,>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback;
  const set = (key: string, next: unknown): void => {
    setValues((current) => ({ ...current, [key]: next }));
  };

  const save = (): void => {
    setSaving(true);
    void saveWatchedSourcesSettings({ data: { values } }).then(
      (result) => {
        setSaving(false);
        toast(`${String(result.saved.length)} setting(s) saved.`, "ok");
        void router.invalidate();
      },
      (error: unknown) => {
        setSaving(false);
        toast(error instanceof Error ? error.message : "Nothing was saved.", "danger");
      },
    );
  };

  return (
    <SettingsForm hydrated={hydrated} testId="settings-sources">
      <Section
        id="import-rules"
        title="Import rules"
        description="What a source has to look like before it is allowed to become an import. Both are off by default, and both apply to every import — the paste box, the API and a scan alike."
      >
        <FormRow
          label="Official uploads only"
          help="Refuse a video whose description has no “Provided to YouTube by” line — the marker a distributor writes on an official upload. Read from the description, never from the channel name: the channel is empty on more than half of real sources. A pasted link is refused with the reason; inside a playlist or a scan, the video is skipped and the reason recorded."
        >
          <Toggle
            testId="setting-officialUploadsOnly"
            checked={value("officialUploadsOnly", false)}
            onChange={(next) => {
              set("officialUploadsOnly", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Require an album"
          help="Refuse an isolated video with no album attached — neither a YouTube Music album tag nor an album line in its description. An entry inside a playlist is never affected: the playlist is the album."
        >
          <Toggle
            testId="setting-requireAlbum"
            checked={value("requireAlbum", false)}
            onChange={(next) => {
              set("requireAlbum", next);
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Scanning"
        description="Each source is listed without downloading anything, and only videos it has never seen become imports."
      >
        <FormRow
          label="Scan watched sources"
          help="Off keeps the sources and their history, and skips the cron entirely."
        >
          <Toggle
            testId="setting-watchedSourcesEnabled"
            checked={value("watchedSourcesEnabled", true)}
            onChange={(next) => {
              set("watchedSourcesEnabled", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Schedule"
          help="Five-field cron for `cron.watched-sources`. Every six hours is plenty: a playlist does not grow faster than you can listen."
        >
          <Input
            data-testid="setting-watchedSourcesCron"
            className="h-7 w-40 font-mono text-xs"
            value={String(value("watchedSourcesCron", "0 */6 * * *"))}
            onChange={(event) => {
              set("watchedSourcesCron", event.target.value);
            }}
          />
        </FormRow>
      </Section>

      <Section
        id="auto-accept"
        title="Auto-accept"
        description="The one place the algorithm may confirm an import for you. Per source, off unless you say otherwise."
      >
        <Callout tone="warn">
          A source with auto-accept on <strong>skips the review step</strong> for a match that is
          unambiguous and above the threshold below. Everything else still waits for you, and every
          automatic confirmation is recorded against <code>watched-source</code> in the decision
          log.
        </Callout>
        <FormRow
          label="On for new sources"
          help="Only the default of the Add form. Existing sources keep whatever they were given."
        >
          <Toggle
            testId="setting-watchedSourcesAutoAcceptDefault"
            checked={value("watchedSourcesAutoAcceptDefault", false)}
            onChange={(next) => {
              set("watchedSourcesAutoAcceptDefault", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Threshold"
          help={`The score a match must clear before it is confirmed alone. The matcher itself calls ${String(payload.safeThreshold)} “safe”; a source may ask for more.`}
        >
          <Input
            data-testid="setting-watchedSourcesAutoAcceptThreshold"
            type="number"
            step="0.01"
            min="0"
            max="1"
            className="h-7 w-24 font-mono text-xs"
            value={String(value("watchedSourcesAutoAcceptThreshold", payload.safeThreshold))}
            onChange={(event) => {
              set("watchedSourcesAutoAcceptThreshold", Number(event.target.value));
            }}
          />
        </FormRow>
      </Section>

      <p className="text-2xs text-fg-3">
        {payload.sourceCount === 0
          ? "No source is watched yet."
          : `${String(payload.sourceCount)} source(s) watched.`}{" "}
        <Link to="/sources" className="underline">
          Manage them
        </Link>
        .
      </p>

      <div className="flex justify-end">
        <Button data-testid="settings-save" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsForm>
  );
}
