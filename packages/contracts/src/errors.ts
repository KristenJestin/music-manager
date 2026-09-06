/**
 * The typed error that crosses every boundary (`CLAUDE.md` § Conventions).
 *
 * The Python toolbox raises `{code, message, hint, action}` from its `errors.py`; the
 * TypeScript side re-raises the very same object as an `MMError`. The Console's error decoder
 * therefore has exactly one shape to render, whichever side of the bridge failed, and a code
 * never has to be translated on the way through.
 */
import { z } from "zod";

/**
 * The catalogue of `services/toolbox/src/toolbox/errors.py`, plus the codes the orchestrator
 * raises on its own. Kept as a plain list rather than a zod enum on the wire: a toolbox that
 * is newer than the app must still be able to report a code we do not know yet.
 */
export const MM_ERROR_CODES = [
  /* --- from the toolbox --- */
  "YTDLP_BOT_CHECK",
  "YTDLP_NSIG",
  "YTDLP_403",
  "YTDLP_FORMAT",
  "YTDLP_AGE",
  "YTDLP_PRIVATE",
  "YTDLP_UNAVAILABLE",
  "FFMPEG_MISSING",
  /** yt-dlp handed back a container no tagger can write to — a `.webm`, typically. */
  "DOWNLOAD_CONTAINER",
  "TAG_WRITE_FAILED",
  "PLACE_CONFLICT",
  "LOCKED",
  "FIXTURE_UNKNOWN",
  "UNKNOWN",
  /* --- raised by the orchestrator --- */
  "TOOLBOX_UNREACHABLE",
  "STEP_FAILED",
  "NOT_FOUND",
  "INVALID_INPUT",
  "AWAITING_CONFIRM",
  "AWAITING_REVIEW",
  "CANCELLED",
  /** No session, or an expired one. The Console turns it into a redirect to `/login` (P06). */
  "UNAUTHORIZED",
  /* --- the public API (P08) --- */
  /**
   * Authenticated, but the credential does not carry the scope this route needs.
   *
   * Deliberately distinct from `UNAUTHORIZED`: the fix for one is "sign in / check the key",
   * and the fix for the other is "issue a key with that scope". An API that answered 401 to
   * both would send people to replace a key that was working.
   */
  "FORBIDDEN",
  /** The API key exceeded its rate limit, or exhausted its remaining uses. */
  "RATE_LIMITED",
  /** A network call the user is waiting on did not answer in time. */
  "TIMEOUT",
  /* --- the Navidrome read-back (P07, docs/03 §7) --- */
  "NAVIDROME_NOT_CONFIGURED",
  "NAVIDROME_UNREACHABLE",
  "NAVIDROME_AUTH",
  "NAVIDROME_FAILED",
  "NAVIDROME_SCAN_TIMEOUT",
] as const;

export type MMErrorCode = (typeof MM_ERROR_CODES)[number] | (string & {});

/** The body every failure travels in, on HTTP and inside an NDJSON `error` event alike. */
export const mmErrorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
  action: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  /**
   * The HTTP status the failure arrived with, when it arrived over HTTP.
   *
   * It used to be set by `ToolboxClient.unwrap` and then dropped by `toBody()`, so it reached
   * neither `job_steps.error` nor the MCP server: every toolbox refusal read as an untyped
   * `UNKNOWN` and a reader had no way to tell a 409 from a 422 from a 500.
   */
  status: z.number().int().optional(),
});

export type MMErrorBody = z.infer<typeof mmErrorBodySchema>;

/**
 * FastAPI's own failure body — `{"detail": …}` — which is **not** our shape.
 *
 * The toolbox raises `{code, message, hint, action}` for everything it means to say, but
 * pydantic answers a malformed request *before* any of our code runs, and it answers in its
 * own dialect. Discarding that body (which is what `fromBody` used to do) turned the single
 * most diagnosable failure there is — "you sent a field I do not know" — into `UNKNOWN`.
 */
const fastApiDetailSchema = z.object({
  detail: z.union([
    z.string(),
    z.array(
      z.object({
        loc: z.array(z.union([z.string(), z.number()])).optional(),
        msg: z.string().optional(),
        type: z.string().optional(),
      }),
    ),
  ]),
});

type FastApiDetail = z.infer<typeof fastApiDetailSchema>["detail"];

