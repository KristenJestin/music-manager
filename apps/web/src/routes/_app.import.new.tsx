import { useMemo, useState } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ArrowRight, ChevronLeft, Play, RefreshCw, Search } from "lucide-react";
import type { MappingLine, RecordingCandidate, ReleaseCandidate } from "@mm/domain";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { MappingRow } from "#/components/mapping-row.tsx";
import { Stepper } from "#/components/stepper.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { RecordingCandidateCard, ReleaseCandidateCard } from "#/components/candidate-card.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { cn } from "cn";
import { mmss, pct } from "#/lib/format.ts";
import {
  fetchCandidates,
  fetchMapping,
  fetchSource,
  resolveSource,
  searchCandidates,
  startImport,
  type CandidatesView,
  type MappingViewPayload,
  type SourceView,
} from "#/server/functions/wizard.ts";

/**
 * `/import/new` — the four steps of `docs/phases/P06-web-coeur.md`.
 *
 * Everything that decides *what the page shows* lives in the URL: which import, which step,
 * which release. That is not tidiness — it means a reload keeps your place, Back walks the
 * wizard, and the paste box on any page can deep-link straight into step 1 with a URL in hand.
 *
 * It also means the loader can do all the fetching. Each step's data is a function of the
 * search params, so there is not a single data-loading effect in this file: the router fetches,
 * React renders, and the only state the component owns is what the *user* has changed and not
 * yet submitted (mapping overrides, options, the search box).
 *
 * Nothing is written until step 4. The import row exists from step 1 because `resolve` has to
 * put fifteen videos somewhere; its release, mapping and options are submitted once, together.
 */
const search = z.object({
  /** A URL to resolve. Consumed by the loader, which redirects to the import it created. */
  url: z.string().optional(),
  importId: z.string().optional(),
  step: z.number().int().min(1).max(4).default(1),
  release: z.string().optional(),
});

type WizardSearch = z.infer<typeof search>;

interface WizardData {
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  readonly mapping: MappingViewPayload | null;
}

export const Route = createFileRoute("/_app/import/new")({
  validateSearch: search,
  loaderDeps: ({ search: deps }) => deps,
  loader: async ({ deps }): Promise<WizardData> => {
    /*
     * A URL with no import yet: resolve it, then redirect to the import it produced.
     *
     * The redirect is what stops a reload from creating a second job — after it, the address
     * bar names an import rather than a URL, so refreshing re-reads instead of re-resolving.
     */
    if (deps.importId === undefined) {
      if (deps.url === undefined || deps.url.trim() === "") {
        return { source: null, candidates: null, mapping: null };
      }
      const created = await resolveSource({ data: { url: deps.url } });
      throw redirect({
        to: "/import/new",
        search: { importId: created.importId, step: 1 },
        replace: true,
      });
    }

    const source = await fetchSource({ data: { importId: deps.importId } });
    if (deps.step < 2) return { source, candidates: null, mapping: null };

    const candidates = await fetchCandidates({ data: { importId: deps.importId } });
    // Step 2 opens on the algorithm's proposal. Putting it in the URL rather than in state
    // means "the release I picked" survives a reload and is shareable.
    if (deps.release === undefined && candidates.preselectedId !== null) {
      throw redirect({
        to: "/import/new",
        search: { ...deps, release: candidates.preselectedId },
        replace: true,
      });
    }
    if (
      deps.step < 3 ||
      deps.release === undefined ||
      deps.release === NO_MUSICBRAINZ ||
      candidates.kind === "single"
    ) {
      return { source, candidates, mapping: null };
    }

    const mapping = await fetchMapping({
      data: { importId: deps.importId, releaseMbid: deps.release },
    });
    return { source, candidates, mapping };
  },
  staticData: { crumbs: [{ label: "Import" }] },
  component: Wizard,
});

const STEP_NAMES = ["Source", "MusicBrainz match", "Track mapping", "Options & start"];

/**
 * The `release` search value that means **import without MusicBrainz** (P07a).
 *
 * A sentinel rather than an absent value, because "no release chosen yet" and "no release, on
 * purpose" are different states and the URL has to be able to tell them apart — otherwise a
 * reload of the second one would silently become the first and re-preselect a release.
 *
 * It is not an MBID, so nothing downstream can mistake it for one: the loader skips the
 * mapping call, step 3 is skipped entirely (there is no tracklist to map against), and
 * `startImport` receives `releaseMbid: null`.
 */
const NO_MUSICBRAINZ = "none";

export interface WizardOptions {
  readonly fingerprint: boolean;
  readonly lyrics: boolean;
  readonly replaygain: boolean;
  readonly force: boolean;
}

