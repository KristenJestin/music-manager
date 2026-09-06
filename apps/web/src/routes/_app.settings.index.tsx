/**
 * `/settings` with no tab: go to the first one.
 *
 * A redirect rather than a landing page, because a settings index that lists the tabs the
 * strip already lists is a click nobody wanted.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/downloader" });
  },
});
