/**
 * What preference learning is allowed to do, and — mostly — what it is not.
 *
 * `docs/04-pipeline-et-matching.md` permits exactly one thing here: past decisions may feed
 * the country/format/explicit preferences, "mais pas de façon opaque". Every test below is a
 * restriction rather than a capability, because the failure mode of this feature is not
 * "it did not learn", it is "it learned something nobody asked for and nobody can see".
 */
import { describe, expect, it } from "vitest";
import {
  decidePreferences,
  MIN_DECISIONS,
  type Observation,
} from "#/server/services/matching.preferences.ts";
import { defaults } from "#/server/services/settings.ts";

const shipped = defaults();
const current = {
  preferredCountries: shipped.preferredCountries,
  preferredFormat: shipped.preferredFormat,
};

const many = (count: number, observation: Observation): Observation[] =>
  Array.from({ length: count }, () => observation);

describe("preference learning", () => {
  it("learns nothing from too few decisions", () => {
    const observations = many(MIN_DECISIONS - 1, { country: "GB", format: "CD" });
    expect(decidePreferences(observations, current)).toBeNull();
  });

  it("moves a declared country to the front when most decisions agree", () => {
    const observations = [
      ...many(5, { country: "GB", format: "Digital Media" }),
      ...many(2, { country: "FR", format: "Digital Media" }),
    ];
    const learned = decidePreferences(observations, current);
    expect(learned?.countries[0]).toBe("GB");
    expect(learned?.from).toBe(7);
    expect(learned?.changes.join(" ")).toMatch(/Country GB moved to first preference/);
  });

  it("keeps every other country, in order, behind the one it promoted", () => {
    const learned = decidePreferences(many(6, { country: "US", format: "CD" }), current);
    expect(learned?.countries).toEqual(["US", "XW", "FR", "GB"]);
  });

  it("refuses to adopt a country you never declared", () => {
    // Six Japanese pressings in a row is a fact about six imports, not a policy.
    const learned = decidePreferences(many(6, { country: "JP", format: "CD" }), current);
    expect(learned?.countries).toEqual(shipped.preferredCountries);
    expect(learned?.changes.filter((change) => change.startsWith("Country"))).toHaveLength(0);
  });

  it("does nothing when no country has a clear majority", () => {
    const observations = [
      ...many(3, { country: "GB", format: "Digital Media" }),
      ...many(3, { country: "US", format: "Digital Media" }),
    ];
    const learned = decidePreferences(observations, current);
    expect(learned?.countries).toEqual(shipped.preferredCountries);
    expect(learned?.changes).toHaveLength(0);
  });

  it("changes the preferred format when the evidence is one-sided", () => {
    const learned = decidePreferences(many(8, { country: "XW", format: "CD" }), current);
    expect(learned?.format).toBe("CD");
    expect(learned?.changes.join(" ")).toMatch(/Preferred format is now CD/);
  });

  it("reports every change it would make, so nothing moves unannounced", () => {
    const learned = decidePreferences(many(6, { country: "FR", format: "CD" }), current);
    expect(learned?.changes).toHaveLength(2);
    for (const change of learned?.changes ?? []) expect(change).toMatch(/confirmed releases/);
  });

  it("says how many decisions it looked at, even when it changes nothing", () => {
    const learned = decidePreferences(many(6, { country: "XW", format: "Digital Media" }), current);
    expect(learned?.from).toBe(6);
    expect(learned?.changes).toHaveLength(0);
  });

  it("ignores decisions whose release has no country or format", () => {
    const learned = decidePreferences(many(6, { country: null, format: null }), current);
    expect(learned?.countries).toEqual(shipped.preferredCountries);
    expect(learned?.format).toBe(shipped.preferredFormat);
    expect(learned?.changes).toHaveLength(0);
  });
});
