// @vitest-environment happy-dom
/**
 * The list and the detail must colour a job's steps the same way (owner review, B2), and more
 * than one step must be able to read "running" at once (owner review, fourth round, F3) —
 * `download`, `fingerprint`, `tag` and `place` overlap since decision 147, and a stepper that
 * can only light one dot at a time was lying about it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { STEPS } from "#/server/db/schema/enums.vocab.ts";
import {
  PipelineDots,
  PipelineStepper,
  STEP_STATE_TONE,
  pipelineCount,
  stepStates,
  type StepRow,
} from "./pipeline-dots.tsx";

afterEach(cleanup);

/** Every step `done`/`skipped` up to (excluding) `head`, `head` itself carrying `headStatus`,
 *  everything after untouched (`row: null`) — the shape a fresh job's `job_steps` really has. */
function rowsUpTo(head: string, headStatus: StepRow["row"]): StepRow[] {
  const headIndex = STEPS.indexOf(head as (typeof STEPS)[number]);
  return STEPS.map((step, index) => ({
    step,
    row: index < headIndex ? { status: "done" } : index === headIndex ? headStatus : null,
  }));
}

describe("stepStates", () => {
  it("marks everything done when the import is, whatever its rows say", () => {
    const rows = rowsUpTo("tag", { status: "running" });
    expect(stepStates(rows, "done")).toEqual(STEPS.map(() => "done"));
  });

  it("marks the failing step failed and the ones before it done", () => {
    const rows = rowsUpTo("tag", { status: "failed" });
    const states = stepStates(rows, "failed");
    expect(states[STEPS.indexOf("tag")]).toBe("fail");
    expect(states.filter((state) => state === "done")).toHaveLength(STEPS.indexOf("tag"));
    expect(states[STEPS.indexOf("place")]).toBe("todo");
  });

  it("marks a running step active and a step waiting on a human as waiting", () => {
    expect(
      stepStates(rowsUpTo("download", { status: "running" }), "running")[STEPS.indexOf("download")],
    ).toBe("active");
    expect(
      stepStates(rowsUpTo("confirm", { status: "blocked" }), "awaiting_review")[
        STEPS.indexOf("confirm")
      ],
    ).toBe("wait");
  });

  it("marks every step whose row is running active, all at once (F3)", () => {
    // `download` finished this pass over the album, `fingerprint`/`tag`/`place` are each
    // partway through their own tracks — the pipelined overlap of decision 147.
    const rows: StepRow[] = STEPS.map((step) => ({
      step,
      row:
        step === "resolve" || step === "match" || step === "confirm" || step === "download"
          ? { status: "done" }
          : step === "verify"
            ? null
            : { status: "running" },
    }));
    const states = stepStates(rows, "running");
    expect(states[STEPS.indexOf("fingerprint")]).toBe("active");
    expect(states[STEPS.indexOf("tag")]).toBe("active");
    expect(states[STEPS.indexOf("place")]).toBe("active");
    expect(states.filter((state) => state === "active")).toHaveLength(3);
  });

  it("turns an unfinished row to todo, not wait, on a cancelled job", () => {
    const rows = rowsUpTo("fingerprint", { status: "running" });
    expect(stepStates(rows, "cancelled")[STEPS.indexOf("fingerprint")]).toBe("todo");
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

describe("pipelineCount", () => {
  it("counts how many tracks have passed each pipelined step, over every track", () => {
    // The owner's own example (F3): 17 tracks, download 8/17, fingerprint 4/17, tag 2/17,
    // place 2/17. Each count is cumulative — a `placed` track has also passed `fingerprint`
    // and `tag` — so the four numbers only need to be non-increasing, not disjoint buckets.
    const tracks = [
      ...Array.from({ length: 2 }, () => ({ state: "placed" as const })),
      ...Array.from({ length: 2 }, () => ({ state: "fingerprinted" as const })),
      ...Array.from({ length: 4 }, () => ({ state: "downloaded" as const })),
      ...Array.from({ length: 9 }, () => ({ state: "pending" as const })),
    ];
    expect(pipelineCount(tracks, "download")).toEqual({ done: 8, total: 17 });
    expect(pipelineCount(tracks, "fingerprint")).toEqual({ done: 4, total: 17 });
    expect(pipelineCount(tracks, "tag")).toEqual({ done: 2, total: 17 });
    expect(pipelineCount(tracks, "place")).toEqual({ done: 2, total: 17 });
  });

  it("treats a track that left the line for good as having passed everything ahead of it", () => {
    const tracks = [{ state: "failed" as const }, { state: "skipped" as const }];
    expect(pipelineCount(tracks, "place")).toEqual({ done: 2, total: 2 });
  });
});

describe("the two renderings agree", () => {
  it("draws a failed job red in the list and red in the detail", () => {
    const rows = rowsUpTo("tag", { status: "failed" });
    const dots = render(<PipelineDots steps={rows} headStep="tag" status="failed" />).container;
    const stepper = render(
      <PipelineStepper steps={rows} headStep="tag" status="failed" />,
    ).container;
    expect(dots.querySelectorAll('[data-state="fail"]')).toHaveLength(1);
    expect(stepper.querySelectorAll('[data-state="fail"]')).toHaveLength(1);
    expect(dots.querySelectorAll("i.bg-danger")).toHaveLength(1);
    expect(stepper.querySelectorAll(".bg-danger")).toHaveLength(1);
  });

  it("blinks the running step in both, rather than freezing it amber in one", () => {
    const rows = rowsUpTo("download", { status: "running" });
    const dots = render(
      <PipelineDots steps={rows} headStep="download" status="running" />,
    ).container;
    const stepper = render(
      <PipelineStepper steps={rows} headStep="download" status="running" />,
    ).container;
    expect(dots.querySelectorAll(".animate-blink")).toHaveLength(1);
    expect(stepper.querySelectorAll(".animate-blink")).toHaveLength(1);
    expect(stepper.querySelectorAll(".bg-warn")).toHaveLength(0);
  });

  it("names every step in the detail so the page is readable without the tooltip", () => {
    const rows = STEPS.map((step) => ({ step, row: { status: "done" as const } }));
    const { container } = render(<PipelineStepper steps={rows} headStep="verify" status="done" />);
    expect(container.querySelectorAll("li")).toHaveLength(STEPS.length);
    expect(container.textContent).toContain("fingerprint");
  });

  it("rings the head step and shows its per-track count, in the stepper only", () => {
    const rows = rowsUpTo("fingerprint", { status: "running" });
    const tracks = [
      { state: "downloaded" as const },
      { state: "downloaded" as const },
      { state: "pending" as const },
    ];
    const { container } = render(
      <PipelineStepper steps={rows} headStep="fingerprint" status="running" tracks={tracks} />,
    );
    const head = container.querySelector('[data-head="true"]');
    expect(head).not.toBeNull();
    expect(head?.querySelector('[data-testid="step-count"]')?.textContent).toBe("0/3");
  });
});
