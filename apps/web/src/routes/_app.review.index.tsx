import { createFileRoute } from "@tanstack/react-router";
import { fetchInbox } from "#/server/functions/inbox.ts";
import { ReviewScreen, ReviewScreenSkeleton } from "#/components/review-screen.tsx";

/**
 * `/review` — the queue, with the first item open.
 *
 * `/review` and `/review/:id` render the same screen; the only difference is which item the
 * server picks. That is why the component lives in `components/` rather than in either route:
 * two routes, one page, no duplication. The skeleton is shared for exactly the same reason.
 */
export const Route = createFileRoute("/_app/review/")({
  loader: async () => await fetchInbox({ data: {} }),
  staticData: { crumbs: [{ label: "Review" }] },
  component: ReviewIndex,
  pendingComponent: ReviewScreenSkeleton,
});

function ReviewIndex() {
  return <ReviewScreen payload={Route.useLoaderData()} />;
}
