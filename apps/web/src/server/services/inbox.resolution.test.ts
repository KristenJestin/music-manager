/**
 * What an Inbox answer means, before anything is written.
 *
 * The regression this file exists for: an answer that is a **choice** — a release MBID, a
 * recording MBID — carries no `action`, and `applyResolution` used to open with
 * `if (typeof action !== "string") return;`. The item was closed, a `decisions` row was
 * written, the Console said "the job resumes", and nothing happened. The owner's
 * *Good Luck, Babe!* is that bug, twice over: the decision was lost *and* the promise was
 * false.
 */
import { describe, expect, it } from "vitest";
import { MMError } from "@mm/contracts";
import { planResolution } from "./inbox.resolution.ts";
import type { InboxType } from "#/server/db/schema/enums.vocab.ts";

const on = (type: InboxType) => ({ type });

describe("planResolution — a chosen candidate", () => {
  it("reads a bare recording MBID as a pin, not as nothing", () => {
    expect(planResolution(on("ambiguous_recording"), { recordingMbid: "rec-1" })).toEqual({
      kind: "pin-recording",
      recordingMbid: "rec-1",
      releaseMbid: null,
    });
  });

  it("keeps the borrow release when the card offered one", () => {
    expect(
      planResolution(on("ambiguous_recording"), {
        recordingMbid: "rec-1",
        releaseMbid: "rel-9",
        accepted: true,
      }),
    ).toEqual({ kind: "pin-recording", recordingMbid: "rec-1", releaseMbid: "rel-9" });
  });

  it("reads a bare release MBID as a pin", () => {
    expect(planResolution(on("ambiguous_release"), { releaseMbid: "rel-1" })).toEqual({
      kind: "pin-release",
      releaseMbid: "rel-1",
    });
  });

  /*
   * `resolveInboxBatch` builds `{accepted: true, ...preselected}`, and the preselection of an
   * `ambiguous_release` raised by the preselection floor *is* a release id. Accepting the
   * card in bulk therefore has to pin it, exactly as clicking it does.
   */
  it("treats the preselected answer of a bulk accept the same as a click", () => {
    expect(
      planResolution(on("ambiguous_release"), { accepted: true, releaseMbid: "rel-2" }),
    ).toEqual({ kind: "pin-release", releaseMbid: "rel-2" });
  });

  /** An MBID in the payload of a card whose question is not "which one?" pins nothing. */
  it("does not pin from an item type whose answer is not an entity", () => {
    expect(planResolution(on("verify_mismatch"), { accepted: true, releaseMbid: "rel-3" })).toEqual(
      { kind: "none" },
    );
  });
});

describe("planResolution — an answer no branch handles", () => {
  it("refuses an acceptance that names nothing on a card that asks which one", () => {
    expect(() => planResolution(on("ambiguous_release"), { accepted: true })).toThrow(MMError);
    expect(() => planResolution(on("ambiguous_recording"), { accepted: true })).toThrow(
      /names no release or recording/,
    );
  });

  /*
   * The guarantee, in one test: a new option added to `optionsFor` and wired to nothing fails
   * on the first click rather than closing the item in silence.
   */
  it("refuses a verb nothing carries out", () => {
    expect(() => planResolution(on("job_failed"), { action: "teleport" })).toThrow(MMError);
    try {
      planResolution(on("job_failed"), { action: "teleport" });
    } catch (error) {
      const failure = MMError.from(error);
      expect(failure.code).toBe("INVALID_INPUT");
      expect(failure.status).toBe(400);
      expect(failure.message).toContain("teleport");
      expect(failure.message).toContain("stays open");
    }
  });

  /**
   * The untagged offer is a `retry` carrying a flag, and it has to stay one.
   *
   * Reworded into a verb of its own — `{action: "import_untagged"}` reads well enough that
   * somebody will try it — it is an answer no branch handles, and this is what says so on the
   * first click instead of closing the card and leaving the import parked where it was.
   */
  it("refuses the untagged offer written as a verb nothing carries out", () => {
    expect(() => planResolution(on("ambiguous_release"), { action: "import_untagged" })).toThrow(
      /import_untagged/,
    );
    expect(() => planResolution(on("ambiguous_release"), { action: "untagged" })).toThrow(MMError);
  });
});

