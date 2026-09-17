/**
 * The subject keys, and the two things that have to be true of every one of them.
 *
 *  1. **the same question is one key.** Re-encountered after a scan, after a relocate, listed
 *     in the other order — still the key that was answered, or the memory never matches and
 *     the queue fills up again, which is the bug this table exists for;
 *  2. **a different question is a different key.** A dismissal is not a permanent gag: another
 *     pair, another file, another album, and above all *the same subject whose facts moved*
 *     must come back. `verify_mismatch` is the sharp case — accepting what Navidrome reported
 *     is an answer about what it reported, not about the album for ever.
 *
 * And a third, which is the one that actually broke: the raiser and the resolver must derive
 * the *same* key, one from the finding and one from the item's payload. They are tested as a
 * round trip rather than side by side, because two spellings of one key is exactly the shape
 * of a memory that is written and never read.
 */
import { describe, expect, it } from "vitest";
import {
  albumIncompleteSubject,
  DISMISSIBLE_TYPES,
  dismissalSubjectsOf,
  duplicateSubject,
  mergeConflictSubject,
  orphanSubject,
  verifyMismatchSubject,
} from "./inbox-dismissals.ts";
import { silencesSubject } from "./inbox.resolution.ts";

describe("which answers stop the asking", () => {
  it("treats “dismiss” and every card's own affirmative as final", () => {
    for (const action of ["dismiss", "ignore", "keep_all", "accept_partial", "accept_navidrome"]) {
      expect(silencesSubject({ action }), action).toBe(true);
    }
  });

  it("treats “snooze” as not now, which is the whole distinction", () => {
    expect(silencesSubject({ action: "snooze" })).toBe(false);
  });

  it("silences nothing on an answer that is a choice rather than a verb", () => {
    expect(silencesSubject({ releaseMbid: "rel-1" })).toBe(false);
    expect(silencesSubject({ accepted: true })).toBe(false);
  });
});

describe("the dismissible families", () => {
  it("is the four a scan rebuilds, and no import-scoped one", () => {
    expect([...DISMISSIBLE_TYPES].sort()).toEqual([
      "album_incomplete",
      "duplicate_recording",
      "orphan_files",
      "verify_mismatch",
    ]);
  });

  it("yields no key at all for a question nothing raises twice", () => {
    expect(
      dismissalSubjectsOf({
        type: "ambiguous_release",
        title: "Which edition?",
        payload: { candidates: [] },
      }),
    ).toEqual([]);
  });
});

describe("duplicate_recording", () => {
  const ceremonials = "alb_ceremonials";
  const compilation = "alb_under_heaven";
  const shipToWreck = "rec-ship-to-wreck";

  it("is order-independent: the scan may list the pair either way round", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, compilation])).toBe(
      duplicateSubject(shipToWreck, [compilation, ceremonials]),
    );
  });

  it("survives a relocate, because no path is in it", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, compilation])).not.toContain("/");
  });

  it("is not the recording alone: another pair of the same recording is another question", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, compilation])).not.toBe(
      duplicateSubject(shipToWreck, [ceremonials, "alb_greatest_hits"]),
    );
  });

  it("is not the albums alone: another recording on the same two albums is another question", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, compilation])).not.toBe(
      duplicateSubject("rec-delilah", [ceremonials, compilation]),
    );
  });

  it("counts the copies, so a third one appearing asks again", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, compilation])).not.toBe(
      duplicateSubject(shipToWreck, [ceremonials, compilation, compilation]),
    );
  });

  it("re-derives the raiser's key from the item payload", () => {
    const keys = dismissalSubjectsOf({
      type: "duplicate_recording",
      title: "“Ship to Wreck” is in the library 2 times",
      payload: {
        recordingMbid: shipToWreck,
        title: "Ship to Wreck",
        files: [
          { trackId: "trk_1", path: "Florence/Ceremonials/03.opus", albumId: ceremonials },
          { trackId: "trk_2", path: "Various/Under Heaven/07.opus", albumId: compilation },
        ],
      },
    });
    expect(keys).toHaveLength(1);
    expect(keys[0]?.subject).toBe(duplicateSubject(shipToWreck, [ceremonials, compilation]));
  });

  it("falls back to a placeholder for a track filed under no album", () => {
    expect(duplicateSubject(shipToWreck, [ceremonials, null])).toBe(
      `duplicate:${shipToWreck}|-,${ceremonials}`,
    );
  });

  it("keys a merge conflict on the rows, which are the question there", () => {
    const keys = dismissalSubjectsOf({
      type: "duplicate_recording",
      title: "2 library rows share one position on this album",
      payload: {
        albumId: "alb_x",
        on: "position",
        key: "p:alb_x:1:3",
        rows: [{ trackId: "trk_b" }, { trackId: "trk_a" }],
        why: "different durations",
      },
    });
    expect(keys[0]?.subject).toBe(
      mergeConflictSubject("alb_x", "position", "p:alb_x:1:3", ["trk_a", "trk_b"]),
    );
  });
});

