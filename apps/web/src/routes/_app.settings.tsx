import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/settings")({
  staticData: { crumbs: [{ label: "System" }, { label: "Settings" }] },
  component: () => (
    <ComingSoon
      title="Settings"
      phase="P07"
      what="Every knob of the pipeline: matching weights, tagging, placement, sources and credentials."
    />
  ),
});
