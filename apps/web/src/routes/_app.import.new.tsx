import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createFileRoute, redirect, useNavigate, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import {
  ArrowRight,
  ChevronLeft,
  Copyright,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import type {
  BorrowRelease,
  MappingLine,
  RecordingCandidate,
  ReleaseCandidate,
  ReleaseGroupCandidate,
} from "@mm/domain";
import { Button } from "#/components/ui/button.tsx";
import { borrowLabel } from "#/components/borrow-select.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover, coverArtFront } from "#/components/cover.tsx";
import { KeyValueList } from "#/components/key-value.tsx";
import { MappingRow } from "#/components/mapping-row.tsx";
import { MbSearchPanel } from "#/components/mb-search-panel.tsx";
import { ProgressBar } from "#/components/progress-bar.tsx";
import { Stepper } from "#/components/stepper.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { RecordingCandidateCard } from "#/components/candidate-card.tsx";
import { ReleaseGroupCard } from "#/components/candidate-group.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { PendingTree, useTestId } from "#/components/pending-tree.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { useMatchProgress, type MatchProgressSnapshot } from "#/hooks/use-match-progress.ts";
import { cn } from "cn";
import { mmss, pct } from "#/lib/format.ts";
import { isSourceOutage, readFailure } from "#/lib/errors.ts";
import type { DegradedSource } from "#/server/functions/wizard.ts";
import type { ResolvedRef } from "#/server/services/mb-resolve.ts";
import {
  applyPastedRef,
  fetchCandidates,
  fetchMapping,
  fetchRecording,
  fetchSource,
  resolvePastedRef,
  resolveSource,
  searchCandidates,
  startImport,
  type CandidatesView,
  type MappingViewPayload,
  type RecordingViewPayload,
  type SearchResultView,
  type SourceView,
  type SourceVideo,
} from "#/server/functions/wizard.ts";

/**
 * `/import/new` — the four steps of `docs/phases/P06-web-coeur.md`.
 *
 * Everything that decides *what the page shows* lives in the URL: which import, which step,
 * which release. That is not tidiness — it means a reload keeps your place, Back walks the
 * wizard, and ⌘K on any page can deep-link straight into step 1 with a URL — or with a release
 * to pin — in hand.
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
  /** The chosen release MBID on an album, the chosen **recording** MBID on a single. */
  release: z.string().optional(),
  /**
   * A single only: the release its album context is borrowed from.
   *
   * In the URL like everything else the wizard decides, so a reload keeps it and step 4 can
   * show the folder the file will actually land in. Absent means "whatever the engine
   * preferred", which is the honest default — it is not the same as a choice.
   */
  borrow: z.string().optional(),
  /**
   * A MusicBrainz release chosen **before** the source — the command palette's order.
   *
   * ⌘K resolves a pasted release (or an edition of a pasted release group) and lands here with
   * `pin` and nothing else: the URL is what is still missing, so step 1 opens on an empty box
   * with the pinned record named above it. On resolve it goes onto the import as
   * `options.releaseMbid`, the same door `mm import --release` uses, and from there `match`
   * and step 2 both honour it. It stays in the address bar so a reload keeps the pin.
   */
  pin: z.string().optional(),
});

type WizardSearch = z.infer<typeof search>;

interface WizardData {
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  readonly mapping: MappingViewPayload | null;
  /** The single path's step 3 and 4: one recording, looked up by MBID from the URL. */
  readonly recording: RecordingViewPayload | null;
  /**
   * MusicBrainz was unreachable, and this step is showing that rather than being replaced.
   *
   * The incident of 2026-09-08 is the whole reason this field exists: a 503 in the middle of
   * step 2 rejected the loader, and a rejected loader is a page the router hands to the error
   * boundary — the entire Console gone, the URL's meaning with it. A source outage is now
   * *data* for the step that asked, not an exception for the tree above it (decision 165).
   * Anything that is **not** a source outage still throws: a bug must not be swallowed into a
   * banner, and `_app.tsx`'s boundary is where it belongs.
   */
  readonly sourceFailure: DegradedSource | null;
  /**
   * The MusicBrainz match is running behind the request, and this screen is watching it.
   *
   * Step 2 is ten to fifteen seconds of MusicBrainz, and it used to spend them inside the
   * loader's own HTTP request — which the production runtime kills at ten
   * (`server/http/abort.ts`) and which a reload restarted from zero. The match now runs beside
   * the request (`server/services/match-runs.ts`); this flag is the loader saying "it has
   * started, come back when the stream says it is done", and `WizardMatching` is what the page
   * shows in the meantime.
   *
   * Different from the router's `pendingComponent`, which is what a *loader* looks like while
   * it runs: this one is data, so it survives SSR, a reload and a new tab on the same URL.
   */
  readonly matching: boolean;
}

const NO_DATA: WizardData = {
  source: null,
  candidates: null,
  mapping: null,
  recording: null,
  sourceFailure: null,
  matching: false,
};

/**
 * Run a step's fetch, and turn a source outage into a value.
 *
 * The two shapes it can return are the two the wizard has to tell apart, and neither is an
 * exception: `{ data }` when it worked, `{ failure }` when the *source* refused.
 */
