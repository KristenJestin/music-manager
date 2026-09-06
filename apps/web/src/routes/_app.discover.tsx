import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P09. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/discover")({
  staticData: { crumbs: [{ label: "Discover" }] },
  component: () => (
    <ComingSoon
      title="Discover"
      phase="P09"
      what="Recommendations from your own library and from ListenBrainz, importable in one click."
    />
  ),
});
