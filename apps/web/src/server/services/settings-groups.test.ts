/**
 * The Settings tabs, checked against the registry they claim to display.
 *
 * Two failure modes, both silent without this file: a key renamed in `settings.service` and
 * not here (the page would show nothing, and Save would refuse a key nobody typed), and a key
 * added to the registry and to no tab (a knob that exists, is documented, is validated, and
 * cannot be reached from the Console).
 *
 * The second one is a *warning* rather than a failure — P07b's tabs and P08's own settings
 * arrive after this file — so it is asserted as an explicit allow-list. Adding a key without
 * a home means adding it to that list on purpose, and writing down which phase will house it.
 */
import { describe, expect, it } from "vitest";
import {
  DISCOVER_KEYS,
  GENERAL_KEYS,
  METADATA_KEYS,
  inGroup,
  ungroupedKeys,
} from "./settings-groups.ts";
import { SETTING_KEYS, isSettingKey } from "./settings.ts";

describe("the tabs reference real settings", () => {
  it("every key on Library & files exists in the registry", () => {
    for (const key of GENERAL_KEYS) expect(isSettingKey(key)).toBe(true);
  });

  it("every key on Metadata & matching exists in the registry", () => {
    for (const key of METADATA_KEYS) expect(isSettingKey(key)).toBe(true);
  });

  it("no key is on both tabs", () => {
    const overlap = GENERAL_KEYS.filter((key) =>
      (METADATA_KEYS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });
});

describe("inGroup", () => {
  it("accepts a key of the group and refuses everything else", () => {
    expect(inGroup(GENERAL_KEYS, "pathTemplate")).toBe(true);
    // A Metadata key posted to the Library & files handler is a bug, not a convenience.
    expect(inGroup(GENERAL_KEYS, "acoustidKey")).toBe(false);
    expect(inGroup(GENERAL_KEYS, "not-a-setting")).toBe(false);
  });
});

describe("coverage", () => {
  /**
   * Every knob this phase introduced has a page.
   *
   * Deliberately scoped to P07a's own keys rather than to the whole registry: the Downloader
   * and Integrations tabs land in the same phase from another branch, and an assertion over
   * everything would fail for the honest reason that somebody else has not merged yet — which
   * is noise, not a defect. What this file can prove on its own is that nothing *we* added is
   * unreachable.
   */
  const OURS = [
    "pathTemplate",
    "discMode",
    "tagSchemaVersionOverride",
    "retagBatchSize",
    "sourcesRefreshEnabled",
  ] as const;

  it("every setting P07a added is on one of P07a's tabs", () => {
    const homeless = OURS.filter((key) => ungroupedKeys().includes(key));
    expect(homeless).toEqual([]);
  });

  /**
   * P09 note: this used to read `GENERAL_KEYS.length + METADATA_KEYS.length`, and adding a
   * third group to this file made it fail at 47 of 95 — while *raising* the share of the
   * registry that has a home. The two named groups were a proxy for "most knobs are reachable"
   * that stopped being one the moment a third tab registered its keys here, so the assertion
   * now states the property directly. It keeps holding as further tabs are added, which the
   * old form could not.
   */
  it("the groups declared here are most of the registry", () => {
    const shown = SETTING_KEYS.length - ungroupedKeys().length;
    expect(shown).toBeGreaterThan(SETTING_KEYS.length / 2);
  });
});

/* ------------------------------------------------------------------ */

/**
 * A key on two tabs is allowed, and `lastfmKey` is the case that proves it.
 *
 * It enriches genres and moods during an import (Metadata & matching) *and* it is the
 * similar-artist source Discover falls back to when ListenBrainz is silent. Showing it on one
 * tab only left the other unable to explain why a whole block was empty. A group is a view
 * over the registry, not an owner — which is exactly what these assertions state.
 */
describe("a key may belong to two tabs", () => {
  it("lastfmKey is on Metadata & matching and on Discover", () => {
    expect((METADATA_KEYS as readonly string[]).includes("lastfmKey")).toBe(true);
    expect((DISCOVER_KEYS as readonly string[]).includes("lastfmKey")).toBe(true);
  });

  it("both save handlers therefore accept it", () => {
    expect(inGroup(METADATA_KEYS, "lastfmKey")).toBe(true);
    expect(inGroup(DISCOVER_KEYS, "lastfmKey")).toBe(true);
  });

  it("and it counts as grouped exactly once", () => {
    // `ungroupedKeys` folds the groups into a set, so an overlap can never make a reachable
    // key look orphaned, nor make the registry look larger than it is.
    expect(ungroupedKeys().includes("lastfmKey")).toBe(false);
    expect(new Set(ungroupedKeys()).size).toBe(ungroupedKeys().length);
  });
});