async function tolerating<T>(
  load: () => Promise<T>,
): Promise<{ data: T; failure: null } | { data: null; failure: DegradedSource }> {
  try {
    return { data: await load(), failure: null };
  } catch (error) {
    if (!isSourceOutage(error)) throw error;
    const failure = readFailure(error);
    return {
      data: null,
      failure: {
        code: failure.code,
        message: failure.message,
        status: failure.status,
        hint: failure.hint,
      },
    };
  }
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
      if (deps.url === undefined || deps.url.trim() === "") return NO_DATA;
      const created = await resolveSource({
        data: {
          url: deps.url,
          // The pin is applied at creation, so it is on the row before `match` ever runs.
          ...(deps.pin === undefined || deps.pin === "" ? {} : { releaseMbid: deps.pin }),
        },
      });
      throw redirect({
        to: "/import/new",
        search: { importId: created.importId, step: 1 },
        replace: true,
      });
    }

    const source = await fetchSource({ data: { importId: deps.importId } });
    if (deps.step < 2) return { ...NO_DATA, source };

    const asked = await tolerating(async () =>
      fetchCandidates({ data: { importId: deps.importId ?? "" } }),
    );
    if (asked.failure !== null) return { ...NO_DATA, source, sourceFailure: asked.failure };
    /*
     * The match has started and there is nothing to choose from yet.
     *
     * Not an error, not an empty list, and above all not fifteen seconds spent inside this
     * loader: the request that returned this came back in milliseconds, and the work is going
     * on in the server behind it. `WizardMatching` follows `/api/match-progress` and re-runs
     * this loader when the stream says the match is done.
     */
    if (asked.data.pending) return { ...NO_DATA, source, matching: true };
    /*
     * Two ways step 2 can learn that MusicBrainz refused, and the first is the one that counts.
     *
     * `unavailable` is the server saying so **in JSON**, which reads the same whether this
     * loader ran during SSR or from a click; `asked.failure` above is the fallback for a
     * rejection, whose fields depend on how it travelled. Both end in the same place.
     */
    if (asked.data.unavailable !== null) {
      return { ...NO_DATA, source, sourceFailure: asked.data.unavailable };
    }
    const candidates = asked.data;

    // Step 2 opens on the algorithm's proposal. Putting it in the URL rather than in state
    // means "the release I picked" survives a reload and is shareable.
    if (deps.release === undefined && candidates.preselectedId !== null) {
      throw redirect({
        to: "/import/new",
        search: { ...deps, release: candidates.preselectedId },
        replace: true,
      });
    }
    if (deps.step < 3 || deps.release === undefined || deps.release === NO_MUSICBRAINZ) {
      return { ...NO_DATA, source, candidates };
    }

    /*
     * A single has no tracklist to map against, so steps 3 and 4 need the *recording* rather
     * than a mapping — looked up by MBID, exactly like the album's release, so that a
     * candidate found through the search box survives a reload (DRIVE-1 §A1).
     */
    if (candidates.kind === "single") {
      const looked = await tolerating(async () =>
        fetchRecording({
          data: { importId: deps.importId ?? "", recordingMbid: deps.release ?? "" },
        }),
      );
      /*
       * Falling back to step 2's screen, not to a blank one: the candidate list is already in
       * hand, so the honest thing is to show it with "MusicBrainz is unavailable" over it and
       * let Retry ask again — the choice the user made is still in the URL either way.
       */
      if (looked.failure !== null) {
        return { ...NO_DATA, source, candidates, sourceFailure: looked.failure };
      }
      return { ...NO_DATA, source, candidates, recording: looked.data };
    }

    const mapped = await tolerating(async () =>
      fetchMapping({ data: { importId: deps.importId ?? "", releaseMbid: deps.release ?? "" } }),
    );
    if (mapped.failure !== null) {
      return { ...NO_DATA, source, candidates, sourceFailure: mapped.failure };
    }
    return { ...NO_DATA, source, candidates, mapping: mapped.data };
  },
  staticData: { crumbs: [{ label: "Import" }] },
  component: Wizard,
  /*
   * A5 of the owner review: pressing "Find on MusicBrainz" did nothing visible for ten
   * seconds. It was not slow *and* silent by accident — every step's data is fetched in the
   * loader, and a loader with no pending component leaves the previous screen on the glass
   * until it resolves. `pendingMs: 0` shows the waiting screen on the first frame instead.
   */
  pendingMs: 0,
  pendingMinMs: 300,
  pendingComponent: WizardPending,
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

/* ================================================================== */
/* the frame: waiting, and the action bar                              */
/* ================================================================== */

/**
 * How long the match is honestly going to take, in words, from the plan it is actually running.
 *
 * The old sentence read *"MusicBrainz allows one request per second, so this takes about ten
 * seconds"*, and it was wrong in three separate ways. The owner's own screenshot says it:
 * `2/2 searches, 0/12 tracklist lookups` is **fourteen** requests, so fourteen seconds at best,
 * not ten. Ten was never the figure for twelve lookups even on the defaults — 1 + 3 searches
 * and 6 lookups is already ten requests, and ten requests one second apart take longer than
 * ten seconds, because the first one has to come back. And the gate is **installation-wide**
 * (`server/integrations/rate-gate.ts` holds it in Postgres, shared with the worker and the CLI),
 * so a running import pushes every number here out by however much it is spending.
 *
 * So: no constant, a floor rather than an estimate, and only once the plan is known. Before
 * the first frame arrives there is no number to give, and the honest thing is not to invent one.
 */
function matchEstimate(progress: MatchProgressSnapshot | null): string {
  const planned = (progress?.searchesPlanned ?? 0) + (progress?.lookupsPlanned ?? 0);
  const shared =
    "The limit is shared with everything else this installation is doing, so an import running at the same time makes it longer.";
  if (planned <= 0) {
    return `MusicBrainz allows one request per second. ${shared} Nothing is downloaded and nothing is written until you press Start.`;
  }
  return `MusicBrainz allows one request per second, so ${String(planned)} requests take at least ${String(planned)} seconds. ${shared} Nothing is downloaded and nothing is written until you press Start.`;
}

/**
 * The match, while it happens: which request is being made now, and how many are done.
 *
 * One panel, two callers, because the two states it draws are visually the same thing and
 * telling them apart would be a distinction only the code cares about:
 *
 *  - `WizardPending`, the router's `pendingComponent`, for the seconds a *loader* is running —
 *    step 1 resolving a URL through yt-dlp, and the round trip of every re-run;
 *  - `WizardMatching`, a real component rendered from loader **data**, for the ten to fifteen
 *    seconds the MusicBrainz match now spends running beside the request rather than inside
 *    it. That one survives SSR and a reload, which is the whole point of the change.
 *
 * The plan narrows as soon as the group search says how many groups there really were, so the
 * denominator is a promise rather than a guess (decision 151).
 */
function MatchPanel({
  step,
  matching,
  progress,
  testId,
}: {
  readonly step: number;
  /** False on step 1: the wait is yt-dlp's, and MusicBrainz has nothing to do with it. */
  readonly matching: boolean;
  readonly progress: MatchProgressSnapshot | null;
  readonly testId: string;
}) {
  const done = (progress?.searches ?? 0) + (progress?.lookups ?? 0);
  const planned = Math.max(1, (progress?.searchesPlanned ?? 4) + (progress?.lookupsPlanned ?? 6));
  /*
   * This panel is drawn by both of the route's trees — `WizardPending` is the router's
   * fallback, `WizardMatching` is the settled page reporting a match that runs beside the
   * request — and a re-suspend keeps both mounted. `testId` on the root already tells them
   * apart; everything below it did not, so `pending-title` and its five neighbours named two
   * elements at once, which is exactly what `components/pending-tree.tsx` exists to stop. The
   * settled copy keeps the bare name and the fallback's is suffixed `-pending`.
   */
  const scoped = useTestId();

  return (
    /*
     * `data-waiting` as well as the test id, because there are now two components drawing this
     * panel and a test usually means "the wizard is waiting" rather than "by which of the two
     * mechanisms". `wizard-pending` is the router's, `wizard-matching` is the loader data's,
     * and which one a given moment lands on depends on how fast the match turned out to be —
     * which is precisely the thing a test should not be asserting by accident.
     */
    <div
      role="status"
      aria-busy="true"
      data-testid={testId}
      data-waiting={matching ? "musicbrainz" : "source"}
      className="flex flex-col gap-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface-1 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">New import</h1>
          <p className="text-fg-2">
            {matching ? "Asking MusicBrainz which release this is" : "Reading the source"}
          </p>
        </div>
        <Stepper steps={STEP_NAMES} current={step - 1} done={step - 1} />
      </div>

      <section className="rounded-xl border border-line bg-surface-1 px-6 py-10">
        <div className="mx-auto flex max-w-md flex-col items-center gap-3.5 text-center">
          <LoaderCircle className="size-7 animate-spin text-primary" aria-hidden="true" />
          <h2 className="text-sm font-semibold" data-testid={scoped("pending-title")}>
            {matching ? "Searching MusicBrainz…" : "Reading the source…"}
          </h2>
          <p className="text-xs text-fg-2" data-testid={scoped("pending-label")}>
            {progress?.label ??
              (matching
                ? "One release-group search, one release search per group, then one tracklist lookup per candidate — one request per second."
                : "Asking YouTube what is behind this link.")}
          </p>

          {matching ? (
            <div className="flex w-full flex-col gap-1.5">
              <ProgressBar
                value={Math.min(1, done / planned)}
                tone="primary"
                label="MusicBrainz requests done"
                className="w-full"
              />
              <p className="font-mono text-2xs text-fg-2" data-testid={scoped("pending-counters")}>
                <span data-testid={scoped("pending-searches")}>
                  {progress?.searches ?? 0}/{progress?.searchesPlanned ?? 4}
                </span>{" "}
                searches, {""}
                <span data-testid={scoped("pending-lookups")}>
                  {progress?.lookups ?? 0}/{progress?.lookupsPlanned ?? 6}
                </span>{" "}
                tracklist lookups
              </p>
            </div>
          ) : null}

          <p className="text-2xs text-fg-3" data-testid={scoped("pending-estimate")}>
            {matching
              ? matchEstimate(progress)
              : "Nothing is downloaded and nothing is written until you press Start."}
          </p>
        </div>
      </section>
    </div>
  );
}

