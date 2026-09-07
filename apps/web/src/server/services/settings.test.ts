import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  coerce,
  defaults,
  isSettingKey,
  parseCliValue,
  parseValue,
  maskSetting,
  maskedSettings,
  SETTING_MASK,
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

/**
 * One write path for a patch (MCP-FIX-3 §1).
 *
 * `setSettings` is what makes a patch atomic. A surface that loops over `setSetting` instead
 * is atomic for one key and *not* for two, which is precisely the bug the third test report
 * caught in `update_settings` — so the rule is enforced here rather than remembered: no
 * multi-key write path may call `setSetting`.
 */
describe("every multi-key surface writes through setSettings", () => {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const SURFACES = [
    "../api/routes/settings.ts",
    "../mcp/server.ts",
    "../functions/settings-general.ts",
    "../functions/settings-metadata.ts",
    "../functions/settings-discover.ts",
    "../functions/settings-downloader.ts",
  ];

  for (const relative of SURFACES) {
    it(`${relative} does not write key by key`, () => {
      const source = readFileSync(resolve(HERE, relative), "utf8");
      // `setSettings(` must not match, hence the negative lookahead on the second `s`.
      expect(source, relative).not.toMatch(/\bsetSetting(?!s)\s*\(/);
      expect(source, relative).toMatch(/\bsetSettings\s*\(/);
    });
  }

  it("leaves the backup restore alone, which is deliberately per key", () => {
    const source = readFileSync(resolve(HERE, "../functions/settings-integrations.ts"), "utf8");
    expect(source).toMatch(/\bsetSettings\s*\(/);
    // It also calls `setSetting`, and says in a comment why a restore may not be all-or-nothing.
    expect(source).toMatch(/deliberately \*\*not\*\* atomic/);
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

/* ------------------------------------------------------------------ */
/* what a reader is allowed to see (MCP test report §15, §17)          */
/* ------------------------------------------------------------------ */

describe("masking a credential", () => {
  it("says only whether one is set", () => {
    // It used to answer `set (5 chars, …in)`: the exact length and the last two characters,
    // which on a five-character password is forty per cent of the secret.
    expect(maskSetting("navidromePassword", "admin")).toBe("set");
    expect(maskSetting("navidromePassword", "")).toBe("");
  });

  it("leaks neither the length nor any character of the value", () => {
    const secret = "correct-horse-battery-staple";
    const masked = String(maskSetting("navidromePassword", secret));
    expect(masked).not.toContain(String(secret.length));
    expect(masked).not.toContain(secret.slice(-2));
    expect(masked).toBe(SETTING_MASK);
  });

  it("masks every key declared secret, and nothing else", () => {
    const masked = maskedSettings({ ...defaults(), navidromePassword: "hunter2" } as never);
    for (const key of SETTING_KEYS) {
      if (SETTING_DEFINITIONS[key].secret !== true) continue;
      const value = masked[key];
      expect(value === "" || value === SETTING_MASK, key).toBe(true);
    }
    expect(masked["sanitizeMode"]).toBe("windows");
  });
});

describe("an invalid path template", () => {
  it("names the token it does not know, instead of saying every token must exist", () => {
    const failure = SETTING_DEFINITIONS.pathTemplate.schema.safeParse(
      "{albumartist}/{album}/{title}.{ext}",
    );
    expect(failure.success).toBe(false);
    const message = failure.error?.issues[0]?.message ?? "";
    expect(message).toContain("{albumartist}");
  });

  it("lists the tokens that would have been accepted", () => {
    const failure = SETTING_DEFINITIONS.pathTemplate.schema.safeParse("{nope}/{title}.{ext}");
    const message = failure.error?.issues[0]?.message ?? "";
    expect(message).toContain("{nope}");
    expect(message).toContain("{albumArtist}");
    expect(message).toContain("{track:02}");
  });

  it("still says which required token is missing", () => {
    const failure = SETTING_DEFINITIONS.pathTemplate.schema.safeParse("{album}/{track}.{ext}");
    expect(failure.error?.issues[0]?.message ?? "").toContain("{title}");
  });

  it("accepts the default and a padded track token of any width", () => {
    expect(SETTING_DEFINITIONS.pathTemplate.schema.safeParse(defaults().pathTemplate).success).toBe(
      true,
    );
    expect(
      SETTING_DEFINITIONS.pathTemplate.schema.safeParse("{album}/{track:03} {title}.{ext}").success,
    ).toBe(true);
  });
});
