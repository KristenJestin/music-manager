import { type WebHealth, webHealthSchema } from "@mm/contracts";
import { APP_VERSION } from "./version.ts";

/** The payload served by `GET /health`. Validated against the shared contract. */
export function healthPayload(): WebHealth {
  return webHealthSchema.parse({ ok: true, version: APP_VERSION });
}

/** Framework-agnostic handler, so it can be unit-tested without booting the router. */
export function handleHealth(): Response {
  return Response.json(healthPayload(), {
    headers: { "cache-control": "no-store" },
  });
}
