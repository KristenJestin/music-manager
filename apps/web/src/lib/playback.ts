/**
 * Why a sound did not come out, in words — and how long a Deezer clip link is still good for.
 *
 * Both halves live here rather than in `components/shell/player-context.tsx` because both are
 * pure, both are wanted on the server as well as in the browser (the preview resolver checks
 * an expiry before handing a URL out; the player checks it again before setting `src`), and
 * because the player used to guess. One `<audio>` `error` event became one sentence — "Deezer's
 * clip links expire; try again" — regardless of whether the browser had refused to autoplay,
 * been handed a codec it does not take, had the load cancelled by the next track, or, as it
 * turned out, been stopped by our own `Content-Security-Policy`. A message that is wrong in
 * four cases out of five costs more than no message at all, so the failure is classified and
 * the raw `code`/`name` is logged beside it.
 *
 * There is no `zod` here on purpose: nothing in this module parses a boundary. `MediaError` is
 * a DOM object the browser built, and the one string that *is* untrusted input — the signed
 * URL — is read with a regular expression that either matches or answers `null`.
 */

/* ------------------------------------------------------------------ */
/* the signature on a Deezer clip URL                                  */
/* ------------------------------------------------------------------ */

/**
 * When a Deezer preview URL stops working, in epoch milliseconds, or `null`.
 *
 * The clip is a signed MP3 and the signature is in the query string:
 * `?hdnea=exp=<unix seconds>~acl=…~hmac=…`. Past that instant the CDN answers `403` and the
 * element reports `MEDIA_ERR_SRC_NOT_SUPPORTED`, which is indistinguishable from a dozen other
 * causes — so it is worth knowing *before* pressing play rather than diagnosing afterwards.
 *
 * `null` means "no opinion", never "expired": a library URL has no signature, and Deezer is
 * free to change the shape of theirs. A caller that cannot tell must not refuse to play.
 */
export function previewExpiresAt(url: string): number | null {
  const match = /[?&]hdnea=(?:[^&]*~)?exp=(\d{1,15})/.exec(url);
  const seconds = match?.[1];
  if (seconds === undefined) return null;
  const at = Number.parseInt(seconds, 10) * 1000;
  return Number.isSafeInteger(at) && at > 0 ? at : null;
}

/**
 * The margin between "still valid" and "worth refreshing", in milliseconds.
 *
 * Two minutes: long enough to cover a clip that was resolved while the page was open and is
 * about to lapse mid-listen, short enough that it never re-resolves a URL with hours left on
 * it. Deezer issues them roughly four hours ahead, so this is a rounding error against the
 * lifetime and the difference between a dead button and a working one at the edge.
 */
export const PREVIEW_EXPIRY_MARGIN_MS = 120_000;

/**
 * True when this URL is expired, or close enough to it that handing it to `<audio>` is a bet.
 *
 * Unsigned URLs — everything from our own library — are never expired.
 */
export function previewExpired(
  url: string,
  now: number = Date.now(),
  marginMs: number = PREVIEW_EXPIRY_MARGIN_MS,
): boolean {
  const at = previewExpiresAt(url);
  return at !== null && at - marginMs <= now;
}

/* ------------------------------------------------------------------ */
/* what actually went wrong                                            */
/* ------------------------------------------------------------------ */

/** The kinds of failure the player can tell apart, and act on differently. */
export type PlaybackFailureKind =
  /** The browser will not start sound without a gesture it recognises. Not our bug. */
  | "autoplay-blocked"
  /** A newer `src` replaced this one while it was loading. Not an error at all. */
  | "aborted"
  /** The source was refused or could not be decoded: CORS, 403, CSP, a dead link, a codec. */
  | "unsupported"
  /** The transfer started and broke. Retrying the same URL is reasonable. */
  | "network"
  /** Bytes arrived and could not be decoded. */
  | "decode"
  /** Something else, kept rather than flattened. */
  | "unknown";

export interface PlaybackFailure {
  readonly kind: PlaybackFailureKind;
  /** What the reader is told. */
  readonly message: string;
  /** What the console is told: the DOM's own name or code, never invented. */
  readonly detail: string;
  /**
   * Whether re-resolving the source and trying once more could plausibly help.
   *
   * Only ever true for a Deezer clip: our own files are served from an id, and a second
   * request for the same `/api/stream` URL would fail exactly as the first one did.
   */
  readonly retryable: boolean;
}

