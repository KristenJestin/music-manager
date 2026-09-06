/**
 * Settings › Library & files.
 *
 * Where files go, what they are called, and what rides next to them. The page is one object of
 * values and one Save button — the controls are dumb (`components/settings/controls.tsx`), so
 * there is no way for two pieces of state to disagree about what is on screen.
 *
 * The path template has a **live preview**, and the preview is a server call to
 * `previewPathTemplate` — the very function `place` renders with. A preview computed in the
 * browser by a second implementation would be a promise the app does not keep, and the whole
 * point of showing it is that you can trust it before you press Save.
 */
import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { DISC_MODES } from "@mm/domain";
import { FolderTree, RotateCcw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Callout } from "#/components/callout.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { ChipGroup, FormRow, ReadOnly, Section, Toggle } from "#/components/settings/controls.tsx";
import {
  fetchGeneralSettings,
  previewTemplate,
  saveGeneralSettings,
} from "#/server/functions/settings-general.ts";

export const Route = createFileRoute("/_app/settings/library")({
  loader: async () => await fetchGeneralSettings(),
  staticData: { crumbs: [{ label: "Library & files" }] },
  component: LibrarySettings,
});

function LibrarySettings() {
  const payload = Route.useLoaderData();
  const router = useRouter();
  const toast = useToast();

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(payload.fields.map((field) => [field.key, field.value])),
  );
  const [preview, setPreview] = useState(payload.preview);
  const [templateError, setTemplateError] = useState("");
  const [saving, setSaving] = useState(false);

  const value = <T,>(key: string, fallback: T): T => (values[key] as T | undefined) ?? fallback;
  const set = (key: string, next: unknown): void => {
    setValues((current) => ({ ...current, [key]: next }));
  };

  /* The preview follows the template, the disc mode and the sanitiser — debounced, because
     it is a server round trip and people type. */
  const template = value("pathTemplate", payload.defaultTemplate);
  const discMode = value("discMode", "prefix");
  const sanitize = value("sanitizeMode", "windows");

  useEffect(() => {
    const timer = setTimeout(() => {
      void previewTemplate({
        data: {
          template,
          discMode: discMode as "prefix" | "folder" | "continuous",
          sanitizeMode: sanitize as "unicode" | "windows" | "strict",
        },
      }).then(
        (result) => {
          setTemplateError(result.ok ? "" : result.reason);
          if (result.ok) setPreview(result.preview);
        },
        () => {
          setTemplateError("The preview could not be computed.");
        },
      );
    }, 250);
    return () => {
      clearTimeout(timer);
    };
  }, [template, discMode, sanitize]);

  const save = (): void => {
    setSaving(true);
    void saveGeneralSettings({ data: { values } }).then(
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
    <div className="flex flex-col gap-3.5" data-testid="settings-library">
      <Section
        title="Library"
        description="The one directory Navidrome also mounts. Every path stored in a row is relative to it."
      >
        <FormRow
          label="Library root"
          help="As this process sees it. Empty means: take MM_LIBRARY_ROOT from the environment."
        >
          <Input
            data-testid="setting-libraryRoot"
            className="h-7 max-w-lg font-mono text-xs"
            value={String(value("libraryRoot", ""))}
            placeholder={payload.resolved.host}
            onChange={(event) => {
              set("libraryRoot", event.target.value);
            }}
          />
          <ReadOnly value={payload.resolved.host} note="in force" />
        </FormRow>
        <FormRow
          label="Library root, in the container"
          help="The same directory as the toolbox sees it. The two roots are why a path can cross the bridge at all."
        >
          <Input
            data-testid="setting-toolboxLibraryRoot"
            className="h-7 max-w-lg font-mono text-xs"
            value={String(value("toolboxLibraryRoot", ""))}
            placeholder={payload.resolved.container}
            onChange={(event) => {
              set("toolboxLibraryRoot", event.target.value);
            }}
          />
          <ReadOnly value={payload.resolved.container} note="in force" />
        </FormRow>
      </Section>

      <Section title="Layout" description="Where a track is filed, as a template.">
        <FormRow label="Path template" help={payload.tokens.map((t) => t.token).join(" ")}>
          <div className="w-full">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                data-testid="setting-pathTemplate"
                className="h-7 min-w-96 flex-1 font-mono text-xs"
                value={String(template)}
                onChange={(event) => {
                  set("pathTemplate", event.target.value);
                }}
              />
              <Button
                size="xs"
                variant="outline"
                title="Back to the layout the app ships with."
                onClick={() => {
                  set("pathTemplate", payload.defaultTemplate);
                }}
              >
                <RotateCcw className="size-3" aria-hidden="true" /> Default
              </Button>
            </div>
            {templateError === "" ? (
              <div
                className="mt-1.5 rounded-md border border-line bg-surface-2 px-2 py-1.5"
                data-testid="template-preview"
              >
                {preview.map((entry) => (
                  <div key={entry.label} className="flex gap-2 font-mono text-2xs">
                    <span className="w-20 shrink-0 text-fg-3">{entry.label}</span>
                    <span className="text-fg-1">{entry.path}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-2xs text-danger" data-testid="template-error">
                {templateError}
              </p>
            )}
          </div>
        </FormRow>
        <FormRow
          label="Multi-disc numbering"
          help="`continuous` only if the release really is numbered straight through, or both discs claim 01."
        >
          <ChipGroup
            testId="setting-discMode"
            value={String(discMode)}
            options={DISC_MODES.map((mode) => ({
              value: mode,
              label:
                mode === "prefix"
                  ? "prefix (1-01)"
                  : mode === "folder"
                    ? "folder (Disc 1/01)"
                    : "continuous",
            }))}
            onChange={(next) => {
              set("discMode", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Filename sanitising"
          help="`windows` also serves SMB shares safely; `strict` folds everything to ASCII."
        >
          <ChipGroup
            testId="setting-sanitizeMode"
            value={String(sanitize)}
            options={[
              { value: "unicode", label: "unicode (keep accents)" },
              { value: "windows", label: "windows-safe" },
              { value: "strict", label: "strict (ASCII)" },
            ]}
            onChange={(next) => {
              set("sanitizeMode", next);
            }}
          />
        </FormRow>
        <FormRow label="Longest path segment" help="Leaving room for the sidecar suffixes.">
          <Input
            data-testid="setting-maxSegmentLength"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("maxSegmentLength", 200))}
            onChange={(event) => {
              set("maxSegmentLength", Number(event.target.value));
            }}
          />
        </FormRow>
        <FormRow
          label="When the file already exists"
          help="`skip` is what makes an import idempotent; `mm import --force` overrides it for one job."
        >
          <ChipGroup
            testId="setting-onExists"
            value={String(value("onExists", "skip"))}
            options={[
              { value: "skip", label: "skip (idempotent)" },
              { value: "overwrite", label: "overwrite" },
              { value: "keep_both", label: "keep both" },
            ]}
            onChange={(next) => {
              set("onExists", next);
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Sidecars"
        description="What the tags cannot carry. Generated from the raw cache, so they are free to produce and free to redo."
      >
        <FormRow label="cover.jpg in each album folder">
          <Toggle
            testId="setting-writeCover"
            checked={value("writeCover", true)}
            onChange={(next) => {
              set("writeCover", next);
            }}
          />
        </FormRow>
        <FormRow label=".lrc next to each track">
          <Toggle
            testId="setting-writeLyricsSidecar"
            checked={value("writeLyricsSidecar", true)}
            onChange={(next) => {
              set("writeLyricsSidecar", next);
            }}
          />
        </FormRow>
        <FormRow
          label="Embed the front cover"
          help="In the audio file itself, as well as next to it. Both, because different consumers read different ones."
        >
          <Toggle
            testId="setting-embedArtwork"
            checked={value("embedArtwork", true)}
            onChange={(next) => {
              set("embedArtwork", next);
            }}
          />
        </FormRow>
        <FormRow label="Artwork size" help="Longest side, in pixels.">
          <Input
            data-testid="setting-artworkSize"
            type="number"
            className="h-7 w-28 text-xs"
            value={String(value("artworkSize", 1200))}
            onChange={(event) => {
              set("artworkSize", Number(event.target.value));
            }}
          />
        </FormRow>
      </Section>

      <Section
        title="Audio"
        description="Keep the native stream. No transcoding means no fake quality."
      >
        <FormRow label="yt-dlp format selector" help="`bestaudio` — never re-encode.">
          <Input
            data-testid="setting-downloadFormat"
            className="h-7 max-w-xs font-mono text-xs"
            value={String(value("downloadFormat", "bestaudio"))}
            onChange={(event) => {
              set("downloadFormat", event.target.value);
            }}
          />
        </FormRow>
        <FormRow label="ReplayGain" help="rsgain, once every track of the album is on disk.">
          <Toggle
            testId="setting-replayGain"
            checked={value("replayGain", true)}
            onChange={(next) => {
              set("replayGain", next);
            }}
          />
        </FormRow>
        <FormRow label="Reference loudness" help="In LUFS. −18 is the ReplayGain 2 default.">
          <Input
            data-testid="setting-replayGainReferenceLoudness"
            type="number"
            className="h-7 w-24 text-xs"
            value={String(value("replayGainReferenceLoudness", -18))}
            onChange={(event) => {
              set("replayGainReferenceLoudness", Number(event.target.value));
            }}
          />
        </FormRow>
      </Section>

      <Callout tone="info">
        <FolderTree className="inline size-3.5" aria-hidden="true" /> Changing the template does not
        move anything that is already filed. New imports follow it; an existing album keeps the path
        it was placed at, and the row and the file agree because both were written at the same time.
      </Callout>

      <div className="flex justify-end">
        <Button
          data-testid="settings-save"
          disabled={saving || templateError !== ""}
          onClick={save}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
