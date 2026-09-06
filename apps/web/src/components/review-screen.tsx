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
import { humanise, timeAgo } from "#/lib/format.ts";
import { resolveItem, type InboxListPayload, type InboxOption } from "#/server/functions/inbox.ts";

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
        toast(result.resumed ? "Decision saved — the job resumes." : "Decision saved.", "ok");
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
        description="Decisions the matcher would not take on its own. Each item shows its preselected answer — Enter accepts it."
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
                  <span className="text-3xs text-fg-3">{timeAgo(item.createdAt, now)}</span>
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
