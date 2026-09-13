/**
 * Settings › Discover.
 *
 * The same read/save pair every tab uses: `settings.service` owns the zod schema of each key,
 * so the page cannot store a value the worker would refuse, and a rejected value comes back as
 * a message next to the field rather than as a row that breaks the nightly cron.
 *
 * The one extra thing this tab shows is where Navidrome stands. Discover without Navidrome has
 * no listening signals at all, and a page of empty blocks with no explanation is the worst
 * possible answer to "why is this empty?" — so the state of the *other* tab's setting is read
 * here and rendered as a sentence. Two booleans rather than one, because "no URL" and "a URL
 * and the switch off" are different problems with different fixes.
 *
 * `lastfmKey` is on this tab **and** on Metadata & matching. It is one key with two honest
 * homes: it enriches genres during an import (Metadata) and it is the similar-artist source
 * Discover falls back to. A group is a view over the registry, not an owner, so both handlers
 * accept it and `maskSetting` keeps it from crossing to the browser either way.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { DISCOVER_KEYS, inGroup } from "#/server/services/settings-groups.ts";
import { navidromeConfig } from "#/server/services/navidrome.ts";
import {
  SETTING_DEFINITIONS,
  SETTING_MASK,
  loadSettings,
  maskSetting,
  setSettings,
} from "#/server/services/settings.ts";

export interface DiscoverSettingsPayload {
  readonly fields: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly doc: string;
    /** A credential: the value above is `""` or `SETTING_MASK`, never the key itself. */
    readonly secret: boolean;
  }[];
  /**
   * A URL and a user exist (settings or `MM_NAVIDROME_*`). On its own this is **not** enough:
   * every consumer requires the toggle too, which is why the two facts travel separately now.
   * One boolean here was the bug — Integrations said "connected", Discover said "not
   * configured", and both were reading a different half of the same truth.
   */
  readonly navidromeConfigured: boolean;
  /** `navidromeEnabled` and configured: what Discover actually needs. */
  readonly navidromeEnabled: boolean;
  readonly listenbrainzEnabled: boolean;
  readonly lastfmEnabled: boolean;
}

export const fetchDiscoverSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<DiscoverSettingsPayload> => {
    try {
      const settings = await loadSettings(db());
      const values = settings as unknown as Record<string, unknown>;
      const navidrome = navidromeConfig(settings);
      return {
        fields: DISCOVER_KEYS.map((key) => ({
          key,
          // A secret never crosses to the browser in clear, on this tab like on every other.
          value: maskSetting(key, values[key] as never),
          doc: SETTING_DEFINITIONS[key].doc,
          secret: SETTING_DEFINITIONS[key].secret === true,
        })),
        navidromeConfigured: navidrome.url !== "" && navidrome.user !== "",
        navidromeEnabled: navidrome.enabled,
        listenbrainzEnabled: settings.sourcesEnabled.listenbrainz,
        lastfmEnabled: settings.sourcesEnabled.lastfm,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const saveDiscoverSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ values: z.record(z.string(), z.unknown()) }))
  .handler(async ({ data }): Promise<{ saved: readonly string[] }> => {
    try {
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data.values)) {
        if (!inGroup(DISCOVER_KEYS, key)) {
          throw new MMError("INVALID_INPUT", `"${key}" is not a Discover setting.`);
        }
        // The mask echoed back means "leave it alone". Loading the page and pressing Save
        // must not be able to erase a credential the page was never shown.
        if (SETTING_DEFINITIONS[key].secret === true && value === SETTING_MASK) continue;
        patch[key] = value;
      }
      // Atomic, like every other settings write. See `setSettings` (MCP-FIX-3 §1).
      const { saved } = await setSettings(patch, { db: db(), setBy: "user" });
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });
