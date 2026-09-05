import { createFileRoute } from "@tanstack/react-router";
import { handleHealth } from "#/server/health.ts";

/**
 * Server-only route: no component, so the handler must return a Response.
 * Kept trivial on purpose — the logic and its tests live in `src/server/health.ts`.
 */
export const Route = createFileRoute("/health")({
  server: {
    handlers: {
      GET: () => handleHealth(),
    },
  },
});
