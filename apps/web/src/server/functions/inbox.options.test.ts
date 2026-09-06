import { describe, expect, it } from "vitest";
import type { InboxItem } from "#/server/db/schema/index.ts";
import { optionsFor } from "./inbox.ts";

/**
 * The answers a decision card offers.
 *
 * Two invariants hold for every item type, and both are decision 002 made testable:
 *
 *  - exactly **one** option is preselected, because Enter has to mean something;
 *  - the preselected option is the one that **lets the job carry on**, because an Inbox whose
 *    default answer cancels your import is a worse place to press Enter quickly.
 */
function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "ibx_1",
    type: "uncovered_tracks",
    status: "open",
    importId: "imp_1",
    trackId: null,
    title: "title",
    summary: null,
    payload: {},
    preselected: null,
    resolution: null,
    resolvedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as InboxItem;
}

const TYPES = [
  "uncovered_tracks",
  "extra_videos",
  "ambiguous_release",
  "ambiguous_recording",
  "fingerprint_mismatch",
  "job_failed",
  "album_incomplete",
] as const;

describe("optionsFor", () => {
  it("offers exactly one preselected answer, whatever the type", () => {
    for (const type of TYPES) {
      const options = optionsFor(item({ type }));
      expect(options.length, type).toBeGreaterThan(0);
      expect(
        options.filter((option) => option.preselected),
        type,
      ).toHaveLength(1);
    }
  });

  /*
   * The one exception is real rather than an oversight: an `ambiguous_release` whose search
   * came back empty has no answer that keeps the job going, so cancelling is not a bad default
   * — it is the only truthful one. Everything with a usable answer must preselect it.
   */
  it("never preselects an answer that would cancel the job", () => {
    const candidates = [{ id: "rel-a", title: "Discovery", score: 0.9 }];
    for (const type of TYPES) {
      const chosen = optionsFor(item({ type, payload: { candidates } })).find(
        (option) => option.preselected,
      );
      expect(chosen?.value["action"], type).not.toBe("cancel");
    }
  });

  /*
   * `uncovered_tracks` arrives in two shapes, because two code paths raise it: the matcher's
   * own proposal carries whole tracks, and a *supplied* mapping — what the wizard sends —
   * knows only the positions it did not cover. Reading one shape and not the other is how the
   * card ends up saying "0 missing track(s)" above a list of two.
   */
  it("counts uncovered tracks from the matcher's payload", () => {
    const options = optionsFor(
      item({
        type: "uncovered_tracks",
        payload: {
          tracks: [
            { position: 6, title: "Gossip" },
            { position: 9, title: "Disciples" },
          ],
        },
      }),
    );
    expect(options[0]?.detail).toContain("2 missing track(s)");
  });

  it("counts uncovered tracks from a supplied mapping's payload", () => {
    const options = optionsFor(item({ type: "uncovered_tracks", payload: { positions: [6, 9] } }));
    expect(options[0]?.detail).toContain("2 missing track(s)");
  });

  it("turns release candidates into one option each, preselecting the pinned one", () => {
    const options = optionsFor(
      item({
        type: "ambiguous_release",
        payload: {
          candidates: [
            { id: "rel-a", title: "Discovery", date: "2001-02-26", country: "FR", score: 0.97 },
            { id: "rel-b", title: "Discovery", date: "2001-03-12", country: "GB", score: 0.96 },
          ],
        },
        preselected: { releaseMbid: "rel-b" },
      }),
    );
    expect(options.map((option) => option.id)).toEqual(["rel-a", "rel-b"]);
    expect(options.find((option) => option.preselected)?.id).toBe("rel-b");
    expect(options[0]?.detail).toContain("FR");
    expect(options[0]?.score).toBe(0.97);
    expect(options[1]?.value).toEqual({ releaseMbid: "rel-b" });
  });

  it("falls back to cancelling when an ambiguous release has no candidates at all", () => {
    const options = optionsFor(item({ type: "ambiguous_release", payload: {} }));
    expect(options).toHaveLength(1);
    expect(options[0]?.value["action"]).toBe("cancel");
  });

  it("believes the confirmed mapping over the fingerprint, by default", () => {
    const options = optionsFor(item({ type: "fingerprint_mismatch" }));
    expect(options.find((option) => option.preselected)?.id).toBe("keep");
    expect(options.map((option) => option.id)).toContain("acoustid");
  });

  it("marks “Later” as a dismissal rather than an answer", () => {
    const later = optionsFor(item({ type: "extra_videos" })).find(
      (option) => option.id === "later",
    );
    expect(later?.dismiss).toBe(true);
    expect(later?.preselected).toBe(false);
  });

  it("carries the item's own preselection through for a type it has no special card for", () => {
    const options = optionsFor(
      item({ type: "ytdlp_update", preselected: { action: "update", version: "2026.09.02" } }),
    );
    expect(options[0]?.value).toEqual({ action: "update", version: "2026.09.02", accepted: true });
  });
});
