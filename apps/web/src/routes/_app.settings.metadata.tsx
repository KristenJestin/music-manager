/**
 * Settings › Metadata & matching.
 *
 * The largest page in the Console, because it is where every number that decides what a tag
 * says lives. It is organised as the pipeline reads it: who we ask (MusicBrainz), how we
 * choose (matching), how we check (fingerprint), what we add (enrichment), what we write (the
 * tag map), how we version it (the tag schema), what rides next to it (sidecars), and who
 * answers (sources).
 *
 * Two things this page is careful about:
 *
 *  - **A credential is shown as its length and last two characters, never in full.** Saving
 *    the page without touching the field sends the mask back, and the server reads that as
 *    "leave it alone" rather than as a new value — so opening Settings and pressing Save does
 *    not wipe your keys.
 *  - **The tag map is the domain's table, filtered.** Choosing a consumer profile shows the
 *    fields it indexes; it does not stop the other twenty-five being written. The page says
 *    so, in the callout above the table, because that is the single most misreadable idea in
 *    the app.
 */
import { useState } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Download, Layers, ShieldCheck, Tag } from "lucide-react";
import { cn } from "cn";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { ChipGroup, ChipMulti, FormRow, Section, Toggle } from "#/components/settings/controls.tsx";
import { SettingsForm } from "#/components/settings/settings-form.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { SchemaHeading } from "#/components/library/schema.tsx";
import { TagMapTable, type FormatColumns } from "#/components/library/tag-map-table.tsx";
import { pct } from "#/lib/format.ts";
import {
  fetchMetadataSettings,
  saveMetadataSettings,
  testSources,
} from "#/server/functions/settings-metadata.ts";
import { startRetag } from "#/server/functions/retag.ts";
import type { SourceTestResult } from "#/server/services/source-tests.ts";

export const Route = createFileRoute("/_app/settings/metadata")({
  loader: async () => await fetchMetadataSettings(),
  staticData: { crumbs: [{ label: "Metadata & matching" }] },
  component: MetadataSettings,
});

const COUNTRIES = ["XW", "FR", "GB", "US", "DE", "JP", "NL", "SE"];

