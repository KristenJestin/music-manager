/**
 * The Review screen: the queue on the left, the open decision on the right.
 *
 * Answering an item moves to the next one without leaving the page, because a review queue you
 * have to navigate back to after every answer is a queue nobody empties.
 */
import { useState } from "react";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Inbox, SearchX } from "lucide-react";
import { cn } from "cn";
import { Cover } from "#/components/cover.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { Pager } from "#/components/pager.tsx";
import { ReviewCard } from "#/components/review-card.tsx";
import { ReviewToolbar } from "#/components/review-toolbar.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import {
  Skeleton,
  SkeletonBadge,
  SkeletonLine,
  SkeletonPage,
  SkeletonPageHeader,
} from "#/components/skeleton.tsx";
import { humanise } from "#/lib/format.ts";
import type { InboxSearch } from "#/lib/inbox-filters.ts";
import { TimeAgo } from "#/components/time-ago.tsx";
import {
  pinReleaseForItem,
  resolveItem,
  searchWithoutQualifier,
  type InboxListPayload,
  type InboxOption,
} from "#/server/functions/inbox.ts";

/**
 * The Review screen while `fetchInbox` runs.
 *
 * Here for the same reason `ReviewScreen` is: `/review` and `/review/:id` are one page opened
 * on a different item, and two skeletons for one layout would drift apart. It mirrors
 * `review-grid` — the 340 px queue on the left, the decision card on the right — so answering
 * an item, which navigates to the next one, never re-flows the column the cursor is in.
 *
 * The toolbar is rendered **for real**, from the URL alone, for the reason `/library`'s is:
 * not one of its controls depends on the loader, and replacing five working controls with grey
 * blocks on every click is what makes a page feel thrown away and rebuilt. The counts are the
 * one part that is still in flight, and they come in as `null`, which draws a dash in a slot
 * the right width.
 */
export function ReviewScreenSkeleton({ params }: { readonly params: InboxSearch }) {
  return (
    <SkeletonPage name="review" label="Loading the review queue…">
      <SkeletonPageHeader actions={0} />
      <ReviewToolbar params={params} byType={null} byStatus={null} />
      <div className="review-grid">
        <nav className="overflow-hidden rounded-xl border border-line bg-surface-1">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0"
            >
              <Skeleton tone="plate" className="size-9 shrink-0 rounded-sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <SkeletonLine text="xs" bar="h-3" width="w-3/4" />
                <SkeletonLine text="2xs" bar="h-2.5" width="w-1/2" />
              </span>
              <SkeletonBadge width="w-16" />
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-1 p-3.5">
          <div className="review-card-grid gap-3">
            <Skeleton tone="plate" className="aspect-square w-14 rounded-sm" />
            <div className="flex flex-col">
              <SkeletonLine text="base" bar="h-3.5" width="w-1/2" />
              <SkeletonLine text="sm" bar="h-3" width="w-3/4" />
            </div>
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} tone="plate" className="h-16 w-full rounded-lg" />
          ))}
          <div className="flex justify-end gap-2">
            <Skeleton tone="plate" className="h-8 w-24 rounded-lg" />
            <Skeleton tone="plate" className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}

