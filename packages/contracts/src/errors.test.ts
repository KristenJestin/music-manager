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
    expect(new MMError("UNKNOWN", "nope").toBody()).toEqual({ code: "UNKNOWN", message: "nope" });
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
});
