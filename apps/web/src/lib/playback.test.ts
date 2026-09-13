/**
 * The two things the player used to get wrong, pinned.
 *
 * The bug this file exists for: a Deezer clip blocked by our own `Content-Security-Policy`
 * raised `MediaError.code = 4` with "Media load rejected by URL safety check", and the Console
 * reported "Deezer's clip links expire; try again" — about a URL whose signature was still
 * good for four hours. One test says the expiry is read from the URL rather than guessed, the
 * other says four different failures produce four different sentences.
 */
import { describe, expect, it } from "vitest";
import {
  classifyMediaError,
  classifyPlayRejection,
  PREVIEW_EXPIRY_MARGIN_MS,
  previewExpired,
  previewExpiresAt,
  worthShowing,
} from "#/lib/playback.ts";

/** A real preview URL, shortened, with its signature intact. `exp` is 2026-09-13T09:28:19Z. */
const SIGNED =
  "https://cdnt-preview.dzcdn.net/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3" +
  "?hdnea=exp=1789332499~acl=/api/1/1/f/8/c/0/f8c5dc3837912dba37c9a1ab3170cc3f.mp3*" +
  "~data=user_id=0,application_id=42~hmac=9c680fe4c916d50a8776d293c7561d581d0c1ae2";

const EXPIRES_AT = 1_789_332_499_000;

describe("the expiry on a Deezer clip URL", () => {
  it("reads `hdnea=exp=<unix>` as milliseconds", () => {
    expect(previewExpiresAt(SIGNED)).toBe(EXPIRES_AT);
  });

  it("has no opinion about a URL that carries no signature", () => {
    // Our own files, and anything Deezer decides to spell differently tomorrow. "No opinion"
    // must never be read as "expired", or a library track would refuse to play.
    expect(previewExpiresAt("/api/stream?track=trk_01")).toBeNull();
    expect(previewExpiresAt("https://cdnt-preview.dzcdn.net/api/1/1/x.mp3")).toBeNull();
    expect(previewExpiresAt("https://example.test/x.mp3?hdnea=exp=not-a-number")).toBeNull();
    expect(previewExpired("/api/stream?track=trk_01", EXPIRES_AT + 86_400_000)).toBe(false);
  });

  it("calls a clip expired a margin *before* the instant on it", () => {
    const comfortable = EXPIRES_AT - PREVIEW_EXPIRY_MARGIN_MS - 1;
    expect(previewExpired(SIGNED, comfortable)).toBe(false);
    // Inside the margin: still technically valid, but not worth handing to `<audio>`.
    expect(previewExpired(SIGNED, EXPIRES_AT - 1)).toBe(true);
    expect(previewExpired(SIGNED, EXPIRES_AT + 1)).toBe(true);
  });

  it("takes the margin from the caller, because the server checks earlier than the browser", () => {
    expect(previewExpired(SIGNED, EXPIRES_AT - 60_000, 0)).toBe(false);
    expect(previewExpired(SIGNED, EXPIRES_AT - 60_000, 600_000)).toBe(true);
  });
});

describe("classifying a media failure", () => {
  it("separates the four MediaError codes instead of blaming the expiry every time", () => {
    const csp = classifyMediaError(
      { code: 4, message: "MEDIA_ELEMENT_ERROR: Media load rejected by URL safety check" },
      "deezer",
    );
    expect(csp.kind).toBe("unsupported");
    expect(csp.retryable).toBe(true);
    // The console keeps the browser's own words; that string is what identified the CSP.
    expect(csp.detail).toContain("code=4");
    expect(csp.detail).toContain("URL safety check");

    expect(classifyMediaError({ code: 2 }, "deezer").kind).toBe("network");
    expect(classifyMediaError({ code: 3 }, "deezer").kind).toBe("decode");
    expect(classifyMediaError({ code: 1 }, "deezer").kind).toBe("aborted");

    const sentences = new Set(
      [1, 2, 3, 4].map((code) => classifyMediaError({ code }, "deezer").message),
    );
    expect(sentences.size, "four causes, four sentences").toBe(4);
  });

  it("words a library failure as a file and never offers to re-resolve it", () => {
    const file = classifyMediaError({ code: 4 }, "library");
    expect(file.message).toBe("This file could not be loaded.");
    expect(file.retryable).toBe(false);
  });

  it("treats a rejected play() as its own thing, by name", () => {
    const denied = classifyPlayRejection(
      Object.assign(new Error("gesture required"), { name: "NotAllowedError" }),
      "deezer",
    );
    expect(denied.kind).toBe("autoplay-blocked");
    expect(denied.retryable).toBe(false);
    expect(denied.detail).toContain("NotAllowedError");

    // The everyday one: the queue moved on while `play()` was pending. Not a fault.
    const aborted = classifyPlayRejection(
      Object.assign(new Error("interrupted"), { name: "AbortError" }),
      "deezer",
    );
    expect(aborted.kind).toBe("aborted");
    expect(worthShowing(aborted)).toBe(false);

    expect(
      classifyPlayRejection(Object.assign(new Error("no"), { name: "NotSupportedError" }), "deezer")
        .kind,
    ).toBe("unsupported");
    expect(classifyPlayRejection("not an error at all", "library").kind).toBe("unknown");
  });

  it("shows everything except an abort", () => {
    expect(worthShowing(classifyMediaError({ code: 4 }, "deezer"))).toBe(true);
    expect(worthShowing(classifyMediaError({ code: 1 }, "deezer"))).toBe(false);
  });
});
