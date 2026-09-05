import { describe, expect, it, vi } from "vitest";
import {
  coerce,
  defaults,
  isSettingKey,
  parseCliValue,
  parseValue,
  SETTING_DEFINITIONS,
  SETTING_KEYS,
} from "./settings.ts";

/**
 * The registry, without a database. What matters here is that a bad stored value can never
 * reach the worker: it is either rejected on the way in, or replaced by its default on the
 * way out.
 */

describe("the registry", () => {
  it("gives every key a schema, a default and a sentence of documentation", () => {
    for (const key of SETTING_KEYS) {
      const definition = SETTING_DEFINITIONS[key];
      expect(definition.schema, key).toBeDefined();
      expect(definition.doc.length, key).toBeGreaterThan(10);
      // A default that does not satisfy its own schema is a bug waiting for a first user.
      expect(definition.schema.safeParse(definition.default).success, key).toBe(true);
    }
  });

  it("carries the values docs/04 asks for", () => {
    const values = defaults();
    expect(values.downloadJitterMinMs).toBe(5_000);
    expect(values.downloadJitterMaxMs).toBe(15_000);
    expect(values.safeThreshold).toBe(0.95);
    expect(values.verifyFingerprint).toBe(true);
    expect(values.sanitizeMode).toBe("windows");
  });

  it("recognises its own keys and nothing else", () => {
    expect(isSettingKey("sanitizeMode")).toBe(true);
    expect(isSettingKey("nonsense")).toBe(false);
    expect(isSettingKey("toString")).toBe(false);
  });
});

describe("parseValue", () => {
  it("accepts a valid value", () => {
    expect(parseValue("downloadJitterMinMs", 1000)).toBe(1000);
    expect(parseValue("sanitizeMode", "strict")).toBe("strict");
  });

  it("refuses an invalid one, with the reason in the message", () => {
    expect(() => parseValue("sanitizeMode", "sideways")).toThrow(/sanitizeMode/);
    expect(() => parseValue("safeThreshold", 2)).toThrow(/safeThreshold/);
    expect(() => parseValue("downloadJitterMinMs", "soon")).toThrow(/downloadJitterMinMs/);
  });
});

describe("coerce", () => {
  it("passes a good stored value through", () => {
    expect(coerce("artworkSize", 500)).toBe(500);
  });

  it("falls back to the default rather than letting a bad row crash a step", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(coerce("artworkSize", "enormous")).toBe(SETTING_DEFINITIONS.artworkSize.default);
    expect(coerce("preferredCountries", { not: "an array" })).toEqual(
      SETTING_DEFINITIONS.preferredCountries.default,
    );
    // It is silent about nothing: a value being ignored is worth a line in the log.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("parseCliValue", () => {
  it("reads JSON when the shell gives it JSON", () => {
    expect(parseCliValue("downloadJitterMinMs", "2500")).toBe(2500);
    expect(parseCliValue("verifyFingerprint", "false")).toBe(false);
    expect(parseCliValue("preferredCountries", '["FR","GB"]')).toEqual(["FR", "GB"]);
  });

  it("reads a bare word as a string, which is what someone typing means", () => {
    expect(parseCliValue("sanitizeMode", "strict")).toBe("strict");
    expect(parseCliValue("preferredFormat", "Digital Media")).toBe("Digital Media");
  });

  it("still refuses a value the schema rejects", () => {
    expect(() => parseCliValue("sanitizeMode", "sideways")).toThrow(/sanitizeMode/);
  });
});
