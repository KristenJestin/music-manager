/**
 * `/discover` — recommendations that become imports.
 *
 * Three blocks, in the order the prototype fixes and for a reason: what you already half-own
 * (no external dependency, always works), what ListenBrainz thinks (needs an account), and who
 * else sounds like this (the widest net, the weakest signal). A reader who has configured
 * nothing still sees the first block and an honest empty state for the other two.
 *
 * Every card carries **the reason before the score**. The bar is there to sort by; the sentence
 * is there to disagree with, which is decision 002 rendered in a list: the algorithm proposes
 * and explains, it never chooses. The three actions are equally deliberate — Import is the only
 * one that starts anything, "Not interested" is remembered for ever, and "Later" only sinks the
 * row. Nothing on this page can delete or download without the wizard in between.
 */
import { useState } from "react";
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { z } from "zod";
import {
  Disc3,
  Download,
  Inbox as InboxIcon,
  Music4,
  RefreshCw,
  Search,
  Sparkles,
  Users,
  ListMusic,
} from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { Cover } from "#/components/cover.tsx";
import { FilterChips } from "#/components/library/filter-chips.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { PlayButton } from "#/components/play-button.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { usePlayer } from "#/components/shell/player-context.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  Skeleton,
  SkeletonBadge,
  SkeletonCard,
  SkeletonLine,
  SkeletonPage,
  SkeletonPageHeader,
} from "#/components/skeleton.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { dateTime, short, timeAgo } from "#/lib/format.ts";
import type { DiscoverItemView, DiscoverView } from "#/server/services/discover.ts";
import {
  addArtistDiscography,
  dismissDiscoverItem,
  discoverImport,
  fetchDiscover,
  forgetDiscoverDismissals,
  postponeDiscoverItem,
  runDiscoverSync,
} from "#/server/functions/discover.ts";
import { resolvePreview } from "#/server/functions/player.ts";

/**
 * Which half of "Recommended for you" is on screen.
 *
 * In the URL, like every other filter in this Console (`/library?filter=incomplete`), and for
 * the same reasons: a tab is a link you can send someone, the back button means what it looks
 * like, and a reload does not silently drop you back on the default.
 */
const RECOMMENDED_TABS = ["to-import", "in-library"] as const;
type RecommendedTab = (typeof RECOMMENDED_TABS)[number];

const search = z.object({ recommended: z.enum(RECOMMENDED_TABS).default("to-import") });

export const Route = createFileRoute("/_app/discover")({
  validateSearch: search,
  loader: async (): Promise<DiscoverView> => await fetchDiscover(),
  staticData: { crumbs: [{ label: "Discover" }] },
  component: Discover,
  pendingComponent: DiscoverPending,
});

/**
 * Discover's four blocks in their real order: listening signals, then the discography gaps at
 * `xl:grid-cols-2`, the recommendation list, and the similar-artist cards at
 * `sm:grid-cols-2 xl:grid-cols-4`. Each section keeps its own heading line, because the three
 * headings are what tell you *which* block is still loading.
 */
