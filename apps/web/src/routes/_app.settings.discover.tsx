/**
 * Settings › Discover.
 *
 * Four short sections, in the order somebody actually configures them: where the signals come
 * from, how far back to look, what counts as a gap, and the one optional write-back.
 *
 * The header states the dependency rather than hiding it: no Navidrome means no play counts,
 * which means the recommendation and similar-artist blocks have no anchor. Saying so here is
 * cheaper than a support question about an empty page.
 */
import { useState } from "react";
import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { SettingsForm } from "#/components/settings/settings-form.tsx";
import { ChipMulti, FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import {
  fetchDiscoverSettings,
  saveDiscoverSettings,
} from "#/server/functions/settings-discover.ts";

export const Route = createFileRoute("/_app/settings/discover")({
  loader: async () => await fetchDiscoverSettings(),
  staticData: { crumbs: [{ label: "Discover" }] },
  component: DiscoverSettings,
});

const RELEASE_TYPES = [
  { value: "Album" as const, label: "Album" },
  { value: "EP" as const, label: "EP" },
  { value: "Single" as const, label: "Single" },
  { value: "Other" as const, label: "Other" },
];

function DiscoverSettings() {
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
    void saveDiscoverSettings({ data: { values } }).then(
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
    <SettingsForm hydrated={hydrated} testId="settings-discover">
      {payload.navidromeConfigured ? null : (
        <Callout tone="warn">
          No Navidrome server is configured, so there are no play counts to work from. The
          discography block still works from what is already in the library; the other two need
          listening signals. <Link to="/settings/integrations">Configure it</Link>.
        </Callout>
      )}

      <Section
        title="Discover"
        description="Recommendations are recomputed on a schedule and on demand. Nothing is ever imported without the wizard."
      >
        <FormRow
          label="Compute recommendations"
          help="Off leaves the page with its empty state and skips the cron."
        >
          <Toggle
            testId="setting-discoverEnabled"
            checked={value("discoverEnabled", true)}
            onChange={(next) => {
              set("discoverEnabled", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Schedule"
          help="Five-field cron for `cron.discover`. Daily is plenty: your taste does not change hourly."
        >
          <Input
            data-testid="setting-discoverCron"
            className="h-7 w-40 font-mono text-xs"
            value={String(value("discoverCron", "0 6 * * *"))}
            onChange={(event) => {
              set("discoverCron", event.target.value);
            }}
          />
        </FormRow>
        <FormRow
          label="ListenBrainz user"
          help="Where Navidrome scrobbles. Empty means no collaborative filtering — the discography block still works."
        >
          <Input
            data-testid="setting-listenbrainzUser"
            className="h-7 max-w-xs text-xs"
            value={String(value("listenbrainzUser", ""))}
            onChange={(event) => {
              set("listenbrainzUser", event.target.value);
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="The window"
        description="What counts as “what you listen to”. A lifetime play counter is not an answer to that."
      >
        <FormRow
          label="Sliding window"
          help="Days. Older plays still count, halved once per window past the edge."
        >
          <Input
            data-testid="setting-discoverWindowDays"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("discoverWindowDays", 30))}
            onChange={(event) => {
              set("discoverWindowDays", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="Artists to compare"
          help="How many of your most-played get a MusicBrainz discography lookup."
        >
          <Input
            data-testid="setting-discoverTopArtists"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("discoverTopArtists", 8))}
            onChange={(event) => {
              set("discoverTopArtists", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="Recommendations shown"
          help="After the diversity bonus and the redundancy penalty."
        >
          <Input
            data-testid="setting-discoverMaxItems"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("discoverMaxItems", 40))}
            onChange={(event) => {
              set("discoverMaxItems", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="Per artist, before the penalty"
          help="The fourth record by the same artist sinks rather than disappearing."
        >
          <Input
            data-testid="setting-discoverMaxPerArtist"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("discoverMaxPerArtist", 3))}
            onChange={(event) => {
              set("discoverMaxPerArtist", Number(event.target.value));
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="What counts as a gap"
        description="Which MusicBrainz release-groups are worth proposing."
      >
        <FormRow label="Release types">
          <ChipMulti
            testId="setting-discoverIncludeTypes"
            values={value<("Album" | "EP" | "Single" | "Other")[]>("discoverIncludeTypes", [
              "Album",
              "EP",
            ])}
            options={RELEASE_TYPES}
            onChange={(next) => {
              set("discoverIncludeTypes", next);
            }}
          />
        </FormRow>
        <FormRow label="Exclude live records">
          <Toggle
            testId="setting-discoverExcludeLive"
            checked={value("discoverExcludeLive", true)}
            onChange={(next) => {
              set("discoverExcludeLive", next);
            }}
          />
        </FormRow>
        <FormRow label="Exclude compilations">
          <Toggle
            testId="setting-discoverExcludeCompilations"
            checked={value("discoverExcludeCompilations", true)}
            onChange={(next) => {
              set("discoverExcludeCompilations", next);
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Navidrome playlist"
        description="Optional, off by default. Navidrome can only play what Navidrome has, so this pushes the recommended tracks you already own — not the ones you do not."
      >
        <FormRow label="Push a playlist after each sync">
          <Toggle
            testId="setting-discoverPlaylistEnabled"
            checked={value("discoverPlaylistEnabled", false)}
            onChange={(next) => {
              set("discoverPlaylistEnabled", next);
            }}
          />
        </FormRow>
        <FormRow label="Playlist name" help="Replaced wholesale on each sync, never appended to.">
          <Input
            data-testid="setting-discoverPlaylistName"
            className="h-7 max-w-xs text-xs"
            value={String(value("discoverPlaylistName", "Recommended"))}
            onChange={(event) => {
              set("discoverPlaylistName", event.target.value);
            }}
          />
        </FormRow>
      </Section>

      <div className="flex justify-end">
        <Button data-testid="settings-save" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsForm>
  );
}