/** `[{loc:["body","cookies_content"],msg:"Extra inputs are not permitted"}]` → one sentence. */
function describeFastApiDetail(detail: FastApiDetail): string {
  if (typeof detail === "string") return detail;
  const lines = detail.map((item) => {
    const where = (item.loc ?? [])
      .map(String)
      .filter((part) => part !== "body")
      .join(".");
    const what = item.msg ?? item.type ?? "invalid";
    return where === "" ? what : `${where}: ${what}`;
  });
  return lines.join("; ");
}

/** True when pydantic refused a field the caller sent — the "stale image" signature. */
function isExtraForbidden(detail: FastApiDetail): boolean {
  return typeof detail !== "string" && detail.some((item) => item.type === "extra_forbidden");
}

/** Enough of an unrecognised body to act on, never enough to flood a log line. */
function summarise(body: unknown, limit = 400): string | null {
  if (body === null || body === undefined) return null;
  const text = typeof body === "string" ? body : safeStringify(body);
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "{}" || trimmed === "null") return null;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A failure with a code the UI can decode and an action it can offer.
 *
 * `retryable` is the orchestrator's own judgement, not the toolbox's: a `LOCKED` download is
 * worth retrying in thirty seconds, a `YTDLP_PRIVATE` video never will be.
 */
export class MMError extends Error {
  readonly code: MMErrorCode;
  readonly hint: string | undefined;
  readonly action: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(
    code: MMErrorCode,
    message: string,
    options: {
      hint?: string;
      action?: string;
      details?: Record<string, unknown>;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MMError";
    this.code = code;
    this.hint = options.hint;
    this.action = options.action;
    this.details = options.details;
    this.status = options.status;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  /** The serialisable body — what goes into `job_events`, `imports.error` and the API. */
  toBody(): MMErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...(this.action === undefined ? {} : { action: this.action }),
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }

  /**
   * Rebuild an `MMError` from a toolbox body, or from a row read back out of the database.
   *
   * **A body that is not ours is kept, not thrown away.** Three cases, in order:
   *
   *  1. our `{code, message, …}` — decoded as-is, `status` included;
   *  2. FastAPI's `{"detail": …}` — pydantic refused the request before any of our code ran,
   *     and what it says is the whole diagnosis. It becomes the message, and the raw body
   *     survives in `details.body`;
   *  3. anything else — summarised into the message rather than dropped, so a caller reading
   *     `job_steps.error` sees what the far end actually said.
   */
  static fromBody(body: unknown, fallback = "Unknown error."): MMError {
    const parsed = mmErrorBodySchema.safeParse(body);
    if (parsed.success) {
      const { code, message, hint, action, details, status } = parsed.data;
      return new MMError(code, message, { hint, action, details, status });
    }

    const fastapi = fastApiDetailSchema.safeParse(body);
    if (fastapi.success) {
      const described = describeFastApiDetail(fastapi.data.detail);
      const stale = isExtraForbidden(fastapi.data.detail);
      return new MMError("INVALID_INPUT", `${fallback} ${described}`.trim(), {
        details: { body: summarise(body) ?? described },
        ...(stale
          ? {
              hint:
                "The service rejected a field this app sends, which usually means its image is " +
                "older than the code calling it.",
              action: "Rebuild the toolbox image (`bun run stack:up --build`)",
            }
          : { action: "Check the request" }),
      });
    }

    const summary = summarise(body);
    if (summary === null) return new MMError("UNKNOWN", fallback);
    return new MMError("UNKNOWN", `${fallback} The service answered: ${summary}`, {
      details: { body: summary },
    });
  }

  /** Wrap anything thrown into the one shape the rest of the system knows. */
  static from(error: unknown): MMError {
    if (error instanceof MMError) return error;
    if (error instanceof Error) {
      return new MMError("UNKNOWN", error.message, { cause: error });
    }
    return new MMError("UNKNOWN", String(error));
  }
}

/**
 * Codes worth trying again on their own. Everything else needs a human or a different input:
 * re-running a `YTDLP_PRIVATE` download a hundred times only wastes a hundred requests.
 */
const RETRYABLE = new Set<string>([
  "LOCKED",
  "TOOLBOX_UNREACHABLE",
  "YTDLP_403",
  "YTDLP_NSIG",
  "YTDLP_FORMAT",
  "UNKNOWN",
  // Both mean "the same request, later, would work" — which is the definition here.
  // `FORBIDDEN` deliberately is not: no amount of waiting adds a scope to a key.
  "RATE_LIMITED",
  "TIMEOUT",
]);

/** True when the failure is worth a backoff rather than a stop. */
export function isRetryable(error: unknown): boolean {
  return error instanceof MMError ? error.retryable : false;
}
