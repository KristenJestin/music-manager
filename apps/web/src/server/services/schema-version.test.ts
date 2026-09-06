/**
 * The one override in the app, and the rules around it.
 *
 * It exists so that §8's claim — "bump the version and the library catches up in the
 * background" — can be exercised rather than asserted, which needs a process that believes in
 * N+1 while the library was written under N. These tests are what stop it from being a way to
 * accidentally re-tag a real installation: `0` is off, and off means the compiled constant.
 */
import { describe, expect, it } from "vitest";
import { TAG_SCHEMA_CHANGELOG, TAG_SCHEMA_VERSION } from "@mm/domain";
import {
  effectiveChangelog,
  effectiveSchemaVersion,
  isBehindSchema,
  isSchemaOverridden,
} from "./schema-version.ts";

const settings = (tagSchemaVersionOverride: number) => ({ tagSchemaVersionOverride });

describe("effectiveSchemaVersion", () => {
  it("is the compiled constant when nothing is overridden", () => {
    expect(effectiveSchemaVersion(settings(0))).toBe(TAG_SCHEMA_VERSION);
    expect(isSchemaOverridden(settings(0))).toBe(false);
  });

  it("is the override when one is set, and says so", () => {
    expect(effectiveSchemaVersion(settings(4))).toBe(4);
    expect(isSchemaOverridden(settings(4))).toBe(true);
  });
});

describe("isBehindSchema", () => {
  it("is true below the current version and false at or above it", () => {
    expect(isBehindSchema(1, 2)).toBe(true);
    expect(isBehindSchema(2, 2)).toBe(false);
    expect(isBehindSchema(3, 2)).toBe(false);
  });

  /*
   * A row with no version is a file we did not write, or one written before the column
   * existed. Both deserve a fresh projection, and both would be invisible if this returned
   * false.
   */
  it("treats an unknown version as behind", () => {
    expect(isBehindSchema(null, 1)).toBe(true);
    expect(isBehindSchema(undefined, 1)).toBe(true);
  });
});

describe("effectiveChangelog", () => {
  it("is the real changelog when nothing is overridden", () => {
    expect(effectiveChangelog(settings(0))).toBe(TAG_SCHEMA_CHANGELOG);
  });

  /*
   * The Console shows the changelog next to "N files behind". A list that stopped at v1 while
   * the badge said v4 would be the interface contradicting itself in one paragraph.
   */
  it("adds an honest entry on top when the version is overridden", () => {
    const entries = effectiveChangelog(settings(TAG_SCHEMA_VERSION + 3));
    expect(entries[0]?.version).toBe(TAG_SCHEMA_VERSION + 3);
    expect(entries[0]?.note).toMatch(/override/i);
    expect(entries).toHaveLength(TAG_SCHEMA_CHANGELOG.length + 1);
  });

  it("does not invent an entry for an override that is not ahead", () => {
    expect(effectiveChangelog(settings(TAG_SCHEMA_VERSION))).toBe(TAG_SCHEMA_CHANGELOG);
  });
});
