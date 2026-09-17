/**
 * Reading a failure back on the client.
 *
 * The three shapes below are the three that actually reach a route's `errorComponent`, and the
 * reason this file exists is that until 2026-09-08 none of them was read at all: every catch
 * site took `.message` and dropped the code, the hint and the action that
 * `server/functions/base.ts` had gone to the trouble of attaching.
 */
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { describeFailure, failureLabel, isSourceOutage, readFailure } from "./errors.ts";

/** What a rejected server function looks like on the client: an `Error` carrying `mm`. */
function wire(body: Record<string, unknown>, message = "boom"): Error {
  const error = new Error(message);
  Object.assign(error, { mm: body, status: body["status"] ?? 500 });
  return error;
}

describe("readFailure", () => {
  it("reads the code, hint, action and status off a rejected server function", () => {
    const failure = readFailure(
      wire({
        code: "SOURCE_UNAVAILABLE",
        message: "musicbrainz answered HTTP 503.",
        hint: "The source is having trouble; this is usually temporary.",
        action: "Retry later",
        status: 503,
      }),
    );
    expect(failure).toMatchObject({
      code: "SOURCE_UNAVAILABLE",
      message: "musicbrainz answered HTTP 503.",
      action: "Retry later",
      status: 503,
      transient: true,
    });
  });

  it("reads an MMError thrown in the same process, which is the SSR case", () => {
    const failure = readFailure(
      new MMError("SOURCE_RATE_LIMITED", "musicbrainz answered HTTP 429.", {
        hint: "The source is asking us to slow down.",
        status: 429,
      }),
    );
    expect(failure.code).toBe("SOURCE_RATE_LIMITED");
    expect(failure.hint).toBe("The source is asking us to slow down.");
    expect(failure.transient).toBe(true);
  });

  /**
   * The SSR path, which is the one that caught this module out.
   *
   * A loader that rejects during the server render has its error inlined into the HTML as
   * `{name, message}` — every custom property assigned by `toFailure` is gone by the time the
   * boundary sees it. `data-error-code` therefore read `UNKNOWN` on a full page load and
   * `NOT_FOUND` on a client navigation, for the same failure. `name` is the carrier that
   * survives both.
   */
  it("falls back to Error.name, which is what survives an SSR-serialised rejection", () => {
    const stripped = new Error("No import with id 0000.");
    stripped.name = "NOT_FOUND";
    expect(readFailure(stripped).code).toBe("NOT_FOUND");
    expect(readFailure(stripped).message).toBe("No import with id 0000.");
  });

  it("does not mistake a JavaScript error name for a code", () => {
    expect(readFailure(new TypeError("x is not a function")).code).toBe("UNKNOWN");
    expect(readFailure(new RangeError("out of range")).code).toBe("UNKNOWN");
    expect(readFailure(new Error("plain")).code).toBe("UNKNOWN");
  });

  it("prefers the full body when both carriers are present", () => {
    const both = wire({ code: "SOURCE_UNAVAILABLE", message: "503", status: 503 }, "503");
    both.name = "SOMETHING_ELSE";
    expect(readFailure(both).code).toBe("SOURCE_UNAVAILABLE");
  });

  it("still says something useful about a plain Error", () => {
    const failure = readFailure(new Error("Bun is not defined"));
    expect(failure.code).toBe("UNKNOWN");
    expect(failure.message).toBe("Bun is not defined");
    expect(failure.hint).toBeNull();
    expect(failure.transient).toBe(false);
  });

  it("never renders an empty string where a sentence goes", () => {
    expect(readFailure(null).message).toBe("Something went wrong.");
    expect(readFailure(wire({ code: "", message: "  " })).code).toBe("UNKNOWN");
  });

  it("treats any 5xx as transient, whatever the code says", () => {
    expect(readFailure(wire({ code: "STEP_FAILED", status: 502 })).transient).toBe(true);
  });
});

describe("isSourceOutage", () => {
  /*
   * This predicate is what decides whether a failed loader keeps its page or hands over to the
   * error boundary, so its boundaries matter more than its happy path.
   */
  it("is true for the three codes that mean the outside world refused", () => {
    for (const code of ["SOURCE_UNAVAILABLE", "SOURCE_RATE_LIMITED", "SOURCE_UNREACHABLE"]) {
      expect(isSourceOutage(wire({ code }))).toBe(true);
    }
  });

  it("is false for a bad identifier or a bad request, which retrying cannot fix", () => {
    expect(isSourceOutage(wire({ code: "NOT_FOUND", status: 404 }))).toBe(false);
    expect(isSourceOutage(wire({ code: "INVALID_INPUT" }))).toBe(false);
    expect(isSourceOutage(new Error("undefined is not a function"))).toBe(false);
  });

  it("is false for SOURCE_HTTP, which is a 4xx the source meant", () => {
    expect(isSourceOutage(wire({ code: "SOURCE_HTTP", status: 400 }))).toBe(false);
  });
});

