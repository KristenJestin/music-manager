/**
 * AcoustID (`docs/03-metadonnees.md` §2.5, §4).
 *
 * The fingerprint itself is produced by the toolbox (`POST /fingerprint`, fpcalc); this
 * client only asks AcoustID what that fingerprint is. Two consequences shape the code:
 *
 *  - a Chromaprint is a couple of kilobytes, so the lookup is a **POST form**, not a query
 *    string. `getJson` grows a `form` option for exactly this;
 *  - the cache key therefore cannot be the request. It is the **hash** of the fingerprint plus
 *    the rounded duration — stable, short, and it still means "this audio, this question".
 *
 * Without a key, AcoustID answers nothing useful. That is not an error: decision 011 says the
 * fingerprint is a safety net, and a net nobody strung is silence, not disagreement.
 */
import { createHash } from "node:crypto";
import { MMError } from "@mm/contracts";
import type { AcoustIdResponse } from "@mm/domain";
import { cached, optionsFor, type CachedValue } from "./cached.ts";
import type { SourceContext } from "./config.ts";
import { getJson } from "./http.ts";

export const ACOUSTID_BASE = "https://api.acoustid.org/v2";

/** What we ask AcoustID to return with each match. */
const META = "recordings+recordingids+releasegroups+compress";

/** A short, stable identifier for one (fingerprint, duration) question. */
export function fingerprintKey(fingerprint: string, durationSeconds: number): string {
  const digest = createHash("sha256").update(fingerprint).digest("hex").slice(0, 32);
  return `lookup/${digest}@${String(Math.round(durationSeconds))}`;
}

/**
 * AcoustID's own error numbers, from its `errors.py`. Only the ones we act on are named.
 *
 * The two that matter both arrive as HTTP 400, which is the whole point: swallowing every
 * 400 as "no answer for this audio" is what let a **wrong key** look exactly like a
 * fingerprint AcoustID could not parse — silently disabling the safety net of decision 011
 * and telling the Console "the key was accepted" (decision 052, owner review B8).
 */
export const ACOUSTID_ERROR = {
  invalidFingerprint: 3,
  invalidApiKey: 4,
  invalidUserApiKey: 6,
} as const;

/** What AcoustID puts in the body of a refusal. */
interface AcoustIdError {
  readonly status?: string;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** The error AcoustID described in the body of a 400, or `null` when it described none. */
export function acoustidError(error: unknown): { code: number; message: string } | null {
  if (!(error instanceof MMError)) return null;
  const body = error.details?.body;
  if (typeof body !== "string") return null;
  let parsed: AcoustIdError;
  try {
    parsed = JSON.parse(body) as AcoustIdError;
  } catch {
    return null;
  }
  const code = parsed.error?.code;
  if (typeof code !== "number") return null;
  return { code, message: parsed.error?.message ?? "" };
}

/** True when AcoustID refused the *credential* rather than the audio. */
export function isKeyRejection(error: unknown): boolean {
  const described = acoustidError(error);
  if (described === null) return false;
  return (
    described.code === ACOUSTID_ERROR.invalidApiKey ||
    described.code === ACOUSTID_ERROR.invalidUserApiKey ||
    described.message.toLowerCase().includes("api key")
  );
}

/**
 * Ask AcoustID what this audio is. `null` when no key is configured — the caller treats that
 * as "nothing was measured", never as "the mapping is wrong".
 */
export async function lookup(
  ctx: SourceContext,
  fingerprint: string,
  durationSeconds: number,
): Promise<CachedValue<AcoustIdResponse | null> | null> {
  if (fingerprint.trim() === "") return null;
  const key = fingerprintKey(fingerprint, durationSeconds);

  // Offline, the key does not matter: the answer is in the cache or it is not.
  if (!ctx.offline && ctx.config.acoustidKey === "") return null;

  return await cached<AcoustIdResponse>(
    "acoustid",
    key,
    async () => {
      try {
        const answer = await getJson<AcoustIdResponse>({
          source: "acoustid",
          url: `${ACOUSTID_BASE}/lookup`,
          headers: { "user-agent": ctx.config.userAgent },
          form: {
            client: ctx.config.acoustidKey,
            fingerprint,
            duration: String(Math.round(durationSeconds)),
            meta: META,
          },
          // AcoustID's own guidance is three requests per second; one is politer and this
          // client only ever fires one lookup per track.
          minIntervalMs: 350,
          ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          ...(ctx.wait === undefined ? {} : { wait: ctx.wait }),
        });
        return answer?.data ?? null;
      } catch (error) {
        // AcoustID answers 400 for a fingerprint it cannot parse — which is what a synthetic
        // one is, and what a truncated file produces. That is "I have no answer for this
        // audio", not "the service is broken", so it is cached as an absence like any other.
        // Decision 011 already says silence is not disagreement.
        //
        // A rejected *key* arrives as a 400 too, and it is the opposite of silence: nothing
        // will ever be measured until someone fixes it. It leaves as an error (decision 073).
        if (error instanceof MMError && error.status === 400 && !isKeyRejection(error)) {
          return null;
        }
        throw error;
      }
    },
    optionsFor(ctx, ctx.config.ttlMs.acoustid),
  );
}
