import { createFileRoute } from "@tanstack/react-router";
import { inboxSearchSchema } from "#/lib/inbox-filters.ts";
import { fetchInbox } from "#/server/functions/inbox.ts";
import { ReviewScreen, ReviewScreenSkeleton } from "#/components/review-screen.tsx";

/**
 * `/review` — the queue, with the first item open.
 *
 * `/review` and `/review/:id` render the same screen; the only difference is which item the
 * server picks. That is why the component lives in `components/` rather than in either route:
 * two routes, one page, no duplication. The skeleton is shared for exactly the same reason,
 * and so is `inboxSearchSchema` — a filter that survived one of the two and not the other
 * would be a queue that forgot what you were looking at every time you answered something.
 */
export const Route = createFileRoute("/_app/review/")({
  validateSearch: inboxSearchSchema,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchInbox({
      data: {
        ...(deps.type === undefined ? {} : { type: deps.type }),
        status: deps.status,
        q: deps.q,
        sort: deps.sort,
        page: deps.page,
      },
    }),
  staticData: { crumbs: [{ label: "Review" }] },
  component: ReviewIndex,
  pendingComponent: ReviewIndexPending,
});

/** The skeleton renders the toolbar for real, so it needs the URL the toolbar reads. */
function ReviewIndexPending() {
  return <ReviewScreenSkeleton params={Route.useSearch()} />;
}

function ReviewIndex() {
  return <ReviewScreen payload={Route.useLoaderData()} params={Route.useSearch()} />;
}
