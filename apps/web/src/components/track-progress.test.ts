/**
 * The fold behind the per-track detail the owner asked for (C2, C7).
 *
 * `liveTracks` is the only piece of that feature with any logic in it, and it is a pure
 * function of the journal — so it is tested here rather than through a browser, and the
 * awkward cases (a postprocess line with no percentage, a track that finishes, a track
 * queueing for the download slot) are cheap to state.
 */
import { describe, expect, it } from "vitest";
import type { JobEventPayload } from "@mm/contracts";
import { liveTracks } from "./track-progress.tsx";

let nextId = 1;

function event(
  type: string,
  trackId: string | null,
  message: string,
  data: Record<string, unknown> | null = null,
): JobEventPayload {
  return {
    id: nextId++,
    importId: "imp_1",
    trackId,
    step: "download",
    level: "info",
    type,
    message,
    data,
    at: new Date().toISOString(),
  };
}

describe("liveTracks", () => {
  it("keeps the newest line per track and nothing else", () => {
    const live = liveTracks([
      event("track.started", "t1", "A: downloading"),
      event("track.progress", "t1", "A: downloading 20%", { stage: "download", percent: 20 }),
      event("track.progress", "t1", "A: downloading 80%", {
        stage: "download",
        percent: 80,
        speed: 1_500_000,
        eta: 12,
      }),
      event("track.started", "t2", "B: downloading"),
    ]);

    expect([...live.keys()]).toEqual(["t1", "t2"]);
    expect(live.get("t1")).toMatchObject({ percent: 80, speed: 1_500_000, eta: 12 });
  });

  it("forgets a track the moment it finishes, fails or is skipped", () => {
    for (const ending of ["track.done", "track.failed", "track.skipped"]) {
      const live = liveTracks([
        event("track.progress", "t1", "A: downloading 90%", { stage: "download", percent: 90 }),
        event(ending, "t1", "A: over"),
      ]);
      expect(live.has("t1"), `${ending} should clear the row`).toBe(false);
    }
  });

  it("shows a postprocess sub-step instead of freezing the bar at the last percentage", () => {
    // yt-dlp's `ExtractAudio` can take a minute and carries no percentage. Keeping the old one
    // would paint a bar stuck at 99% under the word "ExtractAudio", which reads as a stall.
    const live = liveTracks([
      event("track.progress", "t1", "A: downloading 99%", { stage: "download", percent: 99 }),
      event("track.progress", "t1", "A: ExtractAudio", { stage: "ExtractAudio" }),
    ]);
    expect(live.get("t1")).toMatchObject({ stage: "ExtractAudio", percent: null });
  });

  it("marks a track that is queueing for the single download slot", () => {
    const live = liveTracks([
      event("track.waiting", "t1", "A: waiting for the download slot", { reason: "LOCKED" }),
    ]);
    expect(live.get("t1")).toMatchObject({ waiting: true, stage: "waiting" });
  });

  it("names the rate-limit pause between two downloads", () => {
    // The jitter is longer than the fixture download it precedes, so this line is what a track
    // row shows most of the time. Without a `stage` the fold fell back to the word "working" —
    // the pause is deliberate, and it should read as a phase rather than as no information.
    const live = liveTracks([
      event("track.progress", "t1", "Waiting 7s before the next download.", {
        stage: "pausing",
        jitterMs: 7000,
      }),
    ]);
    expect(live.get("t1")).toMatchObject({ stage: "pausing", percent: null, waiting: false });
  });

  it("ignores everything that is not about a track", () => {
    const live = liveTracks([
      event("step.started", null, "download started"),
      event("import.status", null, "Retrying from download."),
    ]);
    expect(live.size).toBe(0);
  });

  it("survives a line whose data the orchestrator did not fill in", () => {
    const live = liveTracks([event("track.started", "t1", "A: filing into the library")]);
    expect(live.get("t1")).toMatchObject({
      stage: null,
      percent: null,
      message: "A: filing into the library",
    });
  });
});
