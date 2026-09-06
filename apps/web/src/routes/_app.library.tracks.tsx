import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/library/tracks")({
  staticData: { crumbs: [{ label: "Library" }, { label: "Tracks" }] },
  component: () => (
    <ComingSoon
      title="Tracks"
      phase="P07"
      what="Every track in the library, with its file, its recording and its tag schema version."
    />
  ),
});