describe("failureLabel", () => {
  it("quotes the code and the status together when there is one", () => {
    expect(failureLabel(readFailure(wire({ code: "SOURCE_UNAVAILABLE", status: 503 })))).toBe(
      "SOURCE_UNAVAILABLE (HTTP 503)",
    );
  });

  it("is just the code when the failure never crossed HTTP", () => {
    expect(failureLabel(readFailure(new MMError("CANCELLED", "stopped")))).toBe("CANCELLED");
  });
});

/*
 * ------------------------------------------------------------------
 * the five things the error screen can be looking at
 * ------------------------------------------------------------------
 *
 * One case per branch of `ErrorScreen`, tested on the pure function that decides what it says.
 * The panel itself is exercised in `error-screen.test.tsx`; what belongs here is the *sentence*,
 * because the bug the owner reported was a sentence: "This page could not be loaded / Invariant
 * failed / UNKNOWN" is three lines of which none tells a reader anything.
 */
describe("describeFailure", () => {
  it("quotes an MMError and changes nothing about it", () => {
    const failure = readFailure(
      wire({
        code: "SOURCE_UNAVAILABLE",
        message: "musicbrainz answered HTTP 503.",
        hint: "The service is down or throttling us.",
        action: "Retry later",
        status: 503,
      }),
    );
    expect(failure.kind).toBe("typed");
    expect(describeFailure(failure)).toEqual({
      message: "musicbrainz answered HTTP 503.",
      hint: "The service is down or throttling us.",
      action: "Retry later",
      label: "SOURCE_UNAVAILABLE (HTTP 503)",
    });
  });

  it("recognises an abort, and says the connection closed rather than nothing", () => {
    /*
     * The client's half of the owner's bug. The request was killed at ten seconds by the
     * server's idle timeout; what reaches the browser is an abort with no code and no status.
     */
    const aborted = Object.assign(new Error("The user aborted a request."), {
      name: "AbortError",
    });
    const failure = readFailure(aborted);
    const copy = describeFailure(failure);
    expect(failure.kind).toBe("aborted");
    expect(copy.message).toBe("The connection closed before the server answered.");
    expect(copy.label).toBe("Connection interrupted");
    expect(copy.action).toBe("Try again");
    expect(copy.hint).toContain("asking again is safe");
    // Transient, so the panel is a warning and the reassurance under Retry is the right one.
    expect(failure.transient).toBe(true);
  });

  it("recognises what every engine calls a dead connection, by its own words", () => {
    // Chromium, Firefox, Safari and undici each word it differently and none gives a code.
    for (const message of [
      "Failed to fetch",
      "NetworkError when attempting to fetch resource.",
      "Load failed",
      "fetch failed",
    ]) {
      expect(readFailure(new TypeError(message)).kind).toBe("offline");
    }
    const copy = describeFailure(readFailure(new TypeError("Failed to fetch")));
    expect(copy.message).toBe("Music Manager could not be reached.");
    expect(copy.label).toBe("Network unavailable");
    expect(copy.hint).toContain("still running");
  });

  it("says the server failed when a 5xx arrives with nothing else", () => {
    const failure = readFailure(Object.assign(new Error("Invariant failed"), { status: 500 }));
    const copy = describeFailure(failure);
    expect(failure.kind).toBe("server");
    expect(copy.message).toBe("The server failed while loading this page.");
    expect(copy.label).toBe("Server error (HTTP 500)");
    expect(copy.hint).toContain("not in this browser");
  });

  it("never shows a person the word UNKNOWN", () => {
    /*
     * Verbatim what the owner read. `tiny-invariant` strips its message in a production build,
     * so the router's assertion arrives saying only that an assertion failed — and the decoder,
     * finding no code, printed its own placeholder in the slot meant for one.
     */
    const failure = readFailure(new Error("Invariant failed"));
    const copy = describeFailure(failure);
    expect(failure.kind).toBe("unknown");
    expect(copy.message).toBe("This page's data could not be read.");
    // The machine-readable code is still UNKNOWN; what changed is that nothing prints it.
    expect(failure.code).toBe("UNKNOWN");
    expect(copy.label).toBeNull();
    expect(copy.hint).toContain("journal");
  });

  it("keeps a plain Error's message when the message actually says something", () => {
    // "Bun is not defined" is a real clue and the reader should keep it; only the empty
    // formulas are replaced.
    const copy = describeFailure(readFailure(new Error("Bun is not defined")));
    expect(copy.message).toBe("Bun is not defined");
    expect(copy.label).toBeNull();
  });
});
