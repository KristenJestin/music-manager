import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/library/quality")({
  staticData: { crumbs: [{ label: "Library" }, { label: "Quality" }] },
  component: () => (
    <ComingSoon
      title="Quality"
      phase="P07"
      what="Metadata completeness per album and per consumer profile, and what is missing."
    />
  ),
});