function DiscoverPending() {
  return (
    <SkeletonPage name="discover" label="Loading recommendations…">
      <SkeletonPageHeader actions={2} />

      <SkeletonCard className="mb-4" bodyClassName="flex flex-col gap-3 px-4 py-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} tone="plate" className="h-12 w-full rounded-md" />
          ))}
        </div>
        <Skeleton tone="plate" className="h-6 w-full rounded-md" />
      </SkeletonCard>

      <section className="mb-6">
        <SkeletonSectionHeading />
        <div className="grid gap-3 xl:grid-cols-2">
          {Array.from({ length: 2 }, (_, index) => (
            <SkeletonCard key={index} bodyClassName="p-0">
              <SkeletonDiscoverRows rows={3} />
            </SkeletonCard>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <SkeletonSectionHeading />
        <div className="mb-3 flex gap-1.5">
          <Skeleton tone="plate" className="h-6 w-28 rounded-lg" />
          <Skeleton tone="plate" className="h-6 w-32 rounded-lg" />
        </div>
        <div className="rounded-xl border border-line bg-surface-1">
          <SkeletonDiscoverRows rows={5} />
        </div>
      </section>

      <section>
        <SkeletonSectionHeading />
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-xl border border-line bg-surface-1 p-3"
            >
              <div className="flex items-center gap-2">
                <Skeleton tone="plate" className="size-9 shrink-0 rounded-sm" />
                <div className="flex min-w-0 grow flex-col">
                  <SkeletonLine text="xs" bar="h-3" width="w-3/4" />
                  <SkeletonLine text="2xs" bar="h-2.5" width="w-1/2" />
                </div>
              </div>
              <Skeleton className="h-1 w-scorebar rounded-sm" />
              <div className="flex items-center justify-between gap-2">
                <SkeletonBadge width="w-20" />
                <Skeleton tone="plate" className="h-6 w-32 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      </section>
    </SkeletonPage>
  );
}

/** `SectionHeading`: the icon, the title, and the sentence explaining where the block comes from. */
function SkeletonSectionHeading() {
  return (
    <div className="mb-2 flex items-center gap-2">
      <Skeleton tone="plate" className="size-4 rounded-sm" />
      <SkeletonLine text="sm" bar="h-3" width="w-48" />
      <SkeletonLine text="2xs" bar="h-2.5" width="w-64" />
    </div>
  );
}

/** `ItemRow`: the title and reason on the left, the play button and three actions on the right. */
function SkeletonDiscoverRows({ rows }: { readonly rows: number }) {
  return (
    <div className="divide-y divide-line">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex min-w-0 grow flex-col">
            <SkeletonLine text="xs" bar="h-3" width="w-1/2" />
            <SkeletonLine text="2xs" bar="h-2.5" width="w-1/3" />
          </div>
          <Skeleton tone="plate" className="size-6 shrink-0 rounded-md" />
          <Skeleton tone="plate" className="h-6 w-20 shrink-0 rounded-lg" />
          <Skeleton tone="plate" className="h-6 w-16 shrink-0 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

const SOURCE_TONE = {
  ok: "ok",
  fallback: "info",
  off: "muted",
  error: "danger",
} as const;

function Discover() {
  const view = Route.useLoaderData();
  const navigate = useNavigate();
  const toast = useToast();
  const hydrated = useHydrated();
  const player = usePlayer();
  const [busy, setBusy] = useState<string | null>(null);
  /** The subject a preview is being looked up for, so one card spins and the rest do not. */
  const [listening, setListening] = useState<string | null>(null);
  /**
   * Subjects we have already asked about and got nothing for, with the reason.
   *
   * Remembered for the life of the page so a second click does not spend a second Deezer
   * search to learn the same "no", and so the button can turn itself off and say why.
   */
  const [silent, setSilent] = useState<Readonly<Record<string, string>>>({});
  /**
   * Which subject the player's current queue came from.
   *
   * The queue holds Deezer track ids, which say nothing about the MusicBrainz subject that
   * produced them, so the page remembers the link itself. That is what lets a card show a
   * pause glyph instead of offering to start the same clip again.
   */
  const [playingSubject, setPlayingSubject] = useState<string | null>(null);

  const reload = (): void => {
    void navigate({ to: "/discover", replace: true });
  };

  const fail = (error: unknown): void => {
    setBusy(null);
    toast(error instanceof Error ? error.message : "Something went wrong.", "danger");
  };

  const sync = (): void => {
    setBusy("sync");
    toast("Syncing: Navidrome play counts, ListenBrainz, Last.fm…", "info");
    void runDiscoverSync().then((report) => {
      setBusy(null);
      if (report.status === "failed") {
        toast(report.error ?? "The sync failed.", "danger");
        return;
      }
      toast(
        `${String(report.discography)} gaps · ${String(report.recommendations)} recommendations · ${String(report.similarArtists)} similar artists`,
        "ok",
      );
      reload();
    }, fail);
  };

  /* Import: the wizard opens at step 2 with the release Discover meant already selected. */
  const importItem = (item: DiscoverItemView): void => {
    setBusy(item.id);
    void discoverImport({ data: { itemId: item.id } }).then((target) => {
      setBusy(null);
      toast(target.label, target.found ? "ok" : "warn");
      void navigate({
        to: "/import/new",
        search: {
          importId: target.importId,
          step: target.step,
          ...(target.release === null ? {} : { release: target.release }),
        },
      });
    }, fail);
  };

  /**
   * Listen to a suggestion before deciding to import it.
   *
   * The server prefers our own file when we already own the recording, so a row marked "in
   * library" plays full length; everything else is a thirty-second Deezer clip, and the bar
   * says which. Nothing to play is a warning toast and a button that turns itself off with the
   * reason in its tooltip — it is not an error, Deezer simply does not have everything.
   */
  const listen = (item: DiscoverItemView): void => {
    if (player.current !== null && playingSubject === item.subject) {
      player.toggle();
      return;
    }
    setListening(item.subject);
    void resolvePreview({ data: { subject: item.subject } }).then((answer) => {
      setListening(null);
      if (answer.tracks.length === 0) {
        const reason = answer.reason ?? "Nothing to play for this one.";
        setSilent((held) => ({ ...held, [item.subject]: reason }));
        toast(reason, "warn");
        return;
      }
      setPlayingSubject(item.subject);
      player.play(answer.tracks, 0);
    }, fail);
  };

  const dismiss = (item: DiscoverItemView): void => {
    setBusy(item.id);
    void dismissDiscoverItem({ data: { itemId: item.id } }).then(() => {
      setBusy(null);
      toast(`Hidden: ${item.title} will not be suggested again.`, "ok");
      reload();
    }, fail);
  };

  const postpone = (item: DiscoverItemView): void => {
    setBusy(item.id);
    void postponeDiscoverItem({ data: { itemId: item.id } }).then(() => {
      setBusy(null);
      toast(`${item.title} moved to the bottom of the list.`, "ok");
      reload();
    }, fail);
  };

  const expand = (item: DiscoverItemView): void => {
    setBusy(item.id);
    void addArtistDiscography({ data: { itemId: item.id } }).then((result) => {
      setBusy(null);
      toast(
        result.added === 0
          ? `Nothing new: every ${result.artist} record is already listed.`
          : `${String(result.added)} ${result.artist} record(s) added to the discography block.`,
        "ok",
      );
      reload();
    }, fail);
  };

  /** Everything one card's play button needs, gathered in one place. */
  const playback = (item: DiscoverItemView): RowPlayback => ({
    active: playingSubject === item.subject && player.current !== null,
    playing: player.playing,
    busy: listening === item.subject,
    reason: silent[item.subject] ?? null,
    onPlay: () => {
      listen(item);
    },
  });

  const blocked = !hydrated || busy !== null;
  const signals = view.signals;
  const synced = view.lastSync !== null;

  /*
   * The two halves of the Recommended block, computed once and mutually exclusive by
   * construction: every recommendation is in exactly one of them, so the counts on the tabs
   * always add up to the number in the heading.
   */
  const tab: RecommendedTab = Route.useSearch().recommended;
  const toImport = view.recommendations.filter((item) => !item.inLibrary);
  const owned = view.recommendations.filter((item) => item.inLibrary);
  const shown = tab === "in-library" ? owned : toImport;

  return (
    <div data-testid="discover">
      <PageHeader
        title="Discover"
        description="Recommendations that become imports. Every suggestion is a MusicBrainz id, not a YouTube guess."
        actions={
          <>
            <Button
              variant="outline"
              disabled={blocked}
              onClick={sync}
              data-testid="discover-sync"
              title="Re-read Navidrome, ListenBrainz and Last.fm."
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
            <Button nativeButton={false} render={<Link to="/import/new" />}>
              <Download className="size-3.5" aria-hidden="true" /> Import from URL
            </Button>
          </>
        }
      />

      {/* ---------------- listening signals ---------------- */}
      <section
        className="mb-4 rounded-xl border border-line bg-surface-1"
        data-testid="discover-signals"
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="font-semibold">Listening signals</h2>
          <span className="text-2xs text-fg-3">
            {/*
             * The absolute instant until React has attached, the relative one after.
             *
             * "4 minutes ago" is computed from `Date.now()`, which is a different number on
             * the server and in the browser — the one class of value that hydrates as a text
             * mismatch and makes React throw away the tree. The instant itself is fixed, so
             * rendering it first is stable by construction, and `useHydrated` is the
             * sanctioned way to swap afterwards (it is what every form on this app uses to
             * know the same thing).
             */}
            {synced
              ? `last sync ${hydrated ? timeAgo(view.lastSync?.at) : dateTime(view.lastSync?.at)} · window ${String(signals.windowDays)} days`
              : "never synced"}
          </span>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {signals.sources.map((source) => (
              <div
                key={source.name}
                className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-2.5 py-2"
                data-testid={`signal-source-${source.name.toLowerCase()}`}
              >
                <ToneBadge tone={SOURCE_TONE[source.status]}>{source.status}</ToneBadge>
                <div className="min-w-0 grow">
                  <div className="truncate font-medium">{source.name}</div>
                  <div className="truncate text-2xs text-fg-3">{source.detail}</div>
                </div>
                <span className="shrink-0 font-mono text-2xs text-fg-2">{source.metric}</span>
              </div>
            ))}
          </div>

          {signals.topArtists.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-2xs text-fg-3">Most played</span>
              {signals.topArtists.slice(0, 8).map((artist) => (
                <span
                  key={artist.name}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line bg-surface-2 py-1 pr-2 pl-1"
                >
                  <Cover size="xs" seed={artist.mbid ?? artist.name} label={artist.name} />
                  <b className="font-medium">{artist.name}</b>
                  <span className="font-mono text-2xs text-fg-3">{artist.plays}×</span>
                </span>
              ))}
            </div>
          )}
          {signals.topGenres.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 shrink-0 text-2xs text-fg-3">Top genres</span>
              {signals.topGenres.slice(0, 8).map((genre) => (
                <span
                  key={genre.name}
                  className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-2xs"
                >
                  {genre.name} <span className="font-mono text-fg-3">{genre.plays}</span>
                </span>
              ))}
            </div>
          )}
          {signals.error === null ? null : (
            <Callout tone="warn" data-testid="discover-signals-error">
              Navidrome could not be read: {signals.error} The discography block still works from
              what is already in the library.
            </Callout>
          )}
        </div>
      </section>

      <Callout tone="info" className="mb-5">
        <b>Every item here is a MusicBrainz ID.</b> Import finds the album on YouTube Music
        (ytmusicapi) or the track by a duration-ranked YouTube search, then opens the normal wizard
        at step 2 with the release preselected, and the same candidates, mapping and confirmation as
        a pasted URL.
      </Callout>

      {view.inbox.length === 0 ? null : (
        <section className="mb-5" data-testid="discover-inbox">
          <SectionHeading
            icon={<InboxIcon className="size-4" aria-hidden="true" />}
            title="Incomplete albums"
            hint="Albums you own only part of. Re-importing fills the holes."
          />
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-1">
            {view.inbox.map((item) => (
              <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 grow">
                  <div className="truncate font-medium">{item.title}</div>
                  <div className="truncate text-2xs text-fg-3">{item.summary}</div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  nativeButton={false}
                  render={<Link to="/review" />}
                >
                  Open in Review
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---------------- 1. complete your discography ---------------- */}
      <section className="mb-6" data-testid="discover-discography">
        <SectionHeading
          icon={<Disc3 className="size-4" aria-hidden="true" />}
          title="Complete your discography"
          hint="MusicBrainz release-groups missing from your library, for the artists you actually play."
        />
        {view.discography.length === 0 ? (
          <Empty
            synced={synced}
            what="No gaps found. Either your shelves are complete, or nothing you play has a MusicBrainz artist id yet."
          />
        ) : (
          <div className="grid gap-3 xl:grid-cols-2">
            {view.discography.map((card) => (
              <div
                key={card.artistMbid ?? card.artist}
                className="rounded-xl border border-line bg-surface-1"
                data-testid="discography-card"
                data-artist={card.artist}
              >
                <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Cover size="sm" seed={card.artistMbid ?? card.artist} label={card.artist} />
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{card.artist}</div>
                      <div className="text-2xs text-fg-3">{card.plays} weighted plays</div>
                    </div>
                  </div>
                  <ToneBadge tone="warn">
                    you have {card.have} of {card.total}
                  </ToneBadge>
                </header>
                <div className="divide-y divide-line">
                  {card.missing.map((item) => (
                    <ItemRow
                      key={item.id}
                      item={item}
                      blocked={blocked}
                      busy={busy === item.id}
                      playback={playback(item)}
                      onImport={importItem}
                      onDismiss={dismiss}
                      onLater={postpone}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---------------- 2. recommended for you ---------------- */}
      <section className="mb-6" data-testid="discover-recommendations">
        <SectionHeading
          icon={<Sparkles className="size-4" aria-hidden="true" />}
          title="Recommended for you"
          hint={`ListenBrainz collaborative filtering over your scrobbles · ${String(view.recommendations.length)} suggestions`}
        />
        {view.recommendations.length === 0 ? (
          <Empty
            synced={synced}
            what="Nothing yet. Set a ListenBrainz user in Settings › Discover and scrobble from Navidrome, or leave it and use the discography block."
          />
        ) : (
          <>
            {/*
              Two views of one list, never both at once.

              The split is the same fact the badge used to carry — `inLibrary` — promoted to a
              filter, because the two halves answer different questions and want different
              buttons. "To import" is the recommendation proper. "In your library" is the
              other output of the same computation: it is what feeds the Navidrome
              "Recommended" playlist, and it exists so you can check what was pushed there.
            */}
            <FilterChips
              chips={[
                {
                  value: "to-import",
                  label: "To import",
                  count: toImport.length,
                  title: "Recommended, and not in your library yet.",
                },
                {
                  value: "in-library",
                  label: "In your library",
                  count: owned.length,
                  title:
                    "Recommended, and you already own it. These are what the Navidrome “Recommended” playlist is built from.",
                },
              ]}
              active={tab}
              link={(value) => ({ to: "/discover", search: { recommended: value } })}
              testId="discover-recommended-tab"
              // These two are not filter presets, they are the two halves of one list, and the
              // group says so rather than borrowing the default name.
              label="Which recommendations to show"
            />
            {shown.length === 0 ? (
              <Empty
                synced={synced}
                what={
                  tab === "to-import"
                    ? "Every recommendation is already in your library. Nothing to import from this block."
                    : "None of the recommendations is in your library yet. The Navidrome playlist is empty until one is."
                }
              />
            ) : (
              <div className="divide-y divide-line rounded-xl border border-line bg-surface-1">
                {shown.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    blocked={blocked}
                    busy={busy === item.id}
                    wide
                    owned={tab === "in-library"}
                    playback={playback(item)}
                    onImport={importItem}
                    onDismiss={dismiss}
                    onLater={postpone}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------- 3. similar artists ---------------- */}
      <section data-testid="discover-similar">
        <SectionHeading
          icon={<Users className="size-4" aria-hidden="true" />}
          title="Similar artists"
          hint="ListenBrainz similar-artists · Last.fm fallback when ListenBrainz has no data."
        />
        {view.similarArtists.length === 0 ? (
          <Empty synced={synced} what="No similar artists yet." />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {view.similarArtists.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-2 rounded-xl border border-line bg-surface-1 p-3"
                data-testid="similar-artist"
                data-artist={item.artist}
              >
                <div className="flex items-center gap-2">
                  <Cover size="sm" seed={item.artistMbid ?? item.artist} label={item.artist} />
                  <div className="min-w-0 grow">
                    <div className="truncate font-semibold">{item.title}</div>
                    <div className="truncate text-2xs text-fg-3">{item.reason}</div>
                  </div>
                  {/* An artist has no one track, so this queues what Deezer says they are
                      known for — which is exactly the question "do I like these people?". */}
                  <PlayButton
                    data-testid="discover-play"
                    active={playback(item).active}
                    playing={playback(item).playing}
                    busy={playback(item).busy}
                    disabled={playback(item).reason !== null}
                    label="Play their top tracks"
                    title={playback(item).reason ?? "Thirty-second Deezer clips, top tracks first."}
                    onPlay={playback(item).onPlay}
                  />
                </div>
                <ScoreBar value={item.score} />
                <div className="flex items-center justify-between gap-2">
                  {item.inLibrary ? (
                    <ToneBadge tone="ok">in library</ToneBadge>
                  ) : (
                    <ToneBadge tone="info">not in library</ToneBadge>
                  )}
                  <div className="flex gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={blocked || item.artistMbid === null}
                      onClick={() => {
                        expand(item);
                      }}
                      title="List their release-groups in the discography block. Never “everything by X”."
                    >
                      Add discography
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={blocked}
                      onClick={() => {
                        dismiss(item);
                      }}
                    >
                      Not interested
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {view.dismissedCount === 0 ? null : (
        <p className="mt-4 flex items-center gap-2 text-2xs text-fg-3">
          {view.dismissedCount} suggestion(s) hidden for good.
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked}
            data-testid="discover-forget"
            onClick={() => {
              setBusy("forget");
              void forgetDiscoverDismissals().then(() => {
                setBusy(null);
                toast("Every hidden suggestion may come back on the next sync.", "ok");
                reload();
              }, fail);
            }}
          >
            Show them again
          </Button>
        </p>
      )}
    </div>
  );
}

function SectionHeading({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="flex items-center gap-1.5 font-semibold">
        {icon}
        {title}
      </h2>
      <span className="text-2xs text-fg-3">{hint}</span>
    </div>
  );
}

function Empty({ synced, what }: { synced: boolean; what: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-fg-2">
      {synced ? what : "Nothing has been computed yet. Press “Sync now”."}
    </div>
  );
}

/** What one card needs in order to draw its play button and know what pressing it means. */
interface RowPlayback {
  /** True when the player's queue came from this item. */
  readonly active: boolean;
  readonly playing: boolean;
  /** A preview is being looked up for this item right now. */
  readonly busy: boolean;
  /** Why there is nothing to play, once we have asked and found out. */
  readonly reason: string | null;
  onPlay(): void;
}

/** One proposal, in either block. The reason is on the left, where it is read first. */
function ItemRow({
  item,
  blocked,
  busy,
  wide = false,
  owned = false,
  playback,
  onImport,
  onDismiss,
  onLater,
}: {
  item: DiscoverItemView;
  blocked: boolean;
  busy: boolean;
  wide?: boolean;
  /**
   * This row is being shown as something you already own.
   *
   * It removes Import rather than disabling it: there is nothing to import, and a greyed
   * button with a tooltip explaining why would be a worse way of saying so. What replaces it
   * is the thing you actually want from a record you have — a way to open it.
   */
  owned?: boolean;
  playback: RowPlayback;
  onImport: (item: DiscoverItemView) => void;
  onDismiss: (item: DiscoverItemView) => void;
  onLater: (item: DiscoverItemView) => void;
}) {
  const isTrack = item.payload["itemKind"] === "track";
  return (
    <div
      className="flex items-center gap-3 px-3 py-2"
      data-testid="discover-item"
      data-subject={item.subject}
      data-status={item.status}
    >
      <Cover size="sm" seed={item.subject} label={item.title} />
      {/*
        Listen before you import. It is the cheapest possible way to disagree with the
        algorithm, which is what decision 002 asks this page to make easy.
      */}
      <PlayButton
        data-testid="discover-play"
        active={playback.active}
        playing={playback.playing}
        busy={playback.busy}
        disabled={playback.reason !== null}
        label={item.inLibrary ? "Play from your library" : "Play a 30-second preview"}
        title={
          playback.reason ??
          (item.inLibrary
            ? "You own this: it plays in full, from your own file."
            : "A thirty-second Deezer clip, if there is one.")
        }
        onPlay={playback.onPlay}
      />
      <div className="min-w-0 grow">
        <div className="truncate">
          <span className="font-medium">{item.title}</span>
          <span className="text-fg-2"> by {item.artist}</span>
          {wide ? (
            <ToneBadge tone="muted" outline className="ml-1.5">
              {isTrack ? "track" : "album"}
            </ToneBadge>
          ) : null}
          {item.status === "later" ? (
            <ToneBadge tone="muted" className="ml-1.5">
              later
            </ToneBadge>
          ) : null}
        </div>
        <div className="truncate text-2xs text-fg-3">
          {item.year === null ? null : <span>{item.year} · </span>}
          {item.primaryType ?? (isTrack ? "Recording" : "Release group")}
          {item.secondaryTypes.length === 0 ? null : ` (${item.secondaryTypes.join(", ")})`} ·{" "}
          {item.reason} <span className="text-fg-3">· {item.source}</span>{" "}
          <span className="font-mono">
            {short(item.releaseGroupMbid ?? item.recordingMbid ?? item.subject)}
          </span>
        </div>
      </div>
      {wide ? <ScoreBar value={item.score} className="shrink-0" /> : null}
      {/* In the "In your library" tab the badge would repeat the tab it is under, on every
          single row. The tab is the statement; the badge is only needed where rows mix. */}
      {owned ? null : item.inLibrary ? (
        <ToneBadge tone="ok">in library</ToneBadge>
      ) : (
        <ToneBadge tone="info" title="Found by MusicBrainz id, not by a title guess.">
          {isTrack ? (
            <Music4 className="size-3" aria-hidden="true" />
          ) : (
            <ListMusic className="size-3" aria-hidden="true" />
          )}
          {isTrack ? "search" : "YT Music"}
        </ToneBadge>
      )}
      <div className="flex shrink-0 gap-1">
        {owned ? (
          item.libraryAlbumId === null ? null : (
            <Button
              size="xs"
              variant="outline"
              nativeButton={false}
              data-testid="discover-open-album"
              render={<Link to="/library/albums/$id" params={{ id: item.libraryAlbumId }} />}
            >
              <ListMusic className="size-3" aria-hidden="true" />
              Open album
            </Button>
          )
        ) : (
          <Button
            size="xs"
            disabled={blocked}
            data-testid="discover-import"
            onClick={() => {
              onImport(item);
            }}
          >
            {busy ? (
              <Search className="size-3 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-3" aria-hidden="true" />
            )}
            Import
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={blocked}
          data-testid="discover-dismiss"
          onClick={() => {
            onDismiss(item);
          }}
        >
          Not interested
        </Button>
        {/* "Later" only sinks a row down the list you are going to act on; there is nothing to
            postpone about a record you already have. */}
        {owned || item.status === "later" ? null : (
          <Button
            size="xs"
            variant="ghost"
            disabled={blocked}
            onClick={() => {
              onLater(item);
            }}
          >
            Later
          </Button>
        )}
      </div>
    </div>
  );
}
