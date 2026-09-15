/**
 * The position rule on its own, with no database in the way.
 *
 * `allocatePosition` is the half of the allocator that can be reasoned about as arithmetic:
 * given what an album already holds and what a track claims, which slot does it get. The other
 * half — *what the album already holds* — is a query, and `positions.integration.test.ts` is
 * where that is proven against a real Postgres.
 *
 * The album used throughout is **1, 2, 4, 25, 26**: a hole at 3 and a tail well past the
 * track count. It is the shape that tells three wrong implementations apart in one assertion.
 * Five tracks, so a `count + 1` allocator says 6; a `max + 1` that never re-checks says 27 and
 * is right by luck; and the only answer that survives both the hole and the tail is the one
 * computed from the positions themselves.
 */
import { describe, expect, it } from "vitest";
import { allocatePosition, discBucket } from "./positions.ts";

/** The album with a hole and a tail. */
const HOLE_AND_TAIL = new Set([1, 2, 4, 25, 26]);

describe("allocatePosition", () => {
  it("gives a free candidate the slot it asks for, hole or not", () => {
    // 3 is the hole. A track that says it is track 3 belongs at 3.
    expect(allocatePosition(HOLE_AND_TAIL, 3)).toBe(3);
    expect(allocatePosition(HOLE_AND_TAIL, 7)).toBe(7);
  });

  it("puts a taken candidate past the end of the album, not into the hole", () => {
    // 26 is the tail. The answer is 27 — not 6, which is what `count + 1` would say, and not
    // 3, which is the first free slot but somebody else's number.
    expect(allocatePosition(HOLE_AND_TAIL, 26)).toBe(27);
    expect(allocatePosition(HOLE_AND_TAIL, 1)).toBe(27);
    expect(allocatePosition(HOLE_AND_TAIL, 25)).toBe(27);
  });

  it("puts a track with nothing to claim past the end too", () => {
    expect(allocatePosition(HOLE_AND_TAIL, null)).toBe(27);
  });

  it("keeps climbing while the album has a run of taken slots above the candidate", () => {
    expect(allocatePosition(new Set([1, 2, 3, 4, 5]), 2)).toBe(6);
    expect(allocatePosition(new Set([1, 2, 3, 4, 5]), 9)).toBe(9);
  });

  it("starts at 1 on an empty album", () => {
    expect(allocatePosition(new Set(), null)).toBe(1);
    expect(allocatePosition(new Set(), 4)).toBe(4);
  });

  it("never returns a candidate at or below `after`, which is what a retry knows", () => {
    // The insert was refused at 26, so 26 is held whatever the read said a moment ago.
    expect(allocatePosition(HOLE_AND_TAIL, 26, 26)).toBe(27);
    // And a second refusal at 27 climbs again, rather than offering 27 back.
    expect(allocatePosition(new Set([...HOLE_AND_TAIL, 27]), 26, 27)).toBe(28);
  });

  it("does not let a high candidate leave a gap it then falls into", () => {
    // A candidate of 40 on an album that ends at 26: 40 is free, so 40 it is.
    expect(allocatePosition(HOLE_AND_TAIL, 40)).toBe(40);
    // And if 40 were taken, past the end means past *40*, not past 26.
    expect(allocatePosition(new Set([...HOLE_AND_TAIL, 40]), 40)).toBe(41);
  });
});

describe("discBucket", () => {
  /**
   * `coalesce(disc_number, 1)` is what the unique index groups by, so a null disc and disc 1
   * are the same disc. Treating them as two is how the single-disc album — the one case that
   * has no disc number at all — ends up exempt from the constraint it breaks most often.
   */
  it("is what the index means: no disc number is disc 1", () => {
    expect(discBucket(null)).toBe(1);
    expect(discBucket(undefined)).toBe(1);
    expect(discBucket(1)).toBe(1);
    expect(discBucket(2)).toBe(2);
  });
});