/** `HTMLMediaElement.error`, reduced to what matters. Kept structural so a test can build one. */
export interface MediaErrorLike {
  readonly code: number;
  readonly message?: string;
}

/* The four `MediaError` constants, spelled out: the DOM exposes them only on the instance. */
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * Classify the `error` event of an `<audio>` element.
 *
 * `source` decides the wording, not the diagnosis: a refused Deezer clip and an unreadable
 * library file are the same event, and only one of them is worth offering to retry.
 *
 * Code 4 deserves its wording. It is what a browser answers for a `403`, a CORS refusal, a
 * blocked `media-src`, an unknown container **and** an expired signature alike, so the sentence
 * says "could not be loaded" and the console carries `MediaError`'s own message, which is the
 * only part that separates them (Chromium writes "Media load rejected by URL safety check" for
 * a CSP refusal and "Format error" for a codec).
 */
export function classifyMediaError(
  error: MediaErrorLike | null,
  source: "deezer" | "library",
): PlaybackFailure {
  const deezer = source === "deezer";
  const detail = `MediaError code=${String(error?.code ?? 0)}${
    error?.message === undefined || error.message === "" ? "" : ` message=${error.message}`
  }`;

  switch (error?.code) {
    case MEDIA_ERR_ABORTED:
      return { kind: "aborted", message: "Playback was interrupted.", detail, retryable: false };
    case MEDIA_ERR_NETWORK:
      return {
        kind: "network",
        message: deezer
          ? "The preview stopped downloading. Check the connection and try again."
          : "This file stopped downloading.",
        detail,
        retryable: deezer,
      };
    case MEDIA_ERR_DECODE:
      return {
        kind: "decode",
        message: deezer
          ? "The preview arrived but could not be decoded."
          : "This file arrived but could not be decoded.",
        detail,
        retryable: false,
      };
    case MEDIA_ERR_SRC_NOT_SUPPORTED:
      return {
        kind: "unsupported",
        message: deezer
          ? "The preview could not be loaded — the clip link may have expired, or the browser refused it."
          : "This file could not be loaded.",
        detail,
        retryable: deezer,
      };
    default:
      return {
        kind: "unknown",
        message: deezer ? "The preview could not be played." : "This file could not be played.",
        detail,
        retryable: deezer,
      };
  }
}

/**
 * Classify a rejected `HTMLMediaElement.play()`.
 *
 * A rejection is **not** a media error and must not be reported as one. `NotAllowedError` is
 * the autoplay policy — the sound never started because the browser wanted a user gesture, and
 * the source is fine. `AbortError` is the ordinary consequence of setting a new `src` while a
 * previous `play()` was still pending, which happens on every "next track" and is not worth a
 * word on screen. Only `NotSupportedError` says something about the source itself.
 */
export function classifyPlayRejection(
  error: unknown,
  source: "deezer" | "library",
): PlaybackFailure {
  const name = error instanceof Error ? error.name : "unknown";
  const detail = `play() rejected: ${name}`;
  if (name === "NotAllowedError") {
    return {
      kind: "autoplay-blocked",
      message: "Your browser blocked playback. Press play again.",
      detail,
      retryable: false,
    };
  }
  if (name === "AbortError") {
    return { kind: "aborted", message: "Playback was interrupted.", detail, retryable: false };
  }
  if (name === "NotSupportedError") {
    return {
      kind: "unsupported",
      message:
        source === "deezer"
          ? "The preview could not be loaded — the clip link may have expired, or the browser refused it."
          : "This file could not be loaded.",
      detail,
      retryable: source === "deezer",
    };
  }
  return {
    kind: "unknown",
    message: source === "deezer" ? "The preview could not be played." : "This file did not start.",
    detail,
    retryable: false,
  };
}

/**
 * Whether a failure is worth putting on screen at all.
 *
 * An abort is the player doing its job — the queue moved on — and saying so would make every
 * "next track" look like a fault.
 */
export function worthShowing(failure: PlaybackFailure): boolean {
  return failure.kind !== "aborted";
}
