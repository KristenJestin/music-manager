/**
 * @mm/contracts — shared boundary schemas.
 *
 * Two kinds of things live here (see ../../CLAUDE.md):
 *  - hand-written zod schemas shared by the UI, the REST API, the CLI and the MCP server;
 *  - `toolbox/`, generated from the toolbox's OpenAPI document by `bun run toolbox:openapi`.
 *    Never edit `toolbox/` by hand.
 *
 * P00 shipped the `/health` shapes; P03 adds the typed error that crosses the TS↔Python
 * bridge and the job event the SSE stream carries to the browser.
 */
import { z } from "zod";

export {
  isRetryable,
  MM_ERROR_CODES,
  MMError,
  mmErrorBodySchema,
  type MMErrorBody,
  type MMErrorCode,
} from "./errors.ts";
export {
  JOB_EVENT_TYPES,
  jobEventSchema,
  STEP_NAMES,
  stepNameSchema,
  type JobEventPayload,
  type StepName,
} from "./events.ts";
export {
  API_ACTIONS,
  API_RESOURCES,
  API_SCOPES,
  apiKeySchema,
  apiPrincipalSchema,
  apiScopeSchema,
  EVENT_DESCRIPTIONS,
  grants,
  isApiScope,
  NOTIFIABLE_EVENTS,
  notifiableEventSchema,
  parseScope,
  permissionsOf,
  SCOPE_DESCRIPTIONS,
  SCOPE_ORDER,
  scopesOf,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  webhookPayloadSchema,
  webhookSchema,
  type ApiAction,
  type ApiKeyView,
  type ApiPrincipal,
  type ApiResource,
  type ApiScope,
  type NotifiableEvent,
  type WebhookPayload,
  type WebhookView,
} from "./api.ts";

/** Every service in the stack answers `GET /health` with at least `{ ok: boolean }`. */
export const healthSchema = z.object({
  ok: z.boolean(),
});
export type Health = z.infer<typeof healthSchema>;

/** The web app's own `/health` payload. */
export const webHealthSchema = healthSchema.extend({
  version: z.string(),
});
export type WebHealth = z.infer<typeof webHealthSchema>;

/**
 * The toolbox's `/health` payload. Each version is `null` when the binary or module
 * is missing from the image, which is how P00 proves the Docker image is complete.
 */
export const toolboxHealthSchema = healthSchema.extend({
  fixtures: z.boolean(),
  versions: z.object({
    "yt-dlp": z.string().nullable(),
    ffmpeg: z.string().nullable(),
    fpcalc: z.string().nullable(),
    rsgain: z.string().nullable(),
  }),
});
export type ToolboxHealth = z.infer<typeof toolboxHealthSchema>;
