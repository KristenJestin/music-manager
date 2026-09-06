import { createFileRoute } from "@tanstack/react-router";
import { ComingSoon } from "#/components/coming-soon.tsx";

/** Placeholder for P07. The route exists now so the shell's navigation is honest. */
export const Route = createFileRoute("/_app/tools")({
  staticData: { crumbs: [{ label: "System" }, { label: "Tools" }] },
  component: () => (
    <ComingSoon
      title="Tools \& diagnostics"
      phase="P07"
      what="yt-dlp health, cookies, the library scan, the error decoder and the Navidrome read-back."
    />
  ),
});
