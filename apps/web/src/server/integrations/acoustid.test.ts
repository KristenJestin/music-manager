/**
 * Decision 052's blind spot, closed (owner review B8).
 *
 * AcoustID answers HTTP 400 both for "that fingerprint is nonsense" and for "that API key is
 * wrong". `lookup` swallowed every 400 as an absence — which is right for the first (decision
 * 011: silence is not disagreement) and catastrophic for the second, because it disabled the
 * fingerprint safety net without a word and let the Console report the key as accepted.
 */
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { ACOUSTID_ERROR, acoustidError, isKeyRejection } from "./acoustid.ts";

const refusal = (code: number, message: string): MMError =>
  new MMError("SOURCE_HTTP", "acoustid answered HTTP 400.", {
    status: 400,
    details: { body: JSON.stringify({ status: "error", error: { code, message } }) },
  });

describe("acoustidError", () => {
  it("reads the code and message out of the body of a refusal", () => {
    const described = acoustidError(refusal(ACOUSTID_ERROR.invalidApiKey, "invalid API key"));
    expect(described).toEqual({ code: 4, message: "invalid API key" });
  });

  it("is null when there is no body, no JSON, or no code to read", () => {
    expect(acoustidError(new MMError("SOURCE_HTTP", "boom", { status: 400 }))).toBeNull();
    expect(
      acoustidError(
        new MMError("SOURCE_HTTP", "boom", { status: 400, details: { body: "<html>" } }),
      ),
    ).toBeNull();
    expect(acoustidError(new Error("not an MMError"))).toBeNull();
  });
});

describe("isKeyRejection", () => {
  it("is true for the two API-key codes", () => {
    expect(isKeyRejection(refusal(ACOUSTID_ERROR.invalidApiKey, "invalid API key"))).toBe(true);
    expect(isKeyRejection(refusal(ACOUSTID_ERROR.invalidUserApiKey, "invalid user API key"))).toBe(
      true,
    );
  });

  it("is true when AcoustID only says it in words", () => {
    expect(isKeyRejection(refusal(99, "the API key is not valid"))).toBe(true);
  });

  it("is false for a fingerprint AcoustID could not parse — that one really is silence", () => {
    expect(isKeyRejection(refusal(ACOUSTID_ERROR.invalidFingerprint, "invalid fingerprint"))).toBe(
      false,
    );
    expect(isKeyRejection(refusal(2, "missing parameter"))).toBe(false);
    expect(isKeyRejection(new Error("network"))).toBe(false);
  });
});
