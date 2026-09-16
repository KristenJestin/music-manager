/**
 * `MMError` on the wire — the half the MCP test report (§3) found broken.
 *
 * The scenario these tests encode, exactly as it happened on 2026-09-06: the toolbox image
 * predated `cookies_content`, so pydantic answered every `POST /extract` with
 * `422 {"detail":[{"type":"extra_forbidden","loc":["body","cookies_content"],…}]}`. That body
 * does not match `mmErrorBodySchema`, `fromBody` threw it away, and what reached the database
 * and the MCP server was `{"code":"UNKNOWN","message":"POST /extract failed."}`. Every import
 * failed and nothing anywhere said why.
 */
import { describe, expect, it } from "vitest";
import { MMError, mmErrorBodySchema } from "./errors.ts";

describe("MMError.toBody", () => {
  it("serialises the HTTP status, which used to be set and then dropped", () => {
    const body = new MMError("LOCKED", "A download is already running.", { status: 409 }).toBody();
    expect(body.status).toBe(409);
    expect(mmErrorBodySchema.parse(body).status).toBe(409);
  });

  it("omits what is absent rather than writing nulls", () => {
    // `retryable` is always present, and deliberately so: it is a boolean with a meaning for
    // both values, and a reader that has to distinguish "false" from "the writer was old"
    // cannot. The optional fields below are absences, which is a different thing.
    expect(new MMError("UNKNOWN", "nope").toBody()).toEqual({
      code: "UNKNOWN",
      message: "nope",
      retryable: true,
    });
    expect(new MMError("NOT_FOUND", "gone").toBody()).toEqual({
      code: "NOT_FOUND",
      message: "gone",
      retryable: false,
    });
  });

  it("carries the retryable judgement to the row, which is where it is read back", () => {
    // It used to live on the instance only, so `job_steps.error` and `imports.error` — the two
    // rows the step machine consults when it decides whether a failure is worth waiting out —
    // could not see it at all.
    const busy = new MMError("SOURCE_UNAVAILABLE", "musicbrainz answered HTTP 503.", {
      status: 503,
      retryable: true,
    });
    const stored = JSON.parse(JSON.stringify(busy.toBody())) as unknown;
    expect(mmErrorBodySchema.parse(stored).retryable).toBe(true);
    expect(MMError.fromBody(stored).retryable).toBe(true);
  });

  it("falls back to the code's own default when a stored body predates the flag", () => {
    // Rows written before the column existed have no `retryable`. They must keep meaning what
    // they meant, not become `false` because a key is missing.
    expect(MMError.fromBody({ code: "TIMEOUT", message: "slow" }).retryable).toBe(true);
    expect(MMError.fromBody({ code: "INVALID_INPUT", message: "bad" }).retryable).toBe(false);
  });

  it("round-trips through fromBody without losing status or details", () => {
    const original = new MMError("YTDLP_403", "Forbidden.", {
      status: 403,
      hint: "Refresh the cookies.",
      action: "Update cookies",
      details: { url: "https://example.test" },
    });
    const back = MMError.fromBody(original.toBody());
    expect(back.code).toBe("YTDLP_403");
    expect(back.status).toBe(403);
    expect(back.hint).toBe("Refresh the cookies.");
    expect(back.details).toEqual({ url: "https://example.test" });
  });
});

describe("MMError.fromBody on a body that is not ours", () => {
  const fastapi422 = {
    detail: [
      {
        type: "extra_forbidden",
        loc: ["body", "cookies_content"],
        msg: "Extra inputs are not permitted",
        input: null,
      },
    ],
  };

  it("keeps FastAPI's detail as an actionable message", () => {
    const error = MMError.fromBody(fastapi422, "POST /extract failed with HTTP 422.");
    expect(error.message).toContain("POST /extract failed with HTTP 422.");
    expect(error.message).toContain("cookies_content");
    expect(error.message).toContain("Extra inputs are not permitted");
    // Not `UNKNOWN`: a refused request body is invalid input, and saying so is the point.
    expect(error.code).toBe("INVALID_INPUT");
  });

  it("names the stale image, because that is what extra_forbidden means here", () => {
    const error = MMError.fromBody(fastapi422, "POST /extract failed with HTTP 422.");
    expect(error.hint ?? "").toContain("older than the code");
    expect(error.action ?? "").toContain("stack:up --build");
  });

  it("survives the trip through toBody into a database row and back", () => {
    const stored = MMError.fromBody(fastapi422, "POST /extract failed with HTTP 422.").toBody();
    const read = MMError.fromBody(JSON.parse(JSON.stringify(stored)));
    expect(read.message).toContain("cookies_content");
    expect(read.details?.["body"]).toBeDefined();
  });

  it("handles FastAPI's string form of detail", () => {
    const error = MMError.fromBody({ detail: "Not authenticated" }, "GET /health failed.");
    expect(error.message).toBe("GET /health failed. Not authenticated");
  });

  it("summarises an unrecognised body instead of discarding it", () => {
    const error = MMError.fromBody({ oops: "gateway timeout upstream" }, "POST /tag failed.");
    expect(error.code).toBe("UNKNOWN");
    expect(error.message).toContain("gateway timeout upstream");
  });

  it("truncates a large body rather than pasting it whole into a log line", () => {
    const error = MMError.fromBody({ html: "x".repeat(5_000) }, "POST /tag failed.");
    expect(error.message.length).toBeLessThan(600);
    expect(error.message).toContain("…");
  });

  it("falls back cleanly when there is genuinely nothing to say", () => {
    expect(MMError.fromBody(null, "POST /probe failed.").message).toBe("POST /probe failed.");
    expect(MMError.fromBody({}, "POST /probe failed.").message).toBe("POST /probe failed.");
  });

  /*
   * The toolbox models both fields as `str`, with `""` for "nothing to say" — so a decoded
   * error arrived with `action: ""` beside a filled `hint`, and a reader had to know that the
   * empty string and the absent key mean the same thing here but not there.
   */
  it("omits an empty action rather than putting an empty string on the wire", () => {
    const decoded = MMError.fromBody({
      code: "UNKNOWN",
      message: "This video is unavailable",
      hint: "No known cause matched; the original message is in `message`.",
      action: "",
    });
    expect(decoded.action).toBeUndefined();
    expect(decoded.toBody()).not.toHaveProperty("action");
    expect(decoded.toBody().hint).toContain("No known cause matched");
  });

  it("keeps an action that says something", () => {
    const decoded = MMError.fromBody({
      code: "INVALID_INPUT",
      message: "Extra inputs are not permitted",
      action: "Rebuild the toolbox image (`bun run stack:up --build`)",
    });
    expect(decoded.toBody().action).toContain("stack:up --build");
  });
});
