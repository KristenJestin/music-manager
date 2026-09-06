import { createFileRoute } from "@tanstack/react-router";
import { fetchInbox } from "#/server/functions/inbox.ts";
import { ReviewScreen } from "#/components/review-screen.tsx";

/** `/review/:id` — the same queue, opened on one item. */
export const Route = createFileRoute("/_app/review/$id")({
  loader: async ({ params }) => await fetchInbox({ data: { id: params.id } }),
  staticData: { crumbs: [{ label: "Review", to: "/review" }] },
  component: ReviewItem,
});

function ReviewItem() {
  return <ReviewScreen payload={Route.useLoaderData()} />;
}
