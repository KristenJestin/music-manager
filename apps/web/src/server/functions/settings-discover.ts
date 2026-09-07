/**
 * Settings › Discover.
 *
 * The same read/save pair every tab uses: `settings.service` owns the zod schema of each key,
 * so the page cannot store a value the worker would refuse, and a rejected value comes back as
 * a message next to the field rather than as a row that breaks the nightly cron.
 *
 * The one extra thing this tab shows is `navidromeConfigured`. Discover without Navidrome has
 * no listening signals at all, and a page of empty blocks with no explanation is the worst
 * possible answer to "why is this empty?" — so the state of the *other* tab's setting is read
 * here and rendered as a sentence.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { DISCOVER_KEYS, inGroup } from "#/server/services/settings-groups.ts";
import { navidromeConfig } from "#/server/services/navidrome.ts";
import { SETTING_DEFINITIONS, loadSettings, setSettings } from "#/server/services/settings.ts";

export interface DiscoverSettingsPayload {
  readonly fields: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly doc: string;
  }[];
  readonly navidromeConfigured: boolean;
  readonly listenbrainzEnabled: boolean;
  readonly lastfmEnabled: boolean;
}

export const fetchDiscoverSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<DiscoverSettingsPayload> => {
    try {
      const settings = await loadSettings(db());
      const values = settings as unknown as Record<string, unknown>;
      return {
        fields: DISCOVER_KEYS.map((key) => ({
          key,
          value: values[key],
          doc: SETTING_DEFINITIONS[key].doc,
        })),
        navidromeConfigured: navidromeConfig(settings).enabled,
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
      for (const key of Object.keys(data.values)) {
        if (!inGroup(DISCOVER_KEYS, key)) {
          throw new MMError("INVALID_INPUT", `"${key}" is not a Discover setting.`);
        }
      }
      // Atomic, like every other settings write. See `setSettings` (MCP-FIX-3 §1).
      const { saved } = await setSettings(data.values, { db: db(), setBy: "user" });
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });
