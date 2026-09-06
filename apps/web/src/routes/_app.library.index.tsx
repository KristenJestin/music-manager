import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/library/")({
  staticData: { crumbs: [{ label: "Library" }, { label: "Albums" }] },
  component: () => (
    <ComingSoon
      title="Albums"
      phase="P07"
      what="Browse what is on disk, per album: tracks, cover, tags, and what Navidrome read back."
    />
  ),
});
