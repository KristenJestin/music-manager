/**
 * The Review screen: the queue on the left, the open decision on the right.
 *
 * Answering an item moves to the next one without leaving the page, because a review queue you
 * have to navigate back to after every answer is a queue nobody empties.
 */
import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import { cn } from "cn";
import { Cover } from "#/components/cover.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ReviewCard } from "#/components/review-card.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { Skeleton, SkeletonPage, SkeletonPageHeader } from "#/components/skeleton.tsx";
import { humanise } from "#/lib/format.ts";
import { TimeAgo } from "#/components/time-ago.tsx";
import { resolveItem, type InboxListPayload, type InboxOption } from "#/server/functions/inbox.ts";

/**
 * The Review screen while `fetchInbox` runs.
 *
 * Here for the same reason `ReviewScreen` is: `/review` and `/review/:id` are one page opened
 * on a different item, and two skeletons for one layout would drift apart. It mirrors
 * `review-grid` — the 340 px queue on the left, the decision card on the right — so answering
 * an item, which navigates to the next one, never re-flows the column the cursor is in.
 */
export function ReviewScreenSkeleton() {
  return (
    <SkeletonPage name="review" label="Loading the review queue…">
      <SkeletonPageHeader actions={0} />
      <div className="review-grid">
        <nav className="overflow-hidden rounded-xl border border-line bg-surface-1">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="flex items-center gap-2.5 border-b border-line px-3 py-2.5 last:border-b-0"
            >
              <Skeleton className="size-9 shrink-0 rounded-sm" />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-2.5 w-1/2" />
              </span>
              <Skeleton className="h-5 w-16 shrink-0 rounded-xl" />
            </div>
          ))}
        </nav>
        <div className="flex flex-col gap-3 rounded-xl border border-line bg-surface-1 p-3.5">
          <div className="review-card-grid gap-3">
            <Skeleton className="aspect-square w-14 rounded-sm" />
            <div className="flex flex-col gap-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3 w-3/4" />
            </div>
          </div>
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} className="h-16 w-full rounded-lg" />
          ))}
          <div className="flex justify-end gap-2">
            <Skeleton className="h-8 w-24 rounded-lg" />
            <Skeleton className="h-8 w-24 rounded-lg" />
          </div>
        </div>
      </div>
    </SkeletonPage>
  );
}

export function ReviewScreen({ payload }: { readonly payload: InboxListPayload }) {
  const { items, card } = payload;
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const hydrated = useHydrated();
  const now = new Date();

  const confirm = (option: InboxOption): void => {
    if (card === null || busy) return;
    setBusy(true);
    void resolveItem({
      data: { id: card.item.id, choice: option.value, dismiss: option.dismiss ?? false },
    }).then(
      (result) => {
        setBusy(false);
        toast(result.resumed ? "Decision saved; the job resumes." : "Decision saved.", "ok");
        void router.invalidate();
        void router.navigate(
          result.nextId === null
            ? { to: "/review" }
            : { to: "/review/$id", params: { id: result.nextId } },
        );
      },
      (error: unknown) => {
        setBusy(false);
        toast(error instanceof Error ? error.message : "Could not save that.", "danger");
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Review queue"
        description="Decisions the matcher would not take on its own. Each item shows its preselected answer; Enter accepts it."
      />

      {items.length === 0 ? (
        <div
          data-testid="review-empty"
          className="flex flex-col items-center gap-3 rounded-xl border border-line bg-surface-1 px-6 py-16 text-center"
        >
          <Inbox className="size-8 text-fg-3" aria-hidden="true" />
          <p className="text-fg-1">Nothing to decide. The Inbox is empty.</p>
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
            />
          )}
        </div>
      )}
    </>
  );
}