export function ReviewScreen({
  payload,
  params,
}: {
  readonly payload: InboxListPayload;
  readonly params: InboxSearch;
}) {
  const { items, card, total, page, pageSize, byType, byStatus } = payload;
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const now = new Date();

  /** True when the queue is empty because of the filters rather than because it is empty. */
  const filtered = params.type !== undefined || params.q.trim() !== "" || params.status !== "open";

  /**
   * What every answer on this page does once the server has taken it: say so, move on.
   *
   * Three actions share it — accepting a decision, pinning a release, dropping an edition
   * qualifier — because all three end the same way, and a second copy of "invalidate, then
   * navigate to `nextId`" is how one of them quietly stops refreshing the queue.
   *
   * The filters travel with the navigation. Answering the fourth of forty edition decisions
   * has to land on the fifth, not on the whole unfiltered queue.
   */
  const advance = (message: string, nextId: string | null): void => {
    setBusy(false);
    toast(message, "ok");
    void router.invalidate();
    void router.navigate(
      nextId === null
        ? { to: "/review", search: params }
        : { to: "/review/$id", params: { id: nextId }, search: params },
    );
  };

  const failed = (error: unknown): void => {
    setBusy(false);
    toast(error instanceof Error ? error.message : "Could not save that.", "danger");
  };

  const confirm = (option: InboxOption): void => {
    if (card === null || busy) return;
    setBusy(true);
    void resolveItem({
      data: { id: card.item.id, choice: option.value, dismiss: option.dismiss ?? false },
    }).then((result) => {
      advance(
        result.resumed ? "Decision saved; the job resumes." : "Decision saved.",
        result.nextId,
      );
    }, failed);
  };

  const pin = (release: string): void => {
    if (card === null || busy) return;
    setBusy(true);
    void pinReleaseForItem({ data: { id: card.item.id, release } }).then((result) => {
      advance(`Pinned to “${result.pinned}”; the import is matching again.`, result.nextId);
    }, failed);
  };

  const dropQualifier = (): void => {
    if (card === null || busy) return;
    setBusy(true);
    void searchWithoutQualifier({ data: { id: card.item.id } }).then((result) => {
      advance(`Searching again for “${result.pinned}”.`, result.nextId);
    }, failed);
  };

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Decisions the matcher would not take on its own. Each item shows its preselected answer; Enter accepts it."
      />

      <ReviewToolbar params={params} byType={byType} byStatus={byStatus} />

      {items.length === 0 ? (
        <div
          data-testid="review-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface-1 px-6 py-16 text-center"
        >
          {filtered ? (
            <>
              <SearchX className="size-8 text-fg-3" aria-hidden="true" />
              {/* The distinction matters at three hundred items: "there is nothing left to
                  decide" and "nothing matches what you asked for" look identical and mean
                  opposite things. */}
              <p className="text-fg-1">No item matches these filters.</p>
            </>
          ) : (
            <>
              <Inbox className="size-8 text-fg-3" aria-hidden="true" />
              <p className="text-fg-1">Nothing to decide. The Inbox is empty.</p>
            </>
          )}
        </div>
      ) : (
        <div className="review-grid">
          <nav
            data-testid="review-list"
            aria-label="Open decisions"
            className="overflow-hidden rounded-xl border border-line bg-surface-1"
          >
            {items.map((item) => (
              <Link
                key={item.id}
                to="/review/$id"
                params={{ id: item.id }}
                search={params}
                className={cn(
                  "flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-surface-2",
                  card?.item.id === item.id && "bg-surface-3",
                )}
              >
                <Cover size="sm" seed={item.id} label={item.title} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.title}</span>
                  <span className="block truncate text-2xs text-fg-2">{item.summary ?? ""}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <ToneBadge tone="warn">{humanise(item.type)}</ToneBadge>
                  <TimeAgo at={item.createdAt} now={now} className="text-3xs text-fg-3" />
                </span>
              </Link>
            ))}
            {/*
              Inside the bordered card, under the last row, exactly where `/imports` and
              `/library/tracks` put theirs. `total` is the count of the filtered set and
              `items.length` is what this page holds, so the sentence it prints and the rows
              above it come from one `where` — see `services/inbox.ts`.
            */}
            {total > pageSize ? (
              <Pager
                page={page}
                pageSize={pageSize}
                total={total}
                shown={items.length}
                noun="items"
                data-testid="review-pager"
                onPage={(next) => {
                  void navigate({ to: "/review", search: { ...params, page: next } });
                }}
              />
            ) : null}
          </nav>

          {card === null ? (
            <p className="self-start rounded-xl border border-line bg-surface-1 px-6 py-16 text-center text-fg-2">
              Pick an item on the left.
            </p>
          ) : (
            <ReviewCard
              key={card.item.id}
              card={card}
              busy={busy || !hydrated}
              onConfirm={confirm}
              onPin={pin}
              onDropQualifier={dropQualifier}
            />
          )}
        </div>
      )}
    </>
  );
}