describe("planResolution — the verbs", () => {
  it("maps the ones that act on the job", () => {
    expect(planResolution(on("job_failed"), { action: "cancel" })).toEqual({ kind: "cancel" });
    expect(planResolution(on("job_failed"), { action: "retry", step: "match" })).toEqual({
      kind: "retry",
      step: "match",
      untaggedFallback: false,
    });
    expect(planResolution(on("awaiting_confirm"), { action: "confirm" })).toEqual({
      kind: "confirm",
    });
  });

  /**
   * The way out of "MusicBrainz does not know this playlist", read off the answer.
   *
   * It is the *same* verb the candidateless card's other two answers send — rewind to `match`
   * and run it again — with `options.untaggedFallback` riding on it, which is why it belongs to
   * the `retry` branch rather than to a verb of its own. The flag has to be read strictly:
   * anything that is not `true` leaves the pipeline's default alone, because the default is
   * "ask" and filing an album under a title nobody chose is worse than parking it.
   */
  it("carries the untagged fallback on a retry, and only when it is stated", () => {
    expect(
      planResolution(on("ambiguous_release"), {
        action: "retry",
        step: "match",
        untaggedFallback: true,
      }),
    ).toEqual({ kind: "retry", step: "match", untaggedFallback: true });

    for (const stated of [false, "true", 1, null, undefined]) {
      expect(
        planResolution(on("ambiguous_release"), {
          action: "retry",
          step: "match",
          untaggedFallback: stated,
        }),
        String(stated),
      ).toEqual({ kind: "retry", step: "match", untaggedFallback: false });
    }
  });

  it("maps the ones that act on the library", () => {
    expect(planResolution(on("orphan_files"), { action: "trash_orphans" })).toEqual({
      kind: "trash",
      what: "orphans",
    });
    expect(planResolution(on("duplicate_recording"), { action: "trash_duplicates" })).toEqual({
      kind: "trash",
      what: "duplicates",
    });
    expect(planResolution(on("ytdlp_update"), { action: "update_ytdlp" })).toEqual({
      kind: "update-ytdlp",
    });
    expect(planResolution(on("verify_mismatch"), { action: "reverify" })).toEqual({
      kind: "reverify",
    });
  });

  /** Offered by the fingerprint card since P06 and carried out by nobody until now. */
  it("maps the two answers to a fingerprint disagreement that are not “keep the mapping”", () => {
    expect(planResolution(on("fingerprint_mismatch"), { action: "use-acoustid" })).toEqual({
      kind: "use-acoustid",
    });
    expect(planResolution(on("fingerprint_mismatch"), { action: "skip-track" })).toEqual({
      kind: "skip-track",
    });
    expect(planResolution(on("fingerprint_mismatch"), { action: "keep-mapping" })).toEqual({
      kind: "none",
    });
  });

  it("closes, and only closes, on the answers whose whole effect is the item closing", () => {
    for (const action of ["snooze", "dismiss", "ignore", "accept", "import anyway", "keep_all"]) {
      expect(planResolution(on("uncovered_tracks"), { action })).toEqual({ kind: "none" });
    }
  });

  /**
   * `steps/confirm.ts` closes its own `awaiting_confirm` item with `{accepted, confirmedBy}` and
   * **no action**, deliberately: the gate is already open by then. That shape has to stay legal.
   */
  it("accepts the actionless acknowledgement `confirm` writes for itself", () => {
    expect(
      planResolution(on("awaiting_confirm"), { accepted: true, confirmedBy: "console" }),
    ).toEqual({ kind: "none" });
  });
});
