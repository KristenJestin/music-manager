import { createFileRoute } from "@tanstack/react-router";
import { inboxSearchSchema } from "#/lib/inbox-filters.ts";
import { fetchInbox } from "#/server/functions/inbox.ts";
import { ReviewScreen, ReviewScreenSkeleton } from "#/components/review-screen.tsx";

/**
 * `/review/:id` — the same queue, opened on one item.
 *
 * It validates the same search parameters as `/review` so the filters survive opening an item
 * and answering it; the item itself is a path parameter and is looked up whether or not the
 * current filter would have listed it (`fetchInbox`), so a deep link never stops working
 * because of a filter set afterwards.
 */
export const Route = createFileRoute("/_app/review/$id")({
  validateSearch: inboxSearchSchema,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ params, deps }) =>
    await fetchInbox({
      data: {
        id: params.id,
        ...(deps.type === undefined ? {} : { type: deps.type }),
        status: deps.status,
        q: deps.q,
        sort: deps.sort,
        page: deps.page,
      },
    }),
  staticData: { crumbs: [{ label: "Review", to: "/review" }] },
  component: ReviewItem,
  pendingComponent: ReviewItemPending,
});

/** As on `/review`: the toolbar is real while the rows are not, so it needs the URL. */
function ReviewItemPending() {
  return <ReviewScreenSkeleton params={Route.useSearch()} />;
}

function ReviewItem() {
  return <ReviewScreen payload={Route.useLoaderData()} params={Route.useSearch()} />;
}