describe("orphan_files", () => {
  it("is one key per path, because the card aggregates and the answer does not", () => {
    const keys = dismissalSubjectsOf({
      type: "orphan_files",
      title: "3 file(s) in the library are not in the database",
      payload: {
        orphans: [{ path: "Loose/a.opus" }, { path: "Loose/b.opus" }, { path: "Loose/c.opus" }],
        total: 3,
      },
    });
    expect(keys.map((key) => key.subject)).toEqual([
      orphanSubject("Loose/a.opus"),
      orphanSubject("Loose/b.opus"),
      orphanSubject("Loose/c.opus"),
    ]);
  });

  it("labels each one with its path, so the Console lists something a person recognises", () => {
    const keys = dismissalSubjectsOf({
      type: "orphan_files",
      title: "1 file(s) in the library are not in the database",
      payload: { orphans: [{ path: "Loose/a.opus" }], total: 1 },
    });
    expect(keys[0]?.label).toBe("Loose/a.opus");
  });

  it("distinguishes two files that differ only by directory", () => {
    expect(orphanSubject("A/x.opus")).not.toBe(orphanSubject("B/x.opus"));
  });
});

describe("verify_mismatch", () => {
  const album = "alb_ceremonials";
  const wrote = [{ name: "albumartist", written: "Florence + The Machine", read: "Florence" }];

  it("is one key however the fields came back ordered", () => {
    const two = [
      { name: "date", written: "2011", read: "2011-10-28" },
      { name: "albumartist", written: "Florence + The Machine", read: "Florence" },
    ];
    expect(verifyMismatchSubject(album, two)).toBe(
      verifyMismatchSubject(album, [...two].reverse()),
    );
  });

  it("comes back when the values change, because the values are in the key", () => {
    const later = [{ name: "albumartist", written: "Florence + The Machine", read: "" }];
    expect(verifyMismatchSubject(album, wrote)).not.toBe(verifyMismatchSubject(album, later));
  });

  it("comes back when a second field starts disagreeing too", () => {
    expect(verifyMismatchSubject(album, wrote)).not.toBe(
      verifyMismatchSubject(album, [...wrote, { name: "date", written: "2011", read: "" }]),
    );
  });

  it("stays silent for the same album with the same values read back again", () => {
    expect(verifyMismatchSubject(album, wrote)).toBe(
      verifyMismatchSubject(album, [{ ...wrote[0]! }]),
    );
  });

  it("re-derives the raiser's key from the item payload", () => {
    const keys = dismissalSubjectsOf({
      type: "verify_mismatch",
      title: "Florence — Ceremonials: 1 required field(s) read back wrong",
      payload: {
        libraryAlbumId: album,
        navidromeAlbumId: "nd-1",
        fields: [
          {
            name: "albumartist",
            written: "Florence + The Machine",
            read: "Florence",
            required: true,
            status: "mismatch",
          },
        ],
      },
    });
    expect(keys[0]?.subject).toBe(verifyMismatchSubject(album, wrote));
  });

  it("is a different album's question even with identical values", () => {
    expect(verifyMismatchSubject("alb_a", wrote)).not.toBe(verifyMismatchSubject("alb_b", wrote));
  });
});

describe("album_incomplete", () => {
  it("carries the denominator, so a re-match that changes the total asks again", () => {
    expect(albumIncompleteSubject("alb_x", 13)).not.toBe(albumIncompleteSubject("alb_x", 15));
  });

  it("re-derives the raiser's key from the item payload", () => {
    const keys = dismissalSubjectsOf({
      type: "album_incomplete",
      title: "Florence — Ceremonials is missing 2 track(s)",
      payload: { albumId: "alb_x", present: 11, total: 13, missing: 2 },
    });
    expect(keys[0]?.subject).toBe(albumIncompleteSubject("alb_x", 13));
  });
});

describe("a payload written before this existed", () => {
  it("yields no key rather than throwing in the middle of a resolution", () => {
    expect(dismissalSubjectsOf({ type: "duplicate_recording", title: "old", payload: {} })).toEqual(
      [],
    );
    expect(dismissalSubjectsOf({ type: "verify_mismatch", title: "old", payload: {} })).toEqual([]);
    expect(dismissalSubjectsOf({ type: "album_incomplete", title: "old", payload: {} })).toEqual(
      [],
    );
  });

  it("still keys a duplicate group that predates `albumId` on its files", () => {
    const keys = dismissalSubjectsOf({
      type: "duplicate_recording",
      title: "old",
      payload: {
        recordingMbid: "rec-1",
        files: [{ trackId: "trk_1" }, { trackId: "trk_2" }],
      },
    });
    expect(keys[0]?.subject).toBe(duplicateSubject("rec-1", [null, null]));
  });
});