function Wizard() {
  const { source, candidates, mapping } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A server-rendered button does nothing until React has attached its handler.
  const hydrated = useHydrated();
  const blocked = busy || !hydrated;

  const go = (next: Partial<WizardSearch>): void => {
    // The reducer sees the *union* of every route's search params, so it is typed loosely and
    // narrowed back by merging over the ones this route validated.
    void navigate({
      to: "/import/new",
      search: () => ({ ...params, ...next }),
    });
  };

  const fail = (cause: unknown): void => {
    setBusy(false);
    const message = cause instanceof Error ? cause.message : "Something went wrong.";
    setError(message);
    toast(message, "danger");
  };

  const single = source?.kind === "single" || candidates?.kind === "single";

  return (
    <div data-testid="wizard" data-step={params.step}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface-1 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">New import</h1>
          <p className="text-fg-2">
            {single
              ? "Single video → one recording"
              : "Album/playlist → one release, 1:1 track mapping"}
          </p>
        </div>
        <Stepper
          steps={STEP_NAMES}
          current={params.step - 1}
          done={params.step - 1}
          onSelect={(index) => {
            go({ step: index + 1 });
          }}
        />
      </div>

      {error === null ? null : (
        <Callout tone="danger" className="mb-3.5" role="alert" data-testid="wizard-error">
          {error}
        </Callout>
      )}

      {params.step === 1 ? (
        <StepSource
          source={source}
          busy={blocked}
          onResolve={(url) => {
            setBusy(true);
            setError(null);
            void resolveSource({ data: { url } }).then((created) => {
              setBusy(false);
              void navigate({
                to: "/import/new",
                search: { importId: created.importId, step: 1 },
              });
            }, fail);
          }}
          onContinue={() => {
            go({ step: 2 });
          }}
        />
      ) : null}

      {params.step === 2 ? (
        <StepMatch
          key={params.importId ?? "none"}
          source={source}
          candidates={candidates}
          busy={blocked}
          selected={params.release ?? null}
          onSelect={(id) => {
            go({ release: id });
          }}
          onSearch={async (query) => {
            if (params.importId === undefined) return [];
            setBusy(true);
            setError(null);
            try {
              const result = await searchCandidates({
                data: { importId: params.importId, query },
              });
              setBusy(false);
              if (result.candidates.length === 0) toast("Nothing found for that.", "warn");
              return result.candidates;
            } catch (cause) {
              fail(cause);
              return [];
            }
          }}
          onBack={() => {
            go({ step: 1 });
          }}
          onContinue={() => {
            // Without MusicBrainz there is no tracklist to map against, so step 3 has nothing
            // to show: the mapping *is* the source's own order.
            go({ step: single === true || params.release === NO_MUSICBRAINZ ? 4 : 3 });
          }}
          onSkipMusicBrainz={() => {
            go({ release: NO_MUSICBRAINZ, step: 4 });
          }}
        />
      ) : null}

      {params.step >= 3 ? (
        <StepTail
          key={params.release ?? "none"}
          step={params.step}
          source={source}
          candidates={candidates}
          mapping={mapping}
          busy={blocked}
          single={single === true}
          onError={setError}
          onBusy={setBusy}
          onFail={fail}
          onStep={(step) => {
            go({ step });
          }}
          importId={params.importId ?? ""}
          release={params.release ?? ""}
        />
      ) : null}
    </div>
  );
}

/* ================================================================== */
/* steps 3 and 4 share the user's mapping edits                        */
/* ================================================================== */

/**
 * The half of the wizard that owns unsaved edits.
 *
 * Steps 3 and 4 are one component because the summary on step 4 counts the bindings step 3
 * produced. It is keyed on the release, so choosing a different one starts from that release's
 * proposal instead of carrying the previous one's edits across.
 */
