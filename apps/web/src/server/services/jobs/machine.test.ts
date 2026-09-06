import { describe, expect, it } from "vitest";
import {
  backoffMs,
  isBefore,
  isResumable,
  isTerminal,
  jitterMs,
  nextStep,
  resumePoint,
  stepsFrom,
  STEP_ORDER,
  transition,
  type StepResult,
} from "./machine.ts";

/**
 * The machine is the one part of the orchestrator with no I/O in it, so it is the one part
 * that can be pinned down completely. Everything the pipeline does about *state* — resume,
 * retry, blocking on a human — is a consequence of `transition` and `resumePoint`.
 */

describe("the order of the steps", () => {
  it("is the eight of docs/04, in that order", () => {
    expect([...STEP_ORDER]).toEqual([
      "resolve",
      "match",
      "confirm",
      "download",
      "fingerprint",
      "tag",
      "place",
      "verify",
    ]);
  });

  it("ends after verify", () => {
    expect(nextStep("place")).toBe("verify");
    expect(nextStep("verify")).toBeNull();
  });

  it("knows what a retry has to re-run", () => {
    expect(stepsFrom("tag")).toEqual(["tag", "place", "verify"]);
    expect(isBefore("download", "tag")).toBe(true);
    expect(isBefore("tag", "download")).toBe(false);
  });
});

describe("transition", () => {
  const done: StepResult = { status: "done" };

  it("moves to the next step and keeps going", () => {
    expect(transition("resolve", done)).toEqual({
      step: "match",
      status: "running",
      stepStatus: "done",
      continues: true,
    });
  });

  it("treats a skipped step exactly like a done one, except in the record", () => {
    const moved = transition("download", { status: "skipped", message: "already present" });
    expect(moved.step).toBe("fingerprint");
    expect(moved.continues).toBe(true);
    expect(moved.stepStatus).toBe("skipped");
  });

  it("finishes the import after the last step", () => {
    const moved = transition("verify", done);
    expect(moved).toEqual({
      step: "verify",
      status: "done",
      stepStatus: "done",
      continues: false,
    });
  });

  it("rests *on* the blocking step, so resuming re-runs it", () => {
    // The reason the job stopped is the step itself. Moving past it would lose that.
    const moved = transition("confirm", { status: "blocked", blockedAs: "awaiting_confirm" });
    expect(moved.step).toBe("confirm");
    expect(moved.status).toBe("awaiting_confirm");
    expect(moved.continues).toBe(false);
  });

  it("defaults a block with no stated reason to a plain pause", () => {
    expect(transition("download", { status: "blocked" }).status).toBe("paused");
  });

  it("leaves a failed job on the step that failed", () => {
    const moved = transition("tag", { status: "failed", message: "boom" });
    expect(moved).toEqual({
      step: "tag",
      status: "failed",
      stepStatus: "failed",
      continues: false,
    });
  });
});

describe("terminal and resumable statuses", () => {
  it("separates the two", () => {
    for (const status of ["done", "failed", "cancelled"] as const) {
      expect(isTerminal(status)).toBe(true);
      expect(isResumable(status)).toBe(false);
    }
    for (const status of ["pending", "running", "paused"] as const) {
      expect(isTerminal(status)).toBe(false);
      expect(isResumable(status)).toBe(true);
    }
  });

  it("does not resume a job waiting for a human", () => {
    expect(isResumable("awaiting_confirm")).toBe(false);
    expect(isResumable("awaiting_review")).toBe(false);
  });
});

describe("a step that names where to restart", () => {
  // Owner review C6: `verify` finds that a file it placed has disappeared. That is a track to
  // fetch again, not an import to abandon — and a plain `failed` left the job stuck, because
  // `resumePoint` restarts at the first step that is not done, which was `verify` itself.
  it("rewinds instead of stopping the job", () => {
    expect(transition("verify", { status: "failed", restartAt: "download" })).toEqual({
      step: "download",
      status: "running",
      stepStatus: "failed",
      continues: true,
    });
  });

  it("refuses to jump forward, so it cannot become a second pipeline order", () => {
    expect(transition("download", { status: "failed", restartAt: "verify" })).toEqual({
      step: "download",
      status: "failed",
      stepStatus: "failed",
      continues: false,
    });
    expect(transition("verify", { status: "failed", restartAt: "verify" }).continues).toBe(false);
  });

  it("is ignored on any outcome but a failure", () => {
    expect(transition("verify", { status: "done", restartAt: "download" })).toEqual({
      step: "verify",
      status: "done",
      stepStatus: "done",
      continues: false,
    });
  });
});

describe("resumePoint", () => {
  it("restarts at the first step that did not finish", () => {
    expect(resumePoint({ resolve: "done", match: "done", confirm: "blocked" })).toBe("confirm");
  });

  it("walks past a skipped step, which is finished too", () => {
    expect(
      resumePoint({ resolve: "done", match: "done", confirm: "done", download: "skipped" }),
    ).toBe("fingerprint");
  });

  it("re-runs a failed step rather than stepping over it", () => {
    expect(resumePoint({ resolve: "done", match: "failed" })).toBe("match");
  });

  it("falls back when every step is finished", () => {
    const all = Object.fromEntries(STEP_ORDER.map((step) => [step, "done" as const]));
    expect(resumePoint(all, "verify")).toBe("verify");
  });

  it("starts at the beginning when nothing has run", () => {
    expect(resumePoint({})).toBe("resolve");
  });
});

describe("jitterMs", () => {
  it("stays inside the window, endpoints included", () => {
    expect(jitterMs(5000, 15000, () => 0)).toBe(5000);
    expect(jitterMs(5000, 15000, () => 0.999999)).toBe(15000);
    expect(jitterMs(5000, 15000, () => 0.5)).toBe(10000);
  });

  it("collapses to a constant when the window is empty — fixtures mode", () => {
    expect(jitterMs(0, 0, () => 0.7)).toBe(0);
  });

  it("tolerates a reversed window rather than returning nonsense", () => {
    const value = jitterMs(15000, 5000, () => 0.25);
    expect(value).toBeGreaterThanOrEqual(5000);
    expect(value).toBeLessThanOrEqual(15000);
  });

  it("never goes negative", () => {
    expect(jitterMs(-100, -10, () => 0.5)).toBe(0);
  });
});

describe("backoffMs", () => {
  it("doubles from the base, one-based on the attempt", () => {
    expect(backoffMs(1, 5000, 300_000)).toBe(5000);
    expect(backoffMs(2, 5000, 300_000)).toBe(10_000);
    expect(backoffMs(3, 5000, 300_000)).toBe(20_000);
  });

  it("is capped, because without a cap the fourth retry lands tomorrow", () => {
    expect(backoffMs(20, 5000, 300_000)).toBe(300_000);
  });

  it("is zero before the first attempt", () => {
    expect(backoffMs(0, 5000, 300_000)).toBe(0);
  });
});
