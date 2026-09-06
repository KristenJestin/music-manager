// @vitest-environment happy-dom
/**
 * The list and the detail must colour a job's steps the same way (owner review, B2).
 *
 * The bug this pins down: the list drew a running step blinking blue and a failed one red,
 * while the detail page drew both amber, because it used the wizard's neutral `Stepper`.
 * Both now read `stepStates`, so the assertions below hold for the two renderings at once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { STEPS } from "#/server/db/schema/enums.vocab.ts";
import { PipelineDots, PipelineStepper, STEP_STATE_TONE, stepStates } from "./pipeline-dots.tsx";

afterEach(cleanup);

describe("stepStates", () => {
  it("marks everything done when the import is, whatever step it rests on", () => {
    expect(stepStates("tag", "done")).toEqual(STEPS.map(() => "done"));
  });

  it("marks the failing step failed and the ones before it done", () => {
    const states = stepStates("tag", "failed");
    expect(states[STEPS.indexOf("tag")]).toBe("fail");
    expect(states.filter((state) => state === "done")).toHaveLength(STEPS.indexOf("tag"));
    expect(states[STEPS.indexOf("place")]).toBe("todo");
  });

  it("marks a running step active and a step waiting on a human as waiting", () => {
    expect(stepStates("download", "running")[STEPS.indexOf("download")]).toBe("active");
    expect(stepStates("confirm", "awaiting_review")[STEPS.indexOf("confirm")]).toBe("wait");
  });

  it("gives every state a tone from the shared vocabulary", () => {
    expect(STEP_STATE_TONE).toEqual({
      done: "ok",
      active: "info",
      wait: "warn",
      fail: "danger",
      todo: "muted",
    });
  });
});

describe("the two renderings agree", () => {
  it("draws a failed job red in the list and red in the detail", () => {
    const dots = render(<PipelineDots step="tag" status="failed" />).container;
    const stepper = render(<PipelineStepper step="tag" status="failed" />).container;
    expect(dots.querySelectorAll('[data-state="fail"]')).toHaveLength(1);
    expect(stepper.querySelectorAll('[data-state="fail"]')).toHaveLength(1);
    expect(dots.querySelectorAll("i.bg-danger")).toHaveLength(1);
    expect(stepper.querySelectorAll(".bg-danger")).toHaveLength(1);
  });

  it("blinks the running step in both, rather than freezing it amber in one", () => {
    const dots = render(<PipelineDots step="download" status="running" />).container;
    const stepper = render(<PipelineStepper step="download" status="running" />).container;
    expect(dots.querySelectorAll(".animate-blink")).toHaveLength(1);
    expect(stepper.querySelectorAll(".animate-blink")).toHaveLength(1);
    expect(stepper.querySelectorAll(".bg-warn")).toHaveLength(0);
  });

  it("names every step in the detail so the page is readable without the tooltip", () => {
    const { container } = render(<PipelineStepper step="verify" status="done" />);
    expect(container.querySelectorAll("li")).toHaveLength(STEPS.length);
    expect(container.textContent).toContain("fingerprint");
  });
});