/** What the wizard looks like while its **loader** is running. */
function WizardPending() {
  const params = Route.useSearch();
  const matching = params.step >= 2 && params.importId !== undefined;
  const progress = useMatchProgress(matching ? (params.importId ?? null) : null);
  // `PendingTree`, which every other page gets from `SkeletonPage`: this is the one pending
  // component that draws a real panel instead of a skeleton, so it has to say so itself.
  return (
    <PendingTree>
      <MatchPanel
        step={params.step}
        matching={matching}
        progress={progress}
        testId="wizard-pending"
      />
    </PendingTree>
  );
}

/**
 * The same panel, but for a match that is running **in the server** rather than in the request.
 *
 * Two ways out of it, and both are needed:
 *
 *  - the progress stream reaching `done`, which is the fast one and the normal one. The
 *    snapshot is kept for thirty seconds after the end (`server/services/match-progress.ts`),
 *    so a stream opened *after* the match finished still receives it and this still fires;
 *  - a slow poll, for the case where the stream never arrives at all. Server-Sent Events go
 *    through most proxies and not all of them, and a wizard that hangs for ever because a
 *    buffering proxy ate the frames would be a worse bug than the one being fixed. Four
 *    seconds is cheap: while a run is in flight the loader it re-runs is two database reads and
 *    a `Map` lookup — `fetchCandidates` answers `pending` before it touches anything else.
 *
 * Re-running the loader is safe however often it happens: `fetchCandidates` answers `pending`
 * for as long as the run is in flight and never starts a second one (`match-runs.ts`).
 */
