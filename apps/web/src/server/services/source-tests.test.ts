/**
 * What the "Test" buttons *say* (owner review B8).
 *
 * The owner pressed Test next to an empty AcoustID field and read "The key was accepted".
 * Both halves were misleading: the key had come from `MM_ACOUSTID_KEY`, and the probe would
 * have said the same thing about a key AcoustID had refused. The cases below need no network,
 * because they are exactly the ones that never reach one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "#/server/db/client.ts";
import { SOURCE_ENV_KEYS } from "#/server/integrations/config.ts";
import { testSource } from "./source-tests.ts";
import { defaults, type Settings } from "./settings.ts";

const db = {} as Database;

const settings = (patch: Partial<Settings> = {}): Settings => ({ ...defaults(), ...patch });

/**
 * `sourcesConfig()` layers the settings over `process.env`, and Bun loads `v2/.env` for
 * whatever it runs — so a machine that owns a real `MM_ACOUSTID_KEY` used to turn the first
 * case below ("there is no key anywhere") into "there is a key, from the environment", and
 * the suite failed on the owner's checkout while passing in a worktree that has no `.env`.
 * The environment a test asserts on is part of its fixture: it is stated here, not inherited.
 */
describe("the AcoustID test", () => {
  beforeEach(() => {
    for (const key of SOURCE_ENV_KEYS) vi.stubEnv(key, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails, and names both places a key could go, when there is none", async () => {
    const result = await testSource("acoustid", { db, settings: settings() });
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.credential).toBe("none");
    expect(result.message).toContain("MM_ACOUSTID_KEY");
    expect(result.message).toContain("settings");
    // The sentence the owner objected to must not be reachable without a key.
    expect(result.message).not.toContain("accepted");
  });

  it("reports the origin of the key it would have used, without asking anybody", async () => {
    // Switched off, so no request leaves the machine — but the credential is still resolved,
    // which is the half of the answer the page was missing.
    const result = await testSource("acoustid", {
      db,
      settings: settings({
        acoustidKey: "abc",
        sourcesEnabled: { ...defaults().sourcesEnabled, acoustid: false },
      }),
    });
    expect(result.credential).toBe("settings");
    expect(result.configured).toBe(true);
  });

  it("says so plainly when the source is switched off", async () => {
    const result = await testSource("acoustid", {
      db,
      settings: settings({
        acoustidKey: "abc",
        sourcesEnabled: { ...defaults().sourcesEnabled, acoustid: false },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Disabled");
    // No em dash: the owner asked for human punctuation everywhere (review A4/B9).
    expect(result.message).not.toContain("—");
  });
});
