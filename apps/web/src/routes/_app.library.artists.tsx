import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/library/artists")({
  staticData: { crumbs: [{ label: "Library" }, { label: "Artists" }] },
  component: () => (
    <ComingSoon
      title="Artists"
      phase="P07"
      what="Artists resolved from MusicBrainz, with their images and their relations."
    />
  ),
});
