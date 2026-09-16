/**
 * Settings › Watched sources.
 *
 * The same read/save pair every tab uses. The one thing worth reading twice is the threshold:
 * it defaults to `safeThreshold`, so the page shows what the matcher already calls "safe"
 * rather than a second number nobody set.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { WATCHED_SOURCES_KEYS, inGroup } from "#/server/services/settings-groups.ts";
import { SETTING_DEFINITIONS, loadSettings, setSettings } from "#/server/services/settings.ts";

export interface WatchedSourcesSettingsPayload {
  readonly fields: readonly {
    readonly key: string;
    readonly value: unknown;
    readonly doc: string;
  }[];
  /** What the matcher itself calls safe, so the page can say "same as the matcher". */
  readonly safeThreshold: number;
  /** How many sources exist, so the tab can point at the page that has them. */
  readonly sourceCount: number;
}

export const fetchWatchedSourcesSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<WatchedSourcesSettingsPayload> => {
    try {
      const settings = await loadSettings(db());
      const values = settings as unknown as Record<string, unknown>;
      const { countWatchedSources } = await import("#/server/services/watched-sources.ts");
      return {
        fields: WATCHED_SOURCES_KEYS.map((key) => ({
          key,
          value: values[key],
          doc: SETTING_DEFINITIONS[key].doc,
        })),
        safeThreshold: settings.safeThreshold,
        sourceCount: await countWatchedSources(db()),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const saveWatchedSourcesSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ values: z.record(z.string(), z.unknown()) }))
  .handler(async ({ data }): Promise<{ saved: readonly string[] }> => {
    try {
      for (const key of Object.keys(data.values)) {
        if (!inGroup(WATCHED_SOURCES_KEYS, key)) {
          throw new MMError("INVALID_INPUT", `"${key}" is not a Watched sources setting.`);
        }
      }
      const { saved } = await setSettings(data.values, { db: db(), setBy: "user" });
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });
