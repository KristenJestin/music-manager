/**
 * The Retry menu's list, which is also the server's allow-list.
 *
 * One function decides what the chevron offers and what `retryJob` will accept, so the two
 * cannot disagree — which is the whole reason it is a pure module rather than a `<select>` in a
 * component and a `z.enum` in a handler. These tests are about the two rules that make the list
 * worth reading: never past the head, and `confirm` is not a step you retry.
 */
import { describe, expect, it } from "vitest";
import { forgetsMapping, retryOptionsFor } from "./retry-plan.ts";

const steps = (options: { step: string }[]): string[] => options.map((option) => option.step);

describe("retryOptionsFor", () => {
  it("offers every work step of a finished album — the case the Console could not reach", () => {
    // `done` at `verify` used to mean one retry, `verify`, because that is the resume point.
    expect(steps(retryOptionsFor({ status: "done", step: "verify" }))).toEqual([
      "resolve",
      "match",
      "download",
      "fingerprint",
      "tag",
      "place",
      "verify",
    ]);
  });

  it("never offers a step the import has not reached", () => {
    expect(steps(retryOptionsFor({ status: "failed", step: "download" }))).toEqual([
      "resolve",
      "match",
      "download",
    ]);
    // A job that has only ever resolved cannot be re-matched against a listing it does not have.
    expect(steps(retryOptionsFor({ status: "pending", step: "resolve" }))).toEqual(["resolve"]);
  });

  /*
   * `confirm` is a gate, not work. Rewinding to it and rewinding to `match` differ only in
   * whether the mapping is recomputed, and both entries around it already say so in words.
   */
  it("never offers `confirm`", () => {
    const at = retryOptionsFor({ status: "awaiting_confirm", step: "confirm" });
    expect(steps(at)).toEqual(["resolve", "match"]);
  });

  it("offers nothing for a cancelled import, like the button that is not drawn", () => {
    expect(retryOptionsFor({ status: "cancelled", step: "verify" })).toEqual([]);
  });

  /* The UI must say what is lost *before* it happens, so the sentence lives on the entry. */
  it("marks exactly the two steps that discard the confirmed mapping, each with a warning", () => {
    const options = retryOptionsFor({ status: "done", step: "verify" });
    const destructive = options.filter((option) => option.destructive);

    expect(steps(destructive)).toEqual(["resolve", "match"]);
    expect(destructive.every((option) => option.warning !== null)).toBe(true);
    expect(destructive.every((option) => /mapping/i.test(option.warning ?? ""))).toBe(true);
    // And the rest carry no warning at all, so a dialog never appears for a harmless step.
    expect(
      options.filter((option) => !option.destructive).every((option) => option.warning === null),
    ).toBe(true);
  });

  it("gives every entry a sentence saying what it redoes", () => {
    for (const option of retryOptionsFor({ status: "done", step: "verify" })) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.detail.length).toBeGreaterThan(20);
    }
  });
});

describe("forgetsMapping", () => {
  it("is true for the two steps that recompute the mapping, and false for the rest", () => {
    expect(forgetsMapping("resolve")).toBe(true);
    expect(forgetsMapping("match")).toBe(true);
    for (const step of ["confirm", "download", "fingerprint", "tag", "place", "verify"] as const) {
      expect(forgetsMapping(step)).toBe(false);
    }
  });
});
