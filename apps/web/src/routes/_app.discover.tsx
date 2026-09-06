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
import { PageHeader } from "#/components/page-header.tsx";
import { ScoreBar } from "#/components/score-bar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { short, timeAgo } from "#/lib/format.ts";
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

export const Route = createFileRoute("/_app/discover")({
  loader: async (): Promise<DiscoverView> => await fetchDiscover(),
  staticData: { crumbs: [{ label: "Discover" }] },
  component: Discover,
});

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
  const [busy, setBusy] = useState<string | null>(null);

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

  const dismiss = (item: DiscoverItemView): void => {
    setBusy(item.id);
    void dismissDiscoverItem({ data: { itemId: item.id } }).then(() => {
      setBusy(null);
      toast(`Hidden — ${item.title} will not be suggested again.`, "ok");
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

  const blocked = !hydrated || busy !== null;
  const signals = view.signals;
  const synced = view.lastSync !== null;

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
            {synced
              ? `last sync ${timeAgo(view.lastSync?.at)} · window ${String(signals.windowDays)} days`
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
        at step 2 with the release preselected — same candidates, same mapping, same confirmation as
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
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-1">
            {view.recommendations.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                blocked={blocked}
                busy={busy === item.id}
                wide
                onImport={importItem}
                onDismiss={dismiss}
                onLater={postpone}
              />
            ))}
          </div>
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
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{item.title}</div>
                    <div className="truncate text-2xs text-fg-3">{item.reason}</div>
                  </div>
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
      {synced ? what : "Nothing has been computed yet — press “Sync now”."}
    </div>
  );
}

/** One proposal, in either block. The reason is on the left, where it is read first. */
function ItemRow({
  item,
  blocked,
  busy,
  wide = false,
  onImport,
  onDismiss,
  onLater,
}: {
  item: DiscoverItemView;
  blocked: boolean;
  busy: boolean;
  wide?: boolean;
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
      <div className="min-w-0 grow">
        <div className="truncate">
          <span className="font-medium">{item.title}</span>
          <span className="text-fg-2"> — {item.artist}</span>
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
      {item.inLibrary ? (
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
        {item.status === "later" ? null : (
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
