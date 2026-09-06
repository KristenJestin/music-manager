/**
 * Where a credential came from, and what the User-Agent says (owner review B7 and B8).
 *
 * The Console showed an empty Contact field over a `MM_MB_CONTACT` that every outgoing
 * MusicBrainz request was already carrying, and a Test button that said "the key was
 * accepted" about a key it never named. Both are the same bug: the settings row is an
 * *override*, and nothing reported which of the two layers actually won.
 */
import { describe, expect, it } from "vitest";
import { sourcesConfig, userAgentFor } from "./config.ts";
import { defaults, type Settings } from "#/server/services/settings.ts";

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaults(), ...patch });

describe("sourcesConfig", () => {
  it("takes the environment when the setting is empty, and says so", () => {
    const config = sourcesConfig(settings(), {
      MM_MB_CONTACT: "owner@example.com",
      MM_ACOUSTID_KEY: "env-key",
    });
    expect(config.contact).toBe("owner@example.com");
    expect(config.origin.contact).toBe("environment");
    expect(config.acoustidKey).toBe("env-key");
    expect(config.origin.acoustidKey).toBe("environment");
    expect(config.origin.lastfmKey).toBe("none");
  });

  it("lets the setting win, and says that too", () => {
    const config = sourcesConfig(settings({ mbContact: "console@example.com" }), {
      MM_MB_CONTACT: "env@example.com",
    });
    expect(config.contact).toBe("console@example.com");
    expect(config.origin.contact).toBe("settings");
  });

  it("treats whitespace as absence on both layers", () => {
    const config = sourcesConfig(settings({ mbContact: "   " }), { MM_MB_CONTACT: "  " });
    expect(config.contact).toBe("");
    expect(config.origin.contact).toBe("none");
  });

  it("really puts the effective contact into the User-Agent", () => {
    const config = sourcesConfig(settings(), { MM_MB_CONTACT: "owner@example.com" });
    expect(config.userAgent).toContain("owner@example.com");
    expect(config.userAgent).toBe(userAgentFor("owner@example.com"));
  });

  it("still names the project when there is no contact anywhere", () => {
    const config = sourcesConfig(settings(), {});
    expect(config.userAgent).toContain("MusicManager/");
    expect(config.userAgent).not.toContain("( )");
  });
});