function StepTail({
  step,
  source,
  candidates,
  mapping,
  busy,
  single,
  importId,
  release,
  onBusy,
  onError,
  onFail,
  onStep,
}: {
  readonly step: number;
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  readonly mapping: MappingViewPayload | null;
  readonly busy: boolean;
  readonly single: boolean;
  readonly importId: string;
  readonly release: string;
  readonly onBusy: (value: boolean) => void;
  readonly onError: (message: string | null) => void;
  readonly onFail: (cause: unknown) => void;
  readonly onStep: (step: number) => void;
}) {
  const navigate = useNavigate();
  const toast = useToast();

  /** Only what the user changed. The proposal underneath it comes from the loader. */
  const [overrides, setOverrides] = useState<Record<string, number | null>>({});
  const [options, setOptions] = useState<WizardOptions>({
    fingerprint: true,
    lyrics: true,
    replaygain: true,
    force: false,
  });
  const [priority, setPriority] = useState<"low" | "normal" | "next">("normal");

  const linesByVideo = useMemo(() => {
    const map = new Map<string, MappingLine>();
    for (const line of mapping?.lines ?? []) map.set(line.videoId, line);
    return map;
  }, [mapping]);

  /** The engine's proposal, expressed as the selector's values. */
  const proposed = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const line of mapping?.lines ?? []) {
      out[line.videoId] =
        line.trackN === null
          ? null
          : (mapping?.tracks.find(
              (track) =>
                track.position === line.trackN &&
                track.mediumPosition === (line.mediumPosition ?? 1),
            )?.absoluteIndex ?? null);
    }
    return out;
  }, [mapping]);

  const bindings = useMemo(() => ({ ...proposed, ...overrides }), [proposed, overrides]);

  const bound = Object.values(bindings).filter((value) => value !== null).length;
  const extras = (mapping?.videos.length ?? 0) - bound;
  const uncovered = Math.max(0, (mapping?.tracks.length ?? 0) - bound);

  const chosenRecording = useMemo<RecordingCandidate | null>(
    () => (candidates?.recordings ?? []).find((entry) => entry.id === release) ?? null,
    [candidates, release],
  );
  const chosenRelease = useMemo<ReleaseCandidate | null>(
    () => (candidates?.releases ?? []).find((entry) => entry.id === release) ?? null,
    [candidates, release],
  );

  /** Import without MusicBrainz: the source's own order is the mapping. */
  const untagged = release === NO_MUSICBRAINZ;

  const start = (): void => {
    onBusy(true);
    onError(null);

    if (untagged) {
      const videos = source?.videos ?? [];
      if (videos.length === 0) {
        onBusy(false);
        onError("The source has no videos to import.");
        return;
      }
      void startImport({
        data: {
          importId,
          releaseMbid: null,
          releaseGroupMbid: null,
          album: source?.hints.album ?? source?.title ?? "Unknown Album",
          albumArtist: source?.hints.artist ?? source?.uploader ?? "Unknown Artist",
          year: source?.hints.year ?? null,
          trackTotal: videos.length,
          bindings: videos.map((video, index) => ({
            position: video.index,
            trackPosition: index + 1,
            mediumPosition: 1,
            trackMbid: null,
            recordingMbid: null,
            trackTitle: video.ytTrack ?? video.title,
            confidence: 1,
          })),
          options,
          priority,
        },
      }).then((result) => {
        onBusy(false);
        toast(
          `Import queued without MusicBrainz — ${String(result.mapped)} track(s), tagged from YouTube alone.`,
          "ok",
        );
        void navigate({ to: "/imports/$id", params: { id: result.importId } });
      }, onFail);
      return;
    }

    const tracksByIndex = new Map(
      (mapping?.tracks ?? []).map((track) => [track.absoluteIndex, track]),
    );
    const videosByVideoId = new Map((mapping?.videos ?? []).map((video) => [video.videoId, video]));

    const payload = Object.entries(bindings)
      .filter((entry): entry is [string, number] => entry[1] !== null)
      .flatMap(([videoId, absoluteIndex]) => {
        const track = tracksByIndex.get(absoluteIndex);
        const video = videosByVideoId.get(videoId);
        if (track === undefined || video === undefined || track.recordingMbid === null) return [];
        return [
          {
            position: video.index,
            trackPosition: track.position,
            mediumPosition: track.mediumPosition,
            trackMbid: track.trackMbid,
            recordingMbid: track.recordingMbid,
            trackTitle: track.title,
            confidence: linesByVideo.get(videoId)?.confidence ?? 1,
          },
        ];
      });

    if (payload.length === 0) {
      onBusy(false);
      onError("Nothing is bound: at least one video has to map to a track.");
      return;
    }

    void startImport({
      data: {
        importId,
        releaseMbid: release,
        releaseGroupMbid: mapping?.releaseGroupMbid ?? null,
        album: mapping?.releaseTitle ?? "",
        albumArtist: mapping?.releaseArtist ?? "",
        year: mapping?.releaseYear ?? null,
        trackTotal: mapping?.tracks.length ?? 0,
        bindings: payload,
        options,
        priority,
      },
    }).then((result) => {
      onBusy(false);
      toast(`Import queued — ${String(result.mapped)} track(s).`, "ok");
      void navigate({ to: "/imports/$id", params: { id: result.importId } });
    }, onFail);
  };

  if (step === 3) {
    return (
      <StepMapping
        mapping={mapping}
        busy={busy}
        bindings={bindings}
        linesByVideo={linesByVideo}
        bound={bound}
        extras={extras}
        uncovered={uncovered}
        onChange={(videoId, absoluteIndex) => {
          setOverrides((current) => ({ ...current, [videoId]: absoluteIndex }));
        }}
        onBack={() => {
          onStep(2);
        }}
        onContinue={() => {
          onStep(4);
        }}
      />
    );
  }

  return (
    <StepOptions
      source={source}
      mapping={mapping}
      releaseTitle={
        untagged
          ? (source?.hints.album ?? source?.title ?? "Unknown Album")
          : (chosenRelease?.title ?? chosenRecording?.title ?? mapping?.releaseTitle ?? "")
      }
      releaseArtist={
        untagged
          ? (source?.hints.artist ?? source?.uploader ?? "Unknown Artist")
          : (chosenRelease?.artist ?? chosenRecording?.artist ?? mapping?.releaseArtist ?? "")
      }
      untagged={untagged}
      bound={untagged ? (source?.videos.length ?? 0) : bound}
      extras={untagged ? 0 : extras}
      uncovered={untagged ? 0 : uncovered}
      options={options}
      setOptions={setOptions}
      priority={priority}
      setPriority={setPriority}
      busy={busy}
      onBack={() => {
        onStep(single || untagged ? 2 : 3);
      }}
      onStart={start}
    />
  );
}