function MetadataSettings() {
  const payload = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(payload.fields.map((field) => [field.key, field.value])),
  );
  const [saving, setSaving] = useState(false);
  const [tests, setTests] = useState<readonly SourceTestResult[]>([]);
  const [testing, setTesting] = useState(false);
  const [profile, setProfile] = useState("all");
  const [format, setFormat] = useState<FormatColumns>("vorbis");
  // Nothing on this page accepts input until React is attached to it; see `SettingsForm`.
  const hydrated = useHydrated();

  const value = <T,>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback;
  const set = (key: string, next: unknown): void => {
    setValues((current) => ({ ...current, [key]: next }));
  };

  const save = (): void => {
    setSaving(true);
    void saveMetadataSettings({ data: { values } }).then(
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

  const runTests = (source?: SourceTestResult["source"]): void => {
    setTesting(true);
    void testSources({ data: source === undefined ? {} : { source } }).then(
      (results) => {
        setTesting(false);
        setTests((current) => [
          ...results,
          ...current.filter((entry) => !results.some((next) => next.source === entry.source)),
        ]);
      },
      (error: unknown) => {
        setTesting(false);
        toast(error instanceof Error ? error.message : "The test did not run.", "danger");
      },
    );
  };

  const testOf = (name: string): SourceTestResult | undefined =>
    tests.find((entry) => entry.source === name);

  const enabled = value<Record<string, boolean>>("sourcesEnabled", {});
  const schema = payload.schema;

  return (
    <SettingsForm hydrated={hydrated} testId="settings-metadata">
      {/* ---- MusicBrainz ---- */}
      <Section title="MusicBrainz" description="The reference. Everything else refines it.">
        <FormRow
          label="Contact"
          help="Goes into the User-Agent, which MusicBrainz requires. Empty means: take MM_MB_CONTACT."
        >
          <Input
            data-testid="setting-mbContact"
            className="h-7 max-w-md font-mono text-xs"
            value={String(value("mbContact", ""))}
            placeholder="you@example.com"
            onChange={(event) => {
              set("mbContact", event.target.value);
            }}
          />
        </FormRow>
        <FormRow label="Rate limit" help="One request per second, and it is not configurable.">
          <ToneBadge outline>1 req/s · enforced by the limiter, not by hope</ToneBadge>
        </FormRow>
      </Section>

      {/* ---- matching ---- */}
      <Section
        title="Matching"
        description="The preselection of docs/04. It proposes and explains; it never chooses."
      >
        <FormRow
          label="Safe threshold"
          help="Above this the wizard marks the top candidate safe. It never skips your confirmation."
        >
          <NumberField
            testId="setting-safeThreshold"
            value={value("safeThreshold", 0.95)}
            step={0.01}
            onChange={(next) => {
              set("safeThreshold", next);
            }}
          />
        </FormRow>
        <FormRow label="Title similarity" help="Above this, two titles are the same work.">
          <NumberField
            testId="setting-titleMatchThreshold"
            value={value("titleMatchThreshold", 0.87)}
            step={0.01}
            onChange={(next) => {
              set("titleMatchThreshold", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Ambiguity margin"
          help="Two candidates closer than this go to the Inbox instead of being guessed at."
        >
          <NumberField
            testId="setting-matchAmbiguityMargin"
            value={value("matchAmbiguityMargin", 0.04)}
            step={0.01}
            onChange={(next) => {
              set("matchAmbiguityMargin", next);
            }}
          />
        </FormRow>
        <FormRow label="Duration tolerance" help="Seconds a video and a track may differ by.">
          <NumberField
            testId="setting-matchDurationTolerance"
            value={value("matchDurationTolerance", 2)}
            step={1}
            onChange={(next) => {
              set("matchDurationTolerance", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Release signal weights"
          help="The tracklist fit (`durations`) is the decisive one; that is the whole design of docs/04."
        >
          <WeightGrid
            testId="setting-matchReleaseWeights"
            weights={value<Record<string, number>>("matchReleaseWeights", {})}
            onChange={(next) => {
              set("matchReleaseWeights", next);
            }}
          />
        </FormRow>
        <FormRow label="Mapping signal weights" help="Binding one video to one track.">
          <WeightGrid
            testId="setting-matchMappingWeights"
            weights={value<Record<string, number>>("matchMappingWeights", {})}
            onChange={(next) => {
              set("matchMappingWeights", next);
            }}
          />
        </FormRow>
        <FormRow label="Preferred countries" help="Best first.">
          <ChipMulti
            testId="setting-preferredCountries"
            values={value<string[]>("preferredCountries", [])}
            options={COUNTRIES.map((code) => ({ value: code, label: code }))}
            onChange={(next) => {
              set("preferredCountries", next);
            }}
          />
        </FormRow>
        <FormRow label="Explicit or clean">
          <ChipGroup
            testId="setting-explicitPreference"
            value={String(value("explicitPreference", "either"))}
            options={[
              { value: "either", label: "either" },
              { value: "explicit", label: "prefer explicit" },
              { value: "clean", label: "prefer clean" },
            ]}
            onChange={(next) => {
              set("explicitPreference", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Learn from confirmations"
          help={`Visibly, never opaquely: ${String(value("learnedFrom", 0))} confirmed release(s) have nudged the preferences so far.`}
        >
          <Toggle
            testId="setting-learnPreferences"
            checked={value("learnPreferences", true)}
            onChange={(next) => {
              set("learnPreferences", next);
            }}
          />
        </FormRow>
      </Section>

      {/* ---- fingerprint ---- */}
      <Section
        title="Fingerprint (AcoustID)"
        description="The safety net: it checks the mapping against the audio itself."
      >
        <FormRow label="API key">
          <Input
            data-testid="setting-acoustidKey"
            className="h-7 max-w-md font-mono text-xs"
            value={String(value("acoustidKey", ""))}
            onChange={(event) => {
              set("acoustidKey", event.target.value);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={testing}
            data-testid="test-acoustid"
            onClick={() => {
              runTests("acoustid");
            }}
          >
            Test
          </Button>
          <TestResult result={testOf("acoustid")} />
        </FormRow>
        <FormRow
          label="Pause on disagreement"
          help="A fingerprint that names a different recording is a question, not a failure."
        >
          <Toggle
            testId="setting-verifyFingerprint"
            checked={value("verifyFingerprint", true)}
            onChange={(next) => {
              set("verifyFingerprint", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Write ACOUSTID_FINGERPRINT"
          help="The raw Chromaprint is bulky, so it is opt-in (§2.5)."
        >
          <Toggle
            testId="setting-writeAcoustidFingerprint"
            checked={value("writeAcoustidFingerprint", false)}
            onChange={(next) => {
              set("writeAcoustidFingerprint", next);
            }}
          />
        </FormRow>
      </Section>

      {/* ---- enrichment ---- */}
      <Section title="Enrichment" description="What is added once the release is known.">
        <FormRow label="Cover art order" help="Best first. The YouTube thumbnail is the fallback.">
          <ChipMulti
            testId="setting-coverOrder"
            values={value<string[]>("coverOrder", [])}
            options={[
              { value: "coverartarchive", label: "Cover Art Archive" },
              { value: "youtube", label: "YouTube thumbnail" },
            ]}
            onChange={(next) => {
              set("coverOrder", next);
            }}
          />
        </FormRow>
        <FormRow label="Genres" help="MusicBrainz first, then the community tags.">
          <ChipMulti
            testId="setting-genrePreference"
            values={value<string[]>("genrePreference", [])}
            options={[
              { value: "musicbrainz", label: "MusicBrainz" },
              { value: "lastfm", label: "Last.fm" },
              { value: "listenbrainz", label: "ListenBrainz" },
            ]}
            onChange={(next) => {
              set("genrePreference", next);
            }}
          />
          <span className="text-2xs text-fg-3">max</span>
          <NumberField
            testId="setting-maxGenres"
            value={value("maxGenres", 3)}
            step={1}
            onChange={(next) => {
              set("maxGenres", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Lyrics tolerance"
          help="Widest accepted difference, in seconds, between an LRCLIB result and the track."
        >
          <NumberField
            testId="setting-lyricsMaxDurationDelta"
            value={value("lyricsMaxDurationDelta", 2)}
            step={1}
            onChange={(next) => {
              set("lyricsMaxDurationDelta", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Last.fm key"
          help="Moods and community genres. Empty means: take MM_LASTFM_KEY."
        >
          <Input
            data-testid="setting-lastfmKey"
            className="h-7 max-w-md font-mono text-xs"
            value={String(value("lastfmKey", ""))}
            onChange={(event) => {
              set("lastfmKey", event.target.value);
            }}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={testing}
            onClick={() => {
              runTests("lastfm");
            }}
          >
            Test
          </Button>
          <TestResult result={testOf("lastfm")} />
        </FormRow>
      </Section>

      {/* ---- the tag map ---- */}
      <Section
        title="Tag map"
        description="What we write, where it comes from, and who reads it back."
      >
        <div className="py-3">
          <Callout tone="info" className="mb-3">
            The reference is the <b>Picard tag mapping</b>: the standard superset across all formats
            — Vorbis for Opus and FLAC, ID3v2.4 for MP3, MP4 atoms for AAC. We write{" "}
            <b>{payload.tagMap.length} tags</b> whenever the sources have data, including the ones
            today&rsquo;s consumer ignores. Servers and players are <b>profiles</b> that describe
            what is <i>read back</i>; <b>a profile never changes what is written</b>.
          </Callout>

          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-2xs text-fg-2">Consumer profile</span>
            <ChipGroup
              testId="tagmap-profile"
              value={profile}
              options={[
                { value: "all", label: `All (${String(payload.tagMap.length)})` },
                ...payload.profiles.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} ${String(entry.reads)}${entry.status === "verified" ? " ✓" : ""}`,
                })),
              ]}
              onChange={setProfile}
            />
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="w-24 shrink-0 text-2xs text-fg-2">Format keys</span>
            <ChipGroup
              testId="tagmap-format"
              value={format}
              options={[
                { value: "vorbis" as const, label: "Vorbis" },
                { value: "id3v24" as const, label: "ID3v2.4" },
                { value: "mp4" as const, label: "MP4" },
                { value: "all" as const, label: "All three" },
                { value: "source" as const, label: "Source" },
              ]}
              onChange={setFormat}
            />
            <span className="grow" />
            <Button
              size="xs"
              variant="outline"
              nativeButton={false}
              render={<Link to="/library/quality" />}
            >
              <ShieldCheck className="size-3" aria-hidden="true" /> What is missing in the library
            </Button>
          </div>

          {profile === "all" ? null : (
            <Callout
              tone={
                payload.profiles.find((entry) => entry.id === profile)?.status === "verified"
                  ? "ok"
                  : "warn"
              }
              className="mb-2"
            >
              {(() => {
                const entry = payload.profiles.find((item) => item.id === profile);
                if (entry === undefined) return null;
                return (
                  <>
                    <b>{entry.name}</b> — {entry.note} Lyrics: {entry.lyrics.join(", ")}. Sidecars:{" "}
                    {entry.sidecars.join(", ")}. <b>This filter changes the view, not the files.</b>
                  </>
                );
              })()}
            </Callout>
          )}

          <TagMapTable
            rows={payload.tagMap}
            columns={format}
            profile={profile}
            profiles={payload.profiles.map((entry) => ({ id: entry.id, name: entry.name }))}
            testId="settings-tag-map"
          />
        </div>
      </Section>

      {/* ---- the tag schema ---- */}
      <Section
        title="Tag schema"
        description="Every file carries MUSICMANAGER_TAGSCHEMA. When the projection changes, the library catches up in the background."
      >
        <div className="py-3">
          <Callout tone="info" className="mb-3">
            <Layers className="inline size-3.5" aria-hidden="true" /> Two forgotten fields are two
            resolvers, a version bump, and a background re-tag that reads the{" "}
            <b>raw source cache</b> — no network, no re-download, the audio stream is never touched.
            Each file gets a visible diff before it is written.
          </Callout>

          <div className="mb-3 grid gap-2 sm:grid-cols-4">
            <StatTile
              label="Current schema"
              value={<SchemaHeading current={schema.current} overridden={schema.overridden} />}
              sub={schema.overridden ? "override in force" : "compiled into @mm/domain"}
            />
            <StatTile
              label="Files up to date"
              value={schema.filesCurrent}
              tone="ok"
              sub={pct(
                schema.filesCurrent + schema.filesBehind === 0
                  ? 1
                  : schema.filesCurrent / (schema.filesCurrent + schema.filesBehind),
              )}
            />
            <StatTile
              label="Files behind"
              value={schema.filesBehind}
              tone={schema.filesBehind === 0 ? "ok" : "warn"}
              sub="queued by the worker on start"
              to="/library/quality"
              search={{ filter: "schema", profile: "global" }}
            />
            <StatTile
              label="Changelog"
              value={payload.changelog.length}
              sub="version(s) recorded"
            />
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={schema.filesBehind === 0}
              data-testid="settings-retag"
              onClick={() => {
                void startRetag({
                  data: { scope: "library", targetId: null, dryRun: false, onlyBehind: true },
                }).then(
                  (run) => {
                    toast(`Re-tag queued for ${String(run.total)} file(s).`, "ok");
                  },
                  (error: unknown) => {
                    toast(error instanceof Error ? error.message : "Not queued.", "danger");
                  },
                );
              }}
            >
              <Tag className="size-3.5" aria-hidden="true" /> Re-tag {schema.filesBehind} file(s)
            </Button>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={
                <Link to="/library/quality" search={{ filter: "schema", profile: "global" }} />
              }
            >
              Albums behind schema
            </Button>
          </div>

          <ul className="divide-y divide-line rounded-xl border border-line bg-surface-1">
            {payload.changelog.map((entry) => (
              <li key={entry.version} className="flex items-start gap-2.5 px-3 py-2">
                <ToneBadge tone={entry.version === schema.current ? "ok" : "muted"}>
                  v{entry.version}
                </ToneBadge>
                <div className="min-w-0 grow">
                  <div className="text-xs">{entry.note}</div>
                  <div className="font-mono text-2xs text-fg-3">
                    {[...entry.added, ...entry.changed, ...entry.removed].join(" · ")}
                  </div>
                </div>
                <span className="shrink-0 text-2xs text-fg-3">{entry.at}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ---- sidecars ---- */}
      <Section
        title="Sidecars"
        description="What the tags cannot carry, and which consumers pick each one up."
      >
        <div className="py-3">
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface-1">
            {payload.sidecars.map((sidecar) => (
              <li key={sidecar.file} className="flex items-start gap-2.5 px-3 py-2">
                <code className="shrink-0 font-mono text-2xs text-fg-1">{sidecar.file}</code>
                <div className="min-w-0 grow text-2xs text-fg-2">{sidecar.note}</div>
                <span className="shrink-0 text-2xs text-fg-3">
                  read by {sidecar.readers.join(", ")}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-fg-3">
            Which of these are written is a Library &amp; files setting — this table says who
            benefits.
          </p>
        </div>
      </Section>

      {/* ---- sources ---- */}
      <Section
        title="Sources"
        description="Every response is kept whole in the raw cache and never purged. A new field is computed from it, offline."
      >
        <div className="py-3">
          <div className="mb-2 flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={testing}
              data-testid="test-all-sources"
              onClick={() => {
                runTests();
              }}
            >
              {testing ? "Testing…" : "Test all"}
            </Button>
            <span className="grow" />
            <Toggle
              testId="setting-sourcesRefreshEnabled"
              label="Weekly source refresh"
              checked={value("sourcesRefreshEnabled", true)}
              onChange={(next) => {
                set("sourcesRefreshEnabled", next);
              }}
            />
          </div>
          <table className="w-full text-xs" data-testid="sources-table">
            <thead>
              <tr className="border-b border-line text-2xs tracking-wider text-fg-2 uppercase">
                <th className="px-2.5 py-1.5 text-left font-medium">Source</th>
                <th className="px-2.5 py-1.5 text-left font-medium">Enabled</th>
                <th className="px-2.5 py-1.5 text-right font-medium">TTL (days)</th>
                <th className="px-2.5 py-1.5 text-left font-medium">Last test</th>
                <th className="px-2.5 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {payload.sources.map((source) => {
                const result = testOf(source);
                const ttl = value<Record<string, number>>("sourceTtlDays", {});
                return (
                  <tr key={source} className="border-b border-line last:border-b-0">
                    <td className="px-2.5 py-1.5 font-medium">{source}</td>
                    <td className="px-2.5 py-1.5">
                      <Toggle
                        testId={`source-${source}`}
                        checked={enabled[source] ?? true}
                        onChange={(next) => {
                          set("sourcesEnabled", { ...enabled, [source]: next });
                        }}
                      />
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      <Input
                        type="number"
                        className="h-6 w-20 text-right text-xs"
                        value={String(ttl[source] ?? 0)}
                        onChange={(event) => {
                          set("sourceTtlDays", { ...ttl, [source]: Number(event.target.value) });
                        }}
                      />
                    </td>
                    <td className="px-2.5 py-1.5">
                      <TestResult result={result} />
                    </td>
                    <td className="px-2.5 py-1.5 text-right">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={testing}
                        onClick={() => {
                          runTests(source as SourceTestResult["source"]);
                        }}
                      >
                        Test
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ---- the schema override, last, where it belongs ---- */}
      <Section
        title="Advanced"
        description="Two knobs that exist for the tests and for very large libraries."
      >
        <FormRow
          label="Tag schema version override"
          help="0 = off, which is what every real installation wants. Any other value makes the app believe the projection is at that version, so §8's background re-tag can be exercised end to end."
        >
          <NumberField
            testId="setting-tagSchemaVersionOverride"
            value={value("tagSchemaVersionOverride", 0)}
            step={1}
            onChange={(next) => {
              set("tagSchemaVersionOverride", next);
            }}
          />
          {schema.overridden ? <ToneBadge tone="warn">in force</ToneBadge> : null}
        </FormRow>
        <FormRow
          label="Re-tag batch size"
          help="Files per queue job. Small enough that a cancel is felt quickly, large enough that the overhead is not the work."
        >
          <NumberField
            testId="setting-retagBatchSize"
            value={value("retagBatchSize", 25)}
            step={1}
            onChange={(next) => {
              set("retagBatchSize", next);
            }}
          />
        </FormRow>
      </Section>

      <div className="flex items-center justify-end gap-2">
        <span className="text-2xs text-fg-3">
          <Download className="inline size-3" aria-hidden="true" /> Every value is parsed by its zod
          schema before it is written.
        </span>
        <Button data-testid="settings-save" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </SettingsForm>
  );
}

/* ------------------------------------------------------------------ */
/* small pieces                                                        */
/* ------------------------------------------------------------------ */

function NumberField({
  value,
  step,
  onChange,
  testId,
}: {
  readonly value: number;
  readonly step: number;
  readonly onChange: (next: number) => void;
  readonly testId?: string;
}) {
  return (
    <Input
      type="number"
      step={step}
      data-testid={testId}
      className="h-7 w-24 text-xs"
      value={String(value)}
      onChange={(event) => {
        onChange(Number(event.target.value));
      }}
    />
  );
}

function WeightGrid({
  weights,
  onChange,
  testId,
}: {
  readonly weights: Record<string, number>;
  readonly onChange: (next: Record<string, number>) => void;
  readonly testId?: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" data-testid={testId}>
      {Object.entries(weights).map(([name, weight]) => (
        <label key={name} className="flex items-center gap-1 text-2xs text-fg-2">
          {name}
          <Input
            type="number"
            step={0.05}
            className="h-6 w-16 text-xs"
            value={String(weight)}
            onChange={(event) => {
              onChange({ ...weights, [name]: Number(event.target.value) });
            }}
          />
        </label>
      ))}
    </div>
  );
}

function TestResult({ result }: { readonly result: SourceTestResult | undefined }) {
  if (result === undefined) return <span className="text-2xs text-fg-3">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          "size-1.5 rounded-full",
          result.ok ? "bg-ok" : result.enabled ? "bg-danger" : "bg-fg-3",
        )}
      />
      <span className="text-2xs text-fg-2">{result.message}</span>
      {result.ok ? (
        <span className="font-mono text-3xs text-fg-3">{result.latencyMs} ms</span>
      ) : null}
    </span>
  );
}
