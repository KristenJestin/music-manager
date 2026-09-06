/**
 * Settings › Metadata & matching.
 *
 * The biggest tab in the app, because it is where every number that decides what a tag says
 * lives: the MusicBrainz contact, the matching weights P05 learned, the AcoustID key, the
 * enrichment order, the tag map, the tag schema and the eight sources.
 *
 * Two rules it keeps that are easy to get wrong:
 *
 *  - **A credential is never sent to the browser.** `maskSetting` turns it into its length and
 *    last two characters, which is enough to tell "the wrong key" from "no key" and nothing
 *    more. A save that echoes the mask back is read as "leave it alone" rather than as a new
 *    value, so opening the page and pressing Save does not wipe your keys.
 *  - **The tag map is read from `@mm/domain`, never restated.** The table this page renders is
 *    `TAGS`, and the columns are `keyFor(tag, format)`. There is one source of tag names in
 *    this system and it is not a page.
 */
import { z } from "zod";
import { PROFILE_IDS, PROFILES, TAG_FORMATS, unreadCount } from "@mm/domain";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { METADATA_KEYS, inGroup } from "#/server/services/settings-groups.ts";
import { tagMapRows, type TagMapRow } from "#/server/services/quality.ts";
import {
  effectiveChangelog,
  effectiveSchemaVersion,
  isSchemaOverridden,
} from "#/server/services/schema-version.ts";
import { filesBehindCount } from "#/server/services/quality.ts";
import { testAllSources, testSource, type SourceTestResult } from "#/server/services/source-tests.ts";
import {
  SETTING_DEFINITIONS,
  SOURCE_NAMES,
  loadSettings,
  maskSetting,
  setSetting,
} from "#/server/services/settings.ts";

export interface MetadataSettingsPayload {
  readonly fields: readonly { key: string; value: unknown; doc: string; secret: boolean }[];
  readonly tagMap: readonly TagMapRow[];
  readonly formats: readonly string[];
  readonly profiles: readonly {
    id: string;
    name: string;
    status: string;
    via: string;
    note: string;
    reads: number;
    unread: number;
    sidecars: readonly string[];
    lyrics: readonly string[];
  }[];
  readonly changelog: readonly {
    version: number;
    at: string;
    added: readonly string[];
    changed: readonly string[];
    removed: readonly string[];
    note: string;
  }[];
  readonly schema: {
    readonly current: number;
    readonly overridden: boolean;
    readonly filesBehind: number;
    readonly filesCurrent: number;
  };
  readonly sources: readonly string[];
  /** The sidecars of §3, and which consumers pick each of them up. */
  readonly sidecars: readonly { file: string; readers: readonly string[]; note: string }[];
}

/** §3's sidecars, with the profiles that read them — derived, never hand-listed. */
function sidecarTable(): MetadataSettingsPayload["sidecars"] {
  const files = [...new Set(PROFILES.flatMap((profile) => profile.sidecars))].sort();
  const notes: Record<string, string> = {
    "cover.jpg": "Album art next to the audio, so a server shows it without unpacking a file.",
    "artist.jpg": "Artist image, in the artist folder.",
    "NN Title.lrc": "Synchronised lyrics, the carrier every player agrees on.",
    "album.nfo": "Kodi and Jellyfin read this; nothing else does.",
    "artist.nfo": "Kodi and Jellyfin read this; nothing else does.",
  };
  return files.map((file) => ({
    file,
    readers: PROFILES.filter((profile) => profile.sidecars.includes(file)).map(
      (profile) => profile.name,
    ),
    note: notes[file] ?? "",
  }));
}

export const fetchMetadataSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<MetadataSettingsPayload> => {
    try {
      const settings = await loadSettings(db());
      const record = settings as unknown as Record<string, unknown>;
      const behind = await filesBehindCount({ db: db(), settings });

      return {
        fields: METADATA_KEYS.map((key) => ({
          key,
          value: maskSetting(key, record[key] as never),
          doc: SETTING_DEFINITIONS[key].doc,
          secret: SETTING_DEFINITIONS[key].secret === true,
        })),
        tagMap: tagMapRows(),
        formats: [...TAG_FORMATS],
        profiles: PROFILES.map((profile) => ({
          id: profile.id,
          name: profile.name,
          status: profile.status,
          via: profile.via,
          note: profile.note,
          reads: profile.reads.length,
          unread: unreadCount(profile),
          sidecars: profile.sidecars,
          lyrics: profile.lyrics,
        })),
        changelog: effectiveChangelog(settings).map((entry) => ({ ...entry })),
        schema: {
          current: effectiveSchemaVersion(settings),
          overridden: isSchemaOverridden(settings),
          filesBehind: behind.behind,
          filesCurrent: behind.total - behind.behind,
        },
        sources: [...SOURCE_NAMES],
        sidecars: sidecarTable(),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const saveMetadataSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ values: z.record(z.string(), z.unknown()) }))
  .handler(async ({ data }): Promise<{ saved: readonly string[] }> => {
    try {
      const saved: string[] = [];
      for (const [key, value] of Object.entries(data.values)) {
        if (!inGroup(METADATA_KEYS, key)) {
          throw new MMError("INVALID_INPUT", `"${key}" is not a Metadata & matching setting.`);
        }
        if (SETTING_DEFINITIONS[key].secret === true && String(value).startsWith("set (")) continue;
        await setSetting(key, value, { db: db(), setBy: "user" });
        saved.push(key);
      }
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });

/** The "Test" button next to a source, and the one above the table. */
export const testSources = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ source: z.enum(SOURCE_NAMES).optional() }))
  .handler(async ({ data }): Promise<readonly SourceTestResult[]> => {
    try {
      const settings = await loadSettings(db());
      if (data.source === undefined) return await testAllSources({ db: db(), settings });
      return [await testSource(data.source, { db: db(), settings })];
    } catch (error) {
      return toFailure(error);
    }
  });

/** Which profiles read a field — the dots of the tag-map table, computed once. */
export const fetchProfileIds = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<readonly string[]> => {
    await Promise.resolve();
    return [...PROFILE_IDS];
  });