/* ================================================================== */
/* step 1                                                              */
/* ================================================================== */

/**
 * Highlight the fragments of a YouTube description the matcher actually reads.
 *
 * `docs/04`: the "Provided to YouTube by" block is where the label and the ℗ year come from.
 * Showing which four lines mattered, in the middle of forty that did not, is the difference
 * between a description panel and an explanation.
 */
const HIGHLIGHT =
  /(Provided to YouTube by [^\n]+|℗ \d{4}[^\n]*|Released on: [^\n]+|Auto-generated by YouTube\.)/;

function HighlightedDescription({ text }: { readonly text: string }) {
  const parts = text.split(new RegExp(HIGHLIGHT.source, "g"));
  return (
    <pre className="max-h-64 overflow-auto rounded-md border border-line bg-background p-2.5 font-mono text-2xs whitespace-pre-wrap text-fg-1">
      {parts.map((part, index) =>
        HIGHLIGHT.test(part) ? (
          <mark key={index} className="rounded-xs bg-primary-soft px-0.5 text-primary">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </pre>
  );
}

function StepSource({
  source,
  busy,
  onResolve,
  onContinue,
}: {
  readonly source: SourceView | null;
  readonly busy: boolean;
  readonly onResolve: (url: string) => void;
  readonly onContinue: () => void;
}) {
  const [pasted, setPasted] = useState(source?.url ?? "");

  return (
    <>
      <div className="split-grid">
        <div className="flex flex-col gap-3.5">
          <div className="rounded-xl border border-line bg-surface-1 p-3.5">
            <label className="flex flex-col gap-1.5">
              <span className="text-2xs font-medium text-fg-2">Source URL</span>
              <span className="flex gap-2">
                <input
                  data-testid="wizard-url"
                  value={pasted}
                  onChange={(event) => {
                    setPasted(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onResolve(pasted);
                    }
                  }}
                  placeholder="https://music.youtube.com/playlist?list=OLAK5uy_… or fixture://discovery"
                  className="h-8 flex-1 rounded-md border border-line-strong bg-background px-2.5 font-mono text-xs outline-none focus:border-primary"
                />
                <Button
                  variant="outline"
                  data-testid="wizard-resolve"
                  disabled={busy || pasted.trim() === ""}
                  onClick={() => {
                    onResolve(pasted);
                  }}
                >
                  <RefreshCw className={cn("size-4", busy && "animate-spin")} aria-hidden="true" />
                  {source === null ? "Resolve" : "Re-fetch"}
                </Button>
              </span>
              <span className="text-2xs text-fg-3">
                Accepted: youtube.com/watch, youtu.be, music.youtube.com playlist or album, and{" "}
                <code>fixture://…</code> in fixtures mode.
              </span>
            </label>
          </div>

          {source === null ? (
            <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center text-fg-2">
              {busy ? "Asking yt-dlp…" : "Paste a URL above to see what yt-dlp finds."}
            </div>
          ) : (
            <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
              <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
                <h2 className="text-sm font-semibold">What yt-dlp sees</h2>
                <span className="text-xs text-fg-2" data-testid="source-count">
                  {source.videos.length} {source.videos.length === 1 ? "video" : "videos"} ·{" "}
                  {mmss(source.totalSeconds)} total
                </span>
              </header>
              <div className="px-3.5 py-3">
                <div className="flex items-start gap-3.5">
                  <Cover size="lg" seed={source.importId} label={source.title ?? source.url} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold">{source.title ?? source.url}</div>
                    <div className="text-fg-2">{source.uploader ?? "unknown channel"}</div>
                    <div className="my-3 h-px bg-line" />
                    <KeyValueList
                      items={[
                        {
                          label: "Parsed artist",
                          value: (
                            <>
                              {source.hints.artist ?? "—"}{" "}
                              <ToneBadge tone="ok">from YT tags</ToneBadge>
                            </>
                          ),
                        },
                        {
                          label: "Parsed album",
                          value: (
                            <>
                              {source.hints.album ?? "—"}{" "}
                              <ToneBadge tone="ok">from YT tags</ToneBadge>
                            </>
                          ),
                        },
                        {
                          label: "Year",
                          value: (
                            <>
                              {source.hints.year ?? "—"}{" "}
                              {source.hints.releasedOn === null ? null : (
                                <ToneBadge tone="info">℗ / Released on</ToneBadge>
                              )}
                            </>
                          ),
                        },
                        {
                          label: "Label",
                          value: (
                            <>
                              {source.hints.label ?? "—"}{" "}
                              {source.hints.label === null ? null : (
                                <ToneBadge tone="info">“Provided to YouTube by”</ToneBadge>
                              )}
                            </>
                          ),
                        },
                        {
                          label: "Detected as",
                          value: <ToneBadge outline>{source.kind}</ToneBadge>,
                        },
                      ]}
                    />
                  </div>
                </div>

                {source.videos.length <= 1 ? null : (
                  <>
                    <div className="my-3 h-px bg-line" />
                    <table className="w-full text-xs" data-testid="source-videos">
                      <thead>
                        <tr className="text-2xs tracking-wider text-fg-2 uppercase">
                          <th className="px-2 py-1.5 text-left">#</th>
                          <th className="px-2 py-1.5 text-left">Video title</th>
                          <th className="px-2 py-1.5 text-left">YT track tag</th>
                          <th className="px-2 py-1.5 text-right">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {source.videos.map((video) => (
                          <tr key={video.id} className="border-t border-line">
                            <td className="px-2 py-1 text-right font-mono text-fg-3">
                              {video.index + 1}
                            </td>
                            <td className="px-2 py-1">{video.title}</td>
                            <td className="px-2 py-1 text-fg-2">{video.ytTrack ?? "—"}</td>
                            <td className="px-2 py-1 text-right font-mono">
                              {mmss(video.durationSeconds)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                )}
              </div>
            </section>
          )}
        </div>

        <div className="flex flex-col gap-3.5">
          {source !== null && source.duplicates.length > 0 ? (
            <Callout tone="warn">
              This URL was imported before ({source.duplicates.length}{" "}
              {source.duplicates.length === 1 ? "time" : "times"}). Re-importing is allowed — it is
              how you pick up better metadata — and files already in the library are skipped unless
              you force them.
            </Callout>
          ) : null}

          {source?.description == null ? null : (
            <section className="rounded-xl border border-line bg-surface-1">
              <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
                <h2 className="text-sm font-semibold">Description (parsed)</h2>
                <ToneBadge tone="ok">auto-generated</ToneBadge>
              </header>
              <div className="px-3.5 py-3">
                <HighlightedDescription text={source.description} />
                <p className="mt-2 text-2xs text-fg-3">
                  Highlighted fragments feed the matcher. Everything else is ignored.
                </p>
              </div>
            </section>
          )}

          <Callout tone="info">
            Nothing is downloaded yet. The next step asks MusicBrainz which release this is, and
            shows you why it thinks so.
          </Callout>
        </div>
      </div>

      <footer className="mt-4 flex justify-end">
        <Button data-testid="wizard-next" disabled={source === null || busy} onClick={onContinue}>
          Find on MusicBrainz <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </footer>
    </>
  );
}

/* ================================================================== */
/* step 2                                                              */
/* ================================================================== */

function StepMatch({
  source,
  candidates,
  busy,
  selected,
  onSelect,
  onSearch,
  onBack,
  onContinue,
  onSkipMusicBrainz,
}: {
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  readonly busy: boolean;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
  readonly onSearch: (query: string) => Promise<readonly ReleaseCandidate[]>;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkipMusicBrainz: () => void;
}) {
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState<readonly ReleaseCandidate[]>([]);

  const preselected =
    candidates === null
      ? null
      : ([...candidates.releases, ...candidates.recordings].find((entry) => entry.preselected) ??
        null);
  const shown = candidates?.releases ?? [];
  const extra = manual.filter((entry) => !shown.some((known) => known.id === entry.id));

  const runSearch = (): void => {
    if (query.trim() === "") return;
    void onSearch(query).then(setManual);
  };

  return (
    <>
      {candidates === null ? (
        <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center text-fg-2">
          No candidates yet.
        </div>
      ) : (
        <>
          <Callout tone="info" className="mb-3.5" data-testid="preselection">
            <b>
              {preselected === null
                ? "Nothing scored high enough to propose."
                : `Preselected: ${preselected.title} — ${pct(preselected.score)}.`}
            </b>{" "}
            {candidates.budget.searches} search
            {candidates.budget.searches === 1 ? "" : "es"} and {candidates.budget.lookups} lookup
            {candidates.budget.lookups === 1 ? "" : "s"} against MusicBrainz. You pick; the
            algorithm only orders. Open <em>why?</em> on any card for the signals behind its score.
            {candidates.ambiguous ? (
              <>
                {" "}
                <b>Two candidates are within {candidates.margin?.toFixed(3) ?? "?"}</b> and would
                not import the same tracks — worth a look.
              </>
            ) : null}
          </Callout>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <label className="flex h-8 w-72 items-center gap-1.5 rounded-md border border-line-strong bg-background px-2.5">
              <Search className="size-4 shrink-0 text-fg-3" aria-hidden="true" />
              <span className="sr-only">Search MusicBrainz, or paste an MBID</span>
              <input
                data-testid="mb-search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    runSearch();
                  }
                }}
                placeholder="Search releases, or paste a release MBID…"
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-3"
              />
            </label>
            <Button variant="outline" size="sm" disabled={busy} onClick={runSearch}>
              Search MusicBrainz
            </Button>
          </div>

          <div className="flex flex-col gap-2.5" data-testid="candidate-list">
            {candidates.kind === "single"
              ? candidates.recordings.map((candidate) => (
                  <RecordingCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    selected={selected === candidate.id}
                    onSelect={onSelect}
                    videoSeconds={source?.videos[0]?.durationSeconds ?? null}
                  />
                ))
              : [...shown, ...extra].map((candidate) => (
                  <ReleaseCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    selected={selected === candidate.id}
                    onSelect={onSelect}
                  />
                ))}
          </div>

          <Callout className="mt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                Nothing fits? Paste the MBID of the right release above — the mapping is computed
                against whatever you pin, even if the search never proposed it. If MusicBrainz
                genuinely does not have this — a live set, a bootleg, an unregistered artist —
                import it from the YouTube tags alone. The album is then flagged <b>untagged</b> in
                the library, with its own filter on the Quality page, so it can be finished the day
                a release appears.
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                data-testid="import-without-mb"
                onClick={onSkipMusicBrainz}
              >
                Import without MusicBrainz
              </Button>
            </div>
          </Callout>
        </>
      )}

      <footer className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-next" disabled={selected === null || busy} onClick={onContinue}>
          {candidates?.kind === "single" ? "Options" : "Map tracks"}{" "}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </footer>
    </>
  );
}

/* ================================================================== */
/* step 3                                                              */
/* ================================================================== */

function StepMapping({
  mapping,
  busy,
  bindings,
  linesByVideo,
  bound,
  extras,
  uncovered,
  onChange,
  onBack,
  onContinue,
}: {
  readonly mapping: MappingViewPayload | null;
  readonly busy: boolean;
  readonly bindings: Record<string, number | null>;
  readonly linesByVideo: Map<string, MappingLine>;
  readonly bound: number;
  readonly extras: number;
  readonly uncovered: number;
  readonly onChange: (videoId: string, absoluteIndex: number | null) => void;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  if (mapping === null) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center text-fg-2">
        Pick a release first.
      </div>
    );
  }

  return (
    <>
      <div
        data-testid="mapping-summary"
        className="mb-2 flex flex-wrap items-center gap-3.5 rounded-md bg-surface-2 px-3.5 py-2.5 text-xs"
      >
        <span>
          <b className="text-ok" data-testid="bound-count">
            {bound}
          </b>
          /{mapping.videos.length} videos bound
        </span>
        <span>
          <b className="text-warn" data-testid="extra-count">
            {extras}
          </b>{" "}
          extra video{extras === 1 ? "" : "s"} (skipped)
        </span>
        <span>
          <b className={uncovered > 0 ? "text-warn" : ""} data-testid="uncovered-count">
            {uncovered}
          </b>{" "}
          release track{uncovered === 1 ? "" : "s"} uncovered
        </span>
        <span className="ml-auto text-fg-2">
          mean |Δ| {mapping.meanAbsDelta === null ? "—" : `${mapping.meanAbsDelta.toFixed(1)}s`}
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <div className="map-grid gap-2.5 border-b border-line px-3 py-1.5 text-2xs tracking-wider text-fg-2 uppercase">
          <span>#</span>
          <span>YouTube video</span>
          <span />
          <span>
            MusicBrainz track ({mapping.releaseTitle}
            {mapping.releaseYear === null ? "" : ` · ${String(mapping.releaseYear)}`})
          </span>
          <span>Fit</span>
          <span />
        </div>
        {mapping.videos.map((video, index) => (
          <MappingRow
            key={video.id}
            index={index}
            video={video}
            line={linesByVideo.get(video.videoId) ?? null}
            tracks={mapping.tracks}
            bound={bindings[video.videoId] ?? null}
            onChange={(absoluteIndex) => {
              onChange(video.videoId, absoluteIndex);
            }}
          />
        ))}
      </div>

      <div className="split-even-grid mt-3.5">
        {extras > 0 ? (
          <Callout tone="warn" data-testid="extras-callout">
            <b>
              {extras} video{extras === 1 ? "" : "s"} outside the tracklist.
            </b>{" "}
            They will be skipped rather than downloaded. Pressing Start accepts that, so no question
            about them lands in Review.
          </Callout>
        ) : null}
        {uncovered > 0 ? (
          <Callout tone="warn" data-testid="uncovered-callout">
            <b>
              {uncovered} track{uncovered === 1 ? "" : "s"} of this release have no video.
            </b>{" "}
            The album will be imported partial, and Review will ask whether that is what you want.
          </Callout>
        ) : null}
        <Callout tone="info">
          <b>Fingerprint verification is on.</b> After download each file is fingerprinted
          (AcoustID); if it disagrees with this mapping the job pauses in Review instead of tagging
          the wrong track.
        </Callout>
      </div>

      <footer className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-next" disabled={bound === 0 || busy} onClick={onContinue}>
          Options <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </footer>
    </>
  );
}

/* ================================================================== */
/* step 4                                                              */
/* ================================================================== */

function Toggle({
  label,
  help,
  checked,
  onChange,
  testId,
}: {
  readonly label: string;
  readonly help?: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly testId: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3">
      <span>
        <span className="block">{label}</span>
        {help === undefined ? null : <span className="block text-2xs text-fg-3">{help}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-testid={testId}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          "relative h-4.5 w-8.5 shrink-0 rounded-xl border border-line-strong bg-surface-3",
          checked && "border-primary bg-primary",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-3 rounded-full bg-fg-2 transition-all",
            checked && "left-4.5 bg-primary-foreground",
          )}
        />
      </button>
    </label>
  );
}

function StepOptions({
  source,
  mapping,
  releaseTitle,
  releaseArtist,
  untagged,
  bound,
  extras,
  uncovered,
  options,
  setOptions,
  priority,
  setPriority,
  busy,
  onBack,
  onStart,
}: {
  readonly source: SourceView | null;
  readonly mapping: MappingViewPayload | null;
  readonly releaseTitle: string;
  readonly releaseArtist: string;
  /** Import without MusicBrainz: no release, tags from the YouTube metadata alone. */
  readonly untagged: boolean;
  readonly bound: number;
  readonly extras: number;
  readonly uncovered: number;
  readonly options: WizardOptions;
  readonly setOptions: (next: WizardOptions) => void;
  readonly priority: "low" | "normal" | "next";
  readonly setPriority: (value: "low" | "normal" | "next") => void;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onStart: () => void;
}) {
  const year = mapping?.releaseYear ?? null;
  const folder = `${releaseArtist === "" ? "Unknown Artist" : releaseArtist}/${
    releaseTitle === "" ? "Unknown Album" : releaseTitle
  }${year === null ? "" : ` (${String(year)})`}`;
  const firstTrack = mapping?.tracks[0];

  return (
    <>
      {untagged ? (
        <Callout tone="warn" className="mb-3.5" data-testid="untagged-notice">
          <b>Importing without MusicBrainz.</b> The tags will come from the YouTube metadata alone —
          title, artist, album, year — so there will be no identifiers, no credits, no release date
          and no cover from the archive. The album is flagged <b>untagged</b> in the library and has
          its own filter on the Quality page; picking a release later and re-tagging fills in
          everything, offline, without re-downloading a byte.
        </Callout>
      ) : null}
      <div className="split-grid">
        <div className="flex flex-col gap-3.5">
          <section className="rounded-xl border border-line bg-surface-1">
            <header className="border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Summary</h2>
            </header>
            <div className="flex items-start gap-3.5 px-3.5 py-3">
              <Cover size="lg" seed={mapping?.releaseMbid ?? ""} label={releaseTitle} />
              <KeyValueList
                className="flex-1"
                items={[
                  {
                    label: "Source",
                    value: <span className="font-mono text-2xs">{source?.url ?? "—"}</span>,
                  },
                  {
                    label: "Release",
                    value: `${releaseTitle} — ${releaseArtist}${year === null ? "" : ` (${String(year)})`}`,
                  },
                  {
                    label: "Tracks",
                    value: (
                      <span data-testid="summary-tracks">
                        {bound} bound · {extras} extra skipped · {uncovered} uncovered
                      </span>
                    ),
                  },
                  {
                    label: "Duplicates",
                    value:
                      source === null || source.duplicates.length === 0 ? (
                        <ToneBadge tone="ok">none</ToneBadge>
                      ) : (
                        <ToneBadge tone="warn">
                          {source.duplicates.length} earlier import(s) of this URL
                        </ToneBadge>
                      ),
                  },
                  { label: "Pace", value: "one download at a time, 5–15 s apart" },
                ]}
              />
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Destination preview</h2>
              <span className="text-2xs text-fg-2">template from Settings › Library</span>
            </header>
            <div className="flex flex-col gap-1.5 px-3.5 py-3">
              <div className="rounded-md border border-dashed border-line-strong bg-background px-2.5 py-2 font-mono text-2xs text-fg-1">
                {folder}/
                <b className="font-medium text-primary">
                  {String(firstTrack?.position ?? 1).padStart(2, "0")} - {firstTrack?.title ?? "…"}
                </b>
                .opus
              </div>
              <p className="text-2xs text-fg-3">
                Native codec kept — opus from YouTube, never re-encoded. Cover embedded, sidecar
                lyrics written next to the file.
              </p>
            </div>
          </section>
        </div>

        <div className="flex flex-col gap-3.5">
          <section className="rounded-xl border border-line bg-surface-1">
            <header className="border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Options</h2>
            </header>
            <div className="flex flex-col gap-3 px-3.5 py-3">
              <Toggle
                testId="option-fingerprint"
                label="Verify with fingerprint"
                help="AcoustID after download; pause in Review on a mismatch"
                checked={options.fingerprint}
                onChange={(value) => {
                  setOptions({ ...options, fingerprint: value });
                }}
              />
              <Toggle
                testId="option-lyrics"
                label="Fetch synced lyrics"
                help="LRCLIB, embedded and written as .lrc"
                checked={options.lyrics}
                onChange={(value) => {
                  setOptions({ ...options, lyrics: value });
                }}
              />
              <Toggle
                testId="option-replaygain"
                label="ReplayGain (track + album)"
                help="rsgain, once every track is in"
                checked={options.replaygain}
                onChange={(value) => {
                  setOptions({ ...options, replaygain: value });
                }}
              />
              <Toggle
                testId="option-force"
                label="Force re-download"
                help="overwrite files already in the library"
                checked={options.force}
                onChange={(value) => {
                  setOptions({ ...options, force: value });
                }}
              />

              <div className="h-px bg-line" />

              <div className="flex flex-col gap-1.5">
                <span className="text-2xs font-medium text-fg-2">Priority</span>
                <div className="flex gap-2">
                  {(["low", "normal", "next"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`priority-${value}`}
                      onClick={() => {
                        setPriority(value);
                      }}
                      className={cn(
                        "h-6 rounded-xl border border-line-strong bg-surface-2 px-2.5 text-xs text-fg-1",
                        priority === value && "border-primary bg-primary-soft text-primary",
                      )}
                    >
                      {value === "next" ? "Next in queue" : value === "low" ? "Low" : "Normal"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {uncovered > 0 ? (
            <Callout tone="warn">
              {uncovered} track{uncovered === 1 ? "" : "s"} of this release have no video. The
              import will go ahead and Review will ask whether to accept it as partial.
            </Callout>
          ) : null}
          <Callout tone="info">Starting queues the job. The next screen is its log, live.</Callout>
        </div>
      </div>

      <footer className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-start" disabled={busy || bound === 0} onClick={onStart}>
          <Play className="size-4" aria-hidden="true" />
          {busy ? "Starting…" : "Start import"}
        </Button>
      </footer>
    </>
  );
}