function WizardMatching({ importId, step }: { readonly importId: string; readonly step: number }) {
  const router = useRouter();
  const progress = useMatchProgress(importId);
  const phase = progress?.phase ?? null;

  useEffect(() => {
    if (phase !== "done") return;
    void router.invalidate();
  }, [phase, router]);

  useEffect(() => {
    const timer = setInterval(() => {
      void router.invalidate();
    }, MATCH_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [router]);

  return <MatchPanel step={step} matching progress={progress} testId="wizard-matching" />;
}

/** The fallback cadence for a stream that never arrived. Not the normal way out. */
const MATCH_POLL_MS = 4_000;

/**
 * The wizard's action bar: Back on the left, the step's forward action on the right.
 *
 * Sticky (A9 of the owner review). Step 3 of a fourteen-track album is two screens tall, and a
 * "Map tracks" button that only exists at the bottom of it is a button most people scroll past
 * looking for. It sits above the page background rather than inside it, so the rows scroll
 * under it instead of ending behind it.
 */
function WizardActions({ children }: { readonly children: ReactNode }) {
  return (
    <footer
      data-testid="wizard-actions"
      className="sticky bottom-0 z-20 -mx-4 mt-4 flex items-center justify-between gap-3 border-t border-line bg-background/95 px-4 py-3 backdrop-blur-sm"
    >
      {children}
    </footer>
  );
}

function Wizard() {
  const { source, candidates, mapping, recording, sourceFailure, matching } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const toast = useToast();

  /*
   * A source outage holds the wizard on step 2's screen whatever the URL says.
   *
   * Not a redirect: the step, the import and the chosen release stay in the address bar, so
   * Retry — which re-runs this very loader — lands back exactly where the user was. Changing
   * the URL to say "step 2" would make Retry mean something slightly different from what
   * failed, and would lose the release on the way (decision 165).
   */
  const unavailable = sourceFailure !== null;

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

  /*
   * The match is running in the server: this screen is the whole page until it lands.
   *
   * Before the shell and before the stepper, because there is no wizard to draw yet — the
   * candidates are the wizard, and they do not exist. `MatchPanel` draws its own header and
   * stepper so the frame does not flicker between the two.
   */
  if (matching && params.importId !== undefined) {
    return <WizardMatching importId={params.importId} step={params.step} />;
  }

  return (
    <div data-testid="wizard" data-step={params.step}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface-1 px-4 py-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">New import</h1>
          <p className="text-fg-2">
            {single
              ? "One video, one recording"
              : "Album or playlist: one release, one video per track"}
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
          pin={params.pin ?? null}
          busy={blocked}
          onResolve={(url) => {
            setBusy(true);
            setError(null);
            void resolveSource({
              data: {
                url,
                ...(params.pin === undefined || params.pin === ""
                  ? {}
                  : { releaseMbid: params.pin }),
              },
            }).then((created) => {
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

      {params.step === 2 || (unavailable && params.step >= 2) ? (
        <StepMatch
          key={params.importId ?? "none"}
          source={source}
          candidates={candidates}
          failure={sourceFailure}
          busy={blocked}
          selected={params.release ?? null}
          borrow={params.borrow ?? null}
          onSelect={(id) => {
            // A different recording has a different set of releases to borrow from, so the
            // previous choice cannot travel with it.
            go({ release: id, borrow: undefined });
          }}
          onBorrow={(releaseMbid) => {
            go({ borrow: releaseMbid });
          }}
          onSearch={async (title, artist) => {
            if (params.importId === undefined) return null;
            setBusy(true);
            setError(null);
            try {
              const result = await searchCandidates({
                data: {
                  importId: params.importId,
                  query: title,
                  ...(artist.trim() === "" ? {} : { artist }),
                },
              });
              setBusy(false);
              /*
               * No toast on an empty result any more. "Nothing found for that" said nothing at
               * all — it did not say what had been searched for, which is the one fact that
               * would have explained why `bewitched Laufey` matched nothing. The panel prints
               * the terms it actually used, in place, where they can be corrected.
               */
              return result;
            } catch (cause) {
              fail(cause);
              return null;
            }
          }}
          onResolveRef={async (input) => {
            if (params.importId === undefined) return null;
            // Deliberately not behind `setBusy`: it is a read, it happens while somebody is
            // typing, and disabling the page under them would be worse than the wait.
            return await resolvePastedRef({ data: { importId: params.importId, input } });
          }}
          onApplyRef={async (input) => {
            if (params.importId === undefined) return null;
            setBusy(true);
            setError(null);
            try {
              const result = await applyPastedRef({ data: { importId: params.importId, input } });
              setBusy(false);
              return result;
            } catch (cause) {
              fail(cause);
              return null;
            }
          }}
          onBack={() => {
            go({ step: 1 });
          }}
          onContinue={() => {
            // Without MusicBrainz there is no tracklist to map against, so step 3 has nothing
            // to show: the mapping *is* the source's own order. A single *does* have a step 3
            // — one video against one recording — and it is where the binding is confirmed.
            go({ step: params.release === NO_MUSICBRAINZ ? 4 : 3 });
          }}
          onSkipMusicBrainz={() => {
            go({ release: NO_MUSICBRAINZ, step: 4 });
          }}
        />
      ) : null}

      {params.step >= 3 && !unavailable ? (
        <StepTail
          key={params.release ?? "none"}
          step={params.step}
          source={source}
          candidates={candidates}
          mapping={mapping}
          recording={recording}
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
          borrow={params.borrow ?? null}
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
  recording,
  busy,
  single,
  importId,
  release,
  borrow,
  onBusy,
  onError,
  onFail,
  onStep,
}: {
  readonly step: number;
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  readonly mapping: MappingViewPayload | null;
  readonly recording: RecordingViewPayload | null;
  readonly busy: boolean;
  readonly single: boolean;
  readonly importId: string;
  readonly release: string;
  readonly borrow: string | null;
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

  /** Import without MusicBrainz: the source's own order is the mapping. */
  const untagged = release === NO_MUSICBRAINZ;

  const chosenRecording = useMemo<RecordingCandidate | null>(
    () =>
      recording?.recording ??
      (candidates?.recordings ?? []).find((entry) => entry.id === release) ??
      null,
    [recording, candidates, release],
  );
  const chosenRelease = useMemo<ReleaseCandidate | null>(
    () => (candidates?.releases ?? []).find((entry) => entry.id === release) ?? null,
    [candidates, release],
  );

  /**
   * The release a single's album context is borrowed from: the one in the URL, else the one
   * the engine preferred. `null` when MusicBrainz files this recording nowhere, which is a
   * state the Start button has to refuse rather than paper over with `Unknown Album`.
   */
  const chosenBorrow = useMemo<BorrowRelease | null>(() => {
    if (chosenRecording === null) return null;
    const picked = chosenRecording.releases.find((entry) => entry.id === borrow);
    return picked ?? chosenRecording.borrow ?? chosenRecording.releases[0] ?? null;
  }, [chosenRecording, borrow]);

  const bound = single
    ? untagged
      ? (source?.videos.length ?? 0)
      : chosenRecording !== null && chosenBorrow !== null
        ? 1
        : 0
    : Object.values(bindings).filter((value) => value !== null).length;
  const extras = single ? 0 : (mapping?.videos.length ?? 0) - bound;
  const uncovered = single ? 0 : Math.max(0, (mapping?.tracks.length ?? 0) - bound);

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
          `Import queued without MusicBrainz: ${String(result.mapped)} track(s), tagged from YouTube alone.`,
          "ok",
        );
        void navigate({ to: "/imports/$id", params: { id: result.importId } });
      }, onFail);
      return;
    }

    /*
     * A single: one video, one recording, and the release its album context is borrowed from.
     *
     * There was no branch here at all until DRIVE-1 §A1 — `start` knew "untagged" and "album",
     * so a single reached the Start button with an empty payload behind a button that was
     * disabled anyway. The shape is the album's, reduced: `trackTotal: 0` because a single
     * covers no tracklist, so `applySupplied` raises no `uncovered_tracks` for the eleven
     * other tracks of the album it happens to be borrowing from.
     */
    if (single) {
      const video = source?.videos[0];
      if (video === undefined || chosenRecording === null || chosenBorrow === null) {
        onBusy(false);
        onError(
          chosenBorrow === null && chosenRecording !== null
            ? "This recording is on no MusicBrainz release, so there is nothing to file it under. Pick another candidate, or import without MusicBrainz."
            : "Nothing is bound: pick a recording first.",
        );
        return;
      }
      const year = chosenBorrow.date === null ? null : Number(chosenBorrow.date.slice(0, 4));
      void startImport({
        data: {
          importId,
          releaseMbid: chosenBorrow.id,
          releaseGroupMbid: null,
          album: chosenBorrow.title,
          albumArtist: chosenRecording.artist,
          year: year === null || Number.isNaN(year) ? null : year,
          trackTotal: 0,
          bindings: [
            {
              position: video.index,
              trackPosition: chosenBorrow.trackPosition ?? 1,
              mediumPosition: 1,
              trackMbid: null,
              recordingMbid: chosenRecording.id,
              trackTitle: chosenRecording.title,
              confidence: chosenRecording.score,
            },
          ],
          options,
          priority,
        },
      }).then((result) => {
        onBusy(false);
        toast(`Import queued: “${chosenRecording.title}” on “${chosenBorrow.title}”.`, "ok");
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
      toast(`Import queued: ${String(result.mapped)} track(s).`, "ok");
      void navigate({ to: "/imports/$id", params: { id: result.importId } });
    }, onFail);
  };

  if (step === 3 && single) {
    return (
      <StepSingleMapping
        video={recording?.video ?? source?.videos[0] ?? null}
        recording={chosenRecording}
        borrow={chosenBorrow}
        busy={busy}
        onBack={() => {
          onStep(2);
        }}
        onContinue={() => {
          onStep(4);
        }}
      />
    );
  }

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
        /*
         * The prototype's three group actions (`prototypes/A-console`, step 3), which the app
         * shipped without: on a fifteen-row table the only way to undo a wrong idea was
         * fifteen dropdowns. All three are pure edits to `overrides`, so nothing is submitted
         * and Back still discards everything.
         */
        onAutoAssign={() => {
          setOverrides({});
        }}
        onByPosition={() => {
          const videos = mapping?.videos ?? [];
          const tracks = mapping?.tracks ?? [];
          setOverrides(
            Object.fromEntries(
              videos.map((video, index) => [video.videoId, tracks[index]?.absoluteIndex ?? null]),
            ),
          );
        }}
        onClearAll={() => {
          setOverrides(
            Object.fromEntries((mapping?.videos ?? []).map((video) => [video.videoId, null])),
          );
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
          : single
            ? (chosenBorrow?.title ?? "")
            : (chosenRelease?.title ?? mapping?.releaseTitle ?? "")
      }
      releaseArtist={
        untagged
          ? (source?.hints.artist ?? source?.uploader ?? "Unknown Artist")
          : single
            ? (chosenRecording?.artist ?? "")
            : (chosenRelease?.artist ?? mapping?.releaseArtist ?? "")
      }
      /*
       * The single's destination is the borrow release's folder and the recording's own
       * title, not "…" under a folder named after the recording (DRIVE-1 §A1, last paragraph).
       */
      year={
        single && !untagged && chosenBorrow?.date != null
          ? Number(chosenBorrow.date.slice(0, 4))
          : (mapping?.releaseYear ?? null)
      }
      firstTrack={
        single && !untagged && chosenRecording !== null
          ? {
              position: chosenBorrow?.trackPosition ?? 1,
              title: chosenRecording.title,
            }
          : null
      }
      untagged={untagged}
      bound={bound}
      extras={extras}
      uncovered={uncovered}
      options={options}
      setOptions={setOptions}
      priority={priority}
      setPriority={setPriority}
      busy={busy}
      onBack={() => {
        onStep(untagged ? 2 : 3);
      }}
      onStart={start}
    />
  );
}

/* ================================================================== */
/* step 3, single                                                      */
/* ================================================================== */

/**
 * Step 3 of a single: one video against one recording.
 *
 * It used to be skipped, which cost the wizard two things at once — the stepper claimed a step
 * had been *done* that had never been shown (DRIVE-1, minor findings), and the one screen that
 * says *which recording, on which release, at which track number* did not exist for the import
 * kind whose whole answer is that sentence. There is nothing to choose here: choosing happened
 * on step 2. It is a confirmation, and it is short on purpose.
 */
function StepSingleMapping({
  video,
  recording,
  borrow,
  busy,
  onBack,
  onContinue,
}: {
  readonly video: SourceVideo | null;
  readonly recording: RecordingCandidate | null;
  readonly borrow: BorrowRelease | null;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onContinue: () => void;
}) {
  if (recording === null || video === null) {
    return (
      <div className="rounded-xl border border-dashed border-line-strong px-6 py-16 text-center text-fg-2">
        Pick a recording first.
      </div>
    );
  }

  const difference =
    video.durationSeconds === null || recording.length === null
      ? null
      : video.durationSeconds - recording.length;

  return (
    <>
      <div
        data-testid="mapping-summary"
        className="mb-2 flex flex-wrap items-center gap-3.5 rounded-md bg-surface-2 px-3.5 py-2.5 text-xs"
      >
        <span>
          <b className="text-ok" data-testid="bound-count">
            {borrow === null ? 0 : 1}
          </b>
          /1 video bound
        </span>
        <span className="text-fg-2">One video, one recording: there is nothing to re-assign.</span>
        <span className="ml-auto font-mono text-fg-2">
          Δ {difference === null ? "n/a" : `${difference > 0 ? "+" : ""}${Math.round(difference)}s`}
        </span>
      </div>

      <div
        data-testid="single-mapping"
        className="overflow-hidden rounded-xl border border-line bg-surface-1"
      >
        <div className="map-grid gap-2.5 border-b border-line px-3 py-1.5 text-2xs tracking-wider text-fg-2 uppercase">
          <span>#</span>
          <span>YouTube video</span>
          <span />
          <span>MusicBrainz recording</span>
          <span>Fit</span>
          <span />
        </div>
        <div className="map-grid items-center gap-2.5 px-3 py-2 text-xs">
          <span className="text-right font-mono text-fg-3">1</span>
          <span className="flex min-w-0 items-center gap-2">
            <Cover size="xs" src={video.thumbnail} seed={video.videoId} label={video.title} />
            <span className="min-w-0">
              <span className="block truncate">{video.title}</span>
              <span className="block font-mono text-2xs text-fg-3">
                {mmss(video.durationSeconds)} · {video.uploader ?? "unknown channel"}
              </span>
            </span>
          </span>
          <ArrowRight className="size-4 text-ok" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate">
              {recording.title} <span className="text-fg-2">by {recording.artist}</span>
            </span>
            <span className="block truncate text-2xs text-fg-2" data-testid="single-borrow">
              {borrow === null
                ? "on no usable release"
                : `${borrowLabel(borrow)} · album tags from here`}
            </span>
          </span>
          <span className="font-mono text-2xs">{pct(recording.score)}</span>
          <span />
        </div>
      </div>

      <div className="split-even-grid mt-3.5">
        {borrow === null ? (
          <Callout tone="danger" data-testid="single-no-release">
            <b>MusicBrainz files this recording on no release.</b> There is no album folder, no
            album tag and no track number to give the file. Go back and pick another candidate, or
            import without MusicBrainz from step 2.
          </Callout>
        ) : (
          <Callout tone="info">
            <b>Album context is borrowed.</b> The file is filed under “{borrow.title}” with that
            release's album tags and track number; the recording's own identifiers are what get
            written. Change the release on step 2 if this is not where it belongs.
          </Callout>
        )}
        <Callout tone="info">
          <b>Fingerprint verification is on.</b> After download the file is fingerprinted
          (AcoustID); if it disagrees with this recording the job pauses in Review instead of
          tagging the wrong track.
        </Callout>
      </div>

      <WizardActions>
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-next" disabled={busy || borrow === null} onClick={onContinue}>
          Options <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </WizardActions>
    </>
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
  pin,
  busy,
  onResolve,
  onContinue,
}: {
  readonly source: SourceView | null;
  /** A release chosen in the palette before this import existed; `null` the usual way round. */
  readonly pin: string | null;
  readonly busy: boolean;
  readonly onResolve: (url: string) => void;
  readonly onContinue: () => void;
}) {
  const [pasted, setPasted] = useState(source?.url ?? "");

  return (
    <>
      {pin === null || pin === "" ? null : (
        /*
         * The pin arrived before the source did, so it has to be visible before there is
         * anything else on the screen: somebody who pressed "start an import pinned to this"
         * in ⌘K is now looking at an empty box, and without this line the pin is invisible
         * until step 2 and indistinguishable from having been dropped.
         */
        <Callout tone="info" className="mb-3.5" data-testid="wizard-pinned">
          Pinned to MusicBrainz release <code className="font-mono text-2xs">{pin}</code>. Paste the
          YouTube link below and the mapping will be computed against that release&rsquo;s
          tracklist.
        </Callout>
      )}
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
              {busy ? "Reading the source…" : "Paste a link above to see what we find on YouTube."}
            </div>
          ) : (
            <section className="overflow-hidden rounded-xl border border-line bg-surface-1">
              <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
                <h2 className="text-sm font-semibold">What we found on YouTube</h2>
                <span className="text-xs text-fg-2" data-testid="source-count">
                  {source.videos.length} {source.videos.length === 1 ? "video" : "videos"} ·{" "}
                  {mmss(source.totalSeconds)} total
                </span>
              </header>
              <div className="px-3.5 py-3">
                <div className="flex items-start gap-3.5">
                  <Cover
                    size="lg"
                    src={source.thumbnail}
                    seed={source.importId}
                    label={source.title ?? source.url}
                  />
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
                              {source.hints.artist ?? "not found"}{" "}
                              <ToneBadge tone="ok">from the YouTube tags</ToneBadge>
                            </>
                          ),
                        },
                        {
                          label: "Parsed album",
                          value: (
                            <>
                              {source.hints.album ?? "not found"}{" "}
                              <ToneBadge tone="ok">from the YouTube tags</ToneBadge>
                            </>
                          ),
                        },
                        {
                          label: "Year",
                          value: (
                            <>
                              {source.hints.year ?? "not found"}{" "}
                              {source.hints.releasedOn === null ? null : (
                                <ToneBadge tone="info">
                                  <Copyright className="size-3" aria-hidden="true" /> Released on
                                </ToneBadge>
                              )}
                            </>
                          ),
                        },
                        {
                          label: "Label",
                          value: (
                            <>
                              {source.hints.label ?? "not found"}{" "}
                              {source.hints.label === null ? null : (
                                <ToneBadge tone="info">from “Provided to YouTube by”</ToneBadge>
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
                          <th className="px-2 py-1.5 text-left" colSpan={2}>
                            Video title
                          </th>
                          <th className="px-2 py-1.5 text-left">Track name on YouTube</th>
                          <th className="px-2 py-1.5 text-right">Duration</th>
                        </tr>
                      </thead>
                      <tbody>
                        {source.videos.map((video) => (
                          <tr key={video.id} className="border-t border-line">
                            <td className="px-2 py-1 text-right font-mono text-fg-3">
                              {video.index + 1}
                            </td>
                            <td className="py-1 pl-2">
                              <Cover
                                size="xs"
                                src={video.thumbnail}
                                seed={video.videoId}
                                label={video.title}
                              />
                            </td>
                            <td className="px-2 py-1">{video.title}</td>
                            <td className="px-2 py-1 text-fg-2">{video.ytTrack ?? "not tagged"}</td>
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
              {source.duplicates.length === 1 ? "time" : "times"}). Re-importing is allowed; it is
              how you pick up better metadata, and files already in the library are skipped unless
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

      <WizardActions>
        <span className="text-2xs text-fg-3">
          {source === null ? "Paste a link to begin." : "Nothing is downloaded yet."}
        </span>
        <Button data-testid="wizard-next" disabled={source === null || busy} onClick={onContinue}>
          Find on MusicBrainz <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </WizardActions>
    </>
  );
}

/* ================================================================== */
/* step 2                                                              */
/* ================================================================== */

/**
 * "MusicBrainz is unavailable (HTTP 503) — retry", inside step 2 rather than instead of it.
 *
 * This is the local half of the fix for 2026-09-08 (decision 165). The shared `errorComponent`
 * on `_app.tsx` is the net that catches everything; this is the step saying *"I asked, they
 * said no, here is the button"* without the page moving. `router.invalidate()` re-runs the
 * loader in place, so the import, the step and the chosen release in the URL are all still
 * there when the answer comes back — and if candidates are on screen underneath, they stay on
 * screen while it is pressed.
 */
function SourceUnavailable({
  failure,
  cached,
}: {
  readonly failure: DegradedSource;
  readonly cached: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const label =
    failure.status === null
      ? "MusicBrainz is unavailable"
      : `MusicBrainz is unavailable (HTTP ${String(failure.status)})`;

  return (
    <Callout tone="danger" className="mb-3.5" role="alert" data-testid="mb-unavailable">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <b data-testid="mb-unavailable-label">{label}</b> — {failure.message}
          <div className="mt-0.5 text-2xs">
            {failure.hint ??
              "The service is having trouble; this is usually temporary and nothing has been lost."}{" "}
            {cached
              ? "The candidates below came out of the cache, so they may be out of date."
              : "Your source, your place in the wizard and your chosen release are still in the address bar."}
          </div>
        </div>
        <Button
          size="sm"
          data-testid="mb-retry"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void router.invalidate().finally(() => {
              setBusy(false);
            });
          }}
        >
          <RefreshCw className={cn("size-4", busy && "animate-spin")} aria-hidden="true" />
          Retry
        </Button>
      </div>
    </Callout>
  );
}

function StepMatch({
  source,
  candidates,
  failure,
  busy,
  selected,
  borrow,
  onSelect,
  onBorrow,
  onSearch,
  onResolveRef,
  onApplyRef,
  onBack,
  onContinue,
  onSkipMusicBrainz,
}: {
  readonly source: SourceView | null;
  readonly candidates: CandidatesView | null;
  /** Set when MusicBrainz refused: the step stays, with a banner and a Retry. */
  readonly failure: DegradedSource | null;
  readonly busy: boolean;
  readonly selected: string | null;
  readonly borrow: string | null;
  readonly onSelect: (id: string) => void;
  readonly onBorrow: (releaseMbid: string) => void;
  readonly onSearch: (title: string, artist: string) => Promise<SearchResultView | null>;
  /** One gated lookup that writes nothing: "what is this id?", asked as it is typed. */
  readonly onResolveRef: (input: string) => Promise<ResolvedRef | null>;
  readonly onApplyRef: (
    input: string,
  ) => Promise<{ view: SearchResultView; selectId: string | null } | null>;
  readonly onBack: () => void;
  readonly onContinue: () => void;
  readonly onSkipMusicBrainz: () => void;
}) {
  const [manual, setManual] = useState<SearchResultView | null>(null);
  /**
   * The id somebody named, rather than chose from the list.
   *
   * It outranks the ranking — the card wears `chosen by id`, goes to the **top** of the list
   * and is scrolled to. A hand-supplied candidate used to be appended at the bottom, under four
   * irrelevant ones and off screen, which is how the owner came to believe that pasting a valid
   * id had done nothing at all.
   */
  const [handPicked, setHandPicked] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  const single = candidates?.kind === "single";
  const preselected =
    candidates === null
      ? null
      : ([...candidates.releases, ...candidates.recordings].find((entry) => entry.preselected) ??
        null);

  /*
   * A manual search (or a pasted MBID) is scored on its own, so its first result comes back
   * flagged `preselected` — which would paint a second "preselected" badge on a card the
   * algorithm never proposed, next to the one it did. The preselection belongs to the original
   * ranking; a card added by hand is only ever an extra choice.
   */
  function merge<T extends { readonly id: string; readonly preselected: boolean }>(
    ranked: readonly T[],
    found: readonly T[],
  ): T[] {
    const extra = found
      .filter((entry) => !ranked.some((known) => known.id === entry.id))
      .map((entry) => (entry.preselected ? { ...entry, preselected: false } : entry));
    return promote([...ranked, ...extra]);
  }

  /**
   * The hand-picked entry first, whatever its score.
   *
   * The score still shows, honestly — a candidate somebody named may well score 20 %, and that
   * is information rather than a contradiction. What must not happen is the ranking burying it
   * at the bottom of a list nobody scrolls, which is exactly what the previous `[...ranked,
   * ...extra]` did. A card already in the list is *promoted* rather than duplicated.
   */
  function promote<T extends { readonly id: string }>(entries: readonly T[]): T[] {
    if (handPicked === null) return [...entries];
    const index = entries.findIndex((entry) => entry.id === handPicked);
    if (index <= 0) return [...entries];
    const chosen = entries[index];
    if (chosen === undefined) return [...entries];
    return [chosen, ...entries.filter((_, at) => at !== index)];
  }

  // DRIVE-1 §B2: the single branch rendered `candidates.recordings` and dropped the manual
  // results on the floor, so the search box and the MBID field were visible and inert on the
  // one screen where the matcher had just proposed a cover.
  const recordings = merge(candidates?.recordings ?? [], manual?.recordings ?? []);

  /*
   * The album path renders release **groups** (decision 151).
   *
   * A hand search comes back grouped too, so the two sources merge on group identity rather
   * than on release identity: searching "Bad Ideas" when the 2019 album is already proposed
   * must add its *pressings* to the group that is already on screen, not a second card with
   * the same name underneath the first one.
   */
  const groups = mergeGroups(candidates?.groups ?? [], manual?.groups ?? []);

  /**
   * Merge a hand search into the proposed groups, on group identity.
   *
   * Same rule as `merge`: nothing found by hand may wear the "preselected" flag, because the
   * preselection belongs to the ranking the engine produced. A release the ranking already
   * holds is kept as the ranking scored it — the search scores it in isolation, without the
   * budget the match spent, so its number would be the *less* informed of the two.
   */
  function mergeGroups(
    ranked: readonly ReleaseGroupCandidate[],
    found: readonly ReleaseGroupCandidate[],
  ): ReleaseGroupCandidate[] {
    const byId = new Map(ranked.map((entry) => [entry.id ?? "", entry]));
    for (const entry of found) {
      const key = entry.id ?? "";
      const known = byId.get(key);
      if (known === undefined) {
        byId.set(key, { ...entry, preselected: false });
        continue;
      }
      const extra = entry.releases.filter(
        (release) => !known.releases.some((seen) => seen.id === release.id),
      );
      if (extra.length === 0) continue;
      byId.set(key, { ...known, releases: [...known.releases, ...extra] });
    }
    /*
     * The group *holding* the hand-picked release comes first, for the same reason the card
     * does on the single path: the album list is made of groups, and the release somebody named
     * lives inside one of them.
     */
    const all = [...byId.values()];
    if (handPicked === null) return all;
    const index = all.findIndex((entry) =>
      entry.releases.some((release) => release.id === handPicked),
    );
    if (index <= 0) return all;
    const chosen = all[index];
    if (chosen === undefined) return all;
    return [chosen, ...all.filter((_, at) => at !== index)];
  }

  const runSearch = async (title: string, artist: string): Promise<void> => {
    // Either field alone is a search; only both empty is nothing to ask.
    if (title.trim() === "" && artist.trim() === "") return;
    const found = await onSearch(title, artist);
    setManual(found);
    setHandPicked(null);
  };

  /**
   * Take what the preview offered: put the candidate in the list, at the top, selected, and
   * scroll to it.
   *
   * The scroll and the announcement are the same statement made twice, for the two ways of
   * reading the page. Without them the list is *correct* and the person is still looking at
   * whatever was on screen before.
   */
  const applyRef = async (input: string): Promise<void> => {
    const result = await onApplyRef(input);
    if (result === null) return;
    setManual(result.view);
    if (result.selectId === null) return;
    setHandPicked(result.selectId);
    onSelect(result.selectId);
    const named =
      result.view.recordings.find((entry) => entry.id === result.selectId)?.title ??
      result.view.releases.find((entry) => entry.id === result.selectId)?.title ??
      "it";
    setAnnouncement(`${named} added at the top of the list and selected.`);
  };

  /*
   * Scroll to the hand-picked card once it is actually rendered.
   *
   * After the state change, not inside the handler: the card does not exist yet when `applyRef`
   * returns, and `scrollIntoView` on an element that is not there is the silent no-op that made
   * the first attempt at this look like it worked.
   */
  useEffect(() => {
    if (handPicked === null) return;
    const card = listRef.current?.querySelector(`[data-candidate-id="${handPicked}"]`);
    card?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [handPicked, manual]);

  return (
    <>
      {failure === null ? null : (
        <SourceUnavailable failure={failure} cached={candidates !== null} />
      )}
      {/*
        The degraded case is the *other* one: MusicBrainz refused, but the raw cache had every
        document this ranking needed, so there is a real list on screen that simply might be
        old. Saying so is the whole difference between a stale list and a wrong one.
      */}
      {candidates?.degraded == null ? null : (
        <Callout tone="warn" className="mb-3.5" data-testid="mb-degraded">
          <b>
            MusicBrainz is unavailable
            {candidates.degraded.status === null
              ? ""
              : ` (HTTP ${String(candidates.degraded.status)})`}
            .
          </b>{" "}
          These candidates were rebuilt from what is already cached, so nothing new was asked for.
          Reload the step once the service answers again to re-score them.
        </Callout>
      )}
      {candidates === null ? (
        <div
          className="flex flex-col items-center gap-3.5 rounded-xl border border-dashed border-line-strong px-6 py-16 text-center text-fg-2"
          data-testid="no-candidates"
        >
          {failure === null
            ? "No candidates yet."
            : "No candidates yet — and nothing cached for this import to fall back on. Retry above, or import from the YouTube tags alone."}
          {failure === null ? null : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              data-testid="import-without-mb"
              onClick={onSkipMusicBrainz}
            >
              Import without MusicBrainz
            </Button>
          )}
        </div>
      ) : (
        <>
          <Callout tone="info" className="mb-3.5" data-testid="preselection">
            <b>
              {preselected === null
                ? "Nothing scored high enough to propose."
                : `Preselected: ${preselected.title}, scored ${pct(preselected.score)}.`}
            </b>{" "}
            <span data-testid="budget">
              {candidates.budget.searches} of {candidates.planned.searches} search
              {candidates.planned.searches === 1 ? "" : "es"} and {candidates.budget.lookups} of{" "}
              {candidates.planned.lookups} tracklist lookup
              {candidates.planned.lookups === 1 ? "" : "s"} against MusicBrainz
            </span>
            {single ? null : (
              <>
                {" "}
                — one for the release <b>groups</b>, then one per group kept, then the tracklists
              </>
            )}
            . You pick; the algorithm only orders. Open <em>why?</em> on any card for the signals
            behind its score.{" "}
            {/*
              A8 of the owner review, in one sentence: the tracklist fit is *already* what
              ordered this list, so "the release is chosen from the tracks, but the mapping
              comes after" is answered on the card rather than a step later. D3 of the third
              review adds the other half — the fit is a fraction of the *release*, and on its
              own a one-track single fits 1/1 while importing one video out of eleven.
            */}
            <span data-testid="fit-explainer">
              The <b>fit</b> next to each score is that candidate's tracklist already matched
              against your videos, one by one, which is what separates two pressings of the same
              record; <b>covers</b> underneath it is the other direction — how many of your videos
              that release would actually import. Open <em>tracklist fit</em> to read it line by
              line; step 3 is where you change it.
            </span>
            {candidates.ambiguous ? (
              <>
                {" "}
                <b>Two candidates are within {candidates.margin?.toFixed(3) ?? "?"}</b> and would
                not import the same tracks, which is worth a look.
              </>
            ) : null}
          </Callout>

          <MbSearchPanel
            single={single}
            busy={busy}
            defaultTitle={source?.hints.album ?? source?.videos[0]?.title ?? ""}
            defaultArtist={source?.hints.artist ?? source?.uploader ?? ""}
            onResolve={onResolveRef}
            onApply={applyRef}
            onSearch={runSearch}
            terms={manual?.terms ?? null}
            empty={manual !== null && manual.releases.length + manual.recordings.length === 0}
          />

          {/*
            The same statement the scroll makes, for the reader who is not watching the list.
            Off screen, polite, and replaced rather than appended, so it announces the last
            thing that happened and not a transcript of the session.
          */}
          <span className="sr-only" role="status" aria-live="polite" data-testid="candidate-live">
            {announcement}
          </span>

          <div
            className="flex flex-col gap-2.5"
            data-testid="candidate-list"
            ref={listRef}
            role="radiogroup"
            aria-label={single ? "Recordings" : "Release groups"}
          >
            {single
              ? recordings.map((candidate) => (
                  <RecordingCandidateCard
                    key={candidate.id}
                    candidate={candidate}
                    selected={selected === candidate.id}
                    byHand={handPicked === candidate.id}
                    onSelect={onSelect}
                    borrow={borrow}
                    onBorrow={onBorrow}
                    filing={candidates?.filing ?? null}
                    videoSeconds={source?.videos[0]?.durationSeconds ?? null}
                  />
                ))
              : groups.map((entry, index) => (
                  <ReleaseGroupCard
                    key={entry.id ?? `ungrouped-${String(index)}`}
                    group={entry}
                    selected={selected}
                    byHand={handPicked}
                    onSelect={onSelect}
                    defaultOpen={index === 0}
                  />
                ))}
          </div>

          <Callout className="mt-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/*
                Rewritten against the box above, which now takes any MusicBrainz id or link and
                says what it is before you press anything. The old copy promised a *recording*
                MBID field that refused every other kind, and it was cut off on screen because
                it ran to five lines inside a row that also held a button.
              */}
              <div className="min-w-0 basis-96">
                Still nothing? Paste any MusicBrainz id or link above — a{" "}
                {single ? "recording, a release or a release group" : "release or a release group"}{" "}
                — and it is resolved to what this step needs. If MusicBrainz genuinely does not have
                this (a live set, a bootleg, an unregistered artist), import it from the YouTube
                tags alone: the album is flagged <b>untagged</b> in the library, with its own filter
                on the Quality page, so it can be finished the day a release appears.
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

      <WizardActions>
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-next" disabled={selected === null || busy} onClick={onContinue}>
          {candidates?.kind === "single" ? "Options" : "Map tracks"}{" "}
          <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </WizardActions>
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
  onAutoAssign,
  onByPosition,
  onClearAll,
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
  /** Throw away every edit and go back to what the matcher proposed. */
  readonly onAutoAssign: () => void;
  /** Video 1 to track 1, video 2 to track 2 — the fallback for a shuffled tracklist. */
  readonly onByPosition: () => void;
  /** Unbind everything: every video becomes an extra, and none is downloaded. */
  readonly onClearAll: () => void;
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
          mean |Δ| {mapping.meanAbsDelta === null ? "n/a" : `${mapping.meanAbsDelta.toFixed(1)}s`}
        </span>
      </div>

      {/*
        The group actions of the prototype's step 3. Fifteen rows and no way to undo a wrong
        idea except fifteen dropdowns was the gap; none of these submits anything.
      */}
      <div className="mb-2 flex flex-wrap items-center gap-2" data-testid="mapping-bulk">
        <span className="text-2xs text-fg-2">Apply to every row:</span>
        <Button variant="outline" size="xs" disabled={busy} onClick={onAutoAssign}>
          <Sparkles className="size-3.5" aria-hidden="true" /> Auto-assign
        </Button>
        <Button variant="outline" size="xs" disabled={busy} onClick={onByPosition}>
          By position
        </Button>
        <Button variant="outline" size="xs" disabled={busy} onClick={onClearAll}>
          Clear all
        </Button>
        <span className="text-2xs text-fg-3">
          Auto-assign restores the matcher's proposal; Clear all makes every video an extra.
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

      <WizardActions>
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-next" disabled={bound === 0 || busy} onClick={onContinue}>
          Options <ArrowRight className="size-4" aria-hidden="true" />
        </Button>
      </WizardActions>
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
  year,
  firstTrack,
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
  /** The year of the folder name. A single takes it from the release it borrows from. */
  readonly year: number | null;
  /** The file the destination preview names. A single's is its recording, at its borrowed
   *  track number; an album's is the release's first track. */
  readonly firstTrack: { readonly position: number; readonly title: string } | null;
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
  const folder = `${releaseArtist === "" ? "Unknown Artist" : releaseArtist}/${
    releaseTitle === "" ? "Unknown Album" : releaseTitle
  }${year === null ? "" : ` (${String(year)})`}`;
  const preview = firstTrack ?? mapping?.tracks[0] ?? null;

  return (
    <>
      {untagged ? (
        <Callout tone="warn" className="mb-3.5" data-testid="untagged-notice">
          <b>Importing without MusicBrainz.</b> The tags will come from the YouTube metadata alone
          (title, artist, album, year), so there will be no identifiers, no credits, no release date
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
              {/*
                The archive's front when a release was chosen, the YouTube thumbnail when it
                was not — the same order `docs/03` §4 gives the real cover pipeline, so the
                picture here is the picture the album will end up with.
              */}
              <Cover
                size="lg"
                src={coverArtFront(mapping?.releaseMbid) ?? source?.thumbnail}
                seed={mapping?.releaseMbid ?? ""}
                label={releaseTitle}
              />
              <KeyValueList
                className="flex-1"
                items={[
                  {
                    label: "Source",
                    value: <span className="font-mono text-2xs">{source?.url ?? "none"}</span>,
                  },
                  {
                    label: "Release",
                    value: `${releaseTitle} by ${releaseArtist}${year === null ? "" : ` (${String(year)})`}`,
                  },
                  {
                    label: "Tracks",
                    value: (
                      <span data-testid="summary-tracks">
                        {bound} bound, {extras} extra skipped, {uncovered} uncovered
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
                  { label: "Pace", value: "one download at a time, 5 to 15 seconds apart" },
                ]}
              />
            </div>
          </section>

          <section className="rounded-xl border border-line bg-surface-1">
            <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
              <h2 className="text-sm font-semibold">Destination preview</h2>
              <span className="text-2xs text-fg-2">template from Settings, Library</span>
            </header>
            <div className="flex flex-col gap-1.5 px-3.5 py-3">
              <div className="rounded-md border border-dashed border-line-strong bg-background px-2.5 py-2 font-mono text-2xs text-fg-1">
                {folder}/
                <b className="font-medium text-primary" data-testid="destination-preview">
                  {String(preview?.position ?? 1).padStart(2, "0")} -{" "}
                  {preview?.title ?? source?.videos[0]?.title ?? "…"}
                </b>
                .opus
              </div>
              <p className="text-2xs text-fg-3">
                Native codec kept: opus from YouTube, never re-encoded. Cover embedded, sidecar
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
                help="AcoustID after download; pauses in Review on a mismatch"
                checked={options.fingerprint}
                onChange={(value) => {
                  setOptions({ ...options, fingerprint: value });
                }}
              />
              <Toggle
                testId="option-lyrics"
                label="Fetch synced lyrics"
                help="From LRCLIB, embedded and written as a .lrc file"
                checked={options.lyrics}
                onChange={(value) => {
                  setOptions({ ...options, lyrics: value });
                }}
              />
              <Toggle
                testId="option-replaygain"
                label="ReplayGain (track + album)"
                help="Measured once every track of the album is in"
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

      <WizardActions>
        <Button variant="ghost" onClick={onBack}>
          <ChevronLeft className="size-4" aria-hidden="true" /> Back
        </Button>
        <Button data-testid="wizard-start" disabled={busy || bound === 0} onClick={onStart}>
          <Play className="size-4" aria-hidden="true" />
          {busy ? "Starting…" : "Start import"}
        </Button>
      </WizardActions>
    </>
  );
}
