/**
 * Settings › Library & files.
 *
 * Reading and writing go through `settings.service`, which owns the zod schema of every key.
 * The page therefore cannot invent a value the worker would refuse: `setSetting` parses before
 * it writes, and a rejected value comes back as a message next to the field rather than as a
 * row that breaks a job three steps later.
 *
 * The template preview is computed **server-side by the same renderer `place` uses**
 * (`previewPathTemplate`). A preview drawn by a second implementation in the browser would be
 * a promise the app does not keep.
 */
import { z } from "zod";
import {
  DEFAULT_PATH_TEMPLATE,
  DISC_MODES,
  PATH_TOKENS,
  previewPathTemplate,
  validatePathTemplate,
} from "@mm/domain";
import { createServerFn } from "@tanstack/react-start";
import { MMError } from "@mm/contracts";
import { db } from "#/server/db/client.ts";
import { serverEnv } from "#/server/env.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { GENERAL_KEYS, inGroup } from "#/server/services/settings-groups.ts";
import {
  SETTING_DEFINITIONS,
  loadSettings,
  maskSetting,
  setSetting,
  type SettingKey,
} from "#/server/services/settings.ts";

export interface SettingField {
  readonly key: string;
  readonly value: unknown;
  readonly doc: string;
  readonly secret: boolean;
}

export interface GeneralSettingsPayload {
  readonly fields: readonly SettingField[];
  /** What the template would produce, rendered by the renderer `place` uses. */
  readonly preview: readonly { label: string; path: string }[];
  readonly tokens: readonly { token: string; description: string }[];
  readonly defaultTemplate: string;
  readonly discModes: readonly string[];
  /** Where the two library roots resolve when the settings leave them empty. */
  readonly resolved: { host: string; container: string };
}

function fieldsOf(keys: readonly SettingKey[], settings: Record<string, unknown>): SettingField[] {
  return keys.map((key) => ({
    key,
    value: maskSetting(key, settings[key] as never),
    doc: SETTING_DEFINITIONS[key].doc,
    secret: SETTING_DEFINITIONS[key].secret === true,
  }));
}

export const fetchGeneralSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<GeneralSettingsPayload> => {
    try {
      const settings = await loadSettings(db());
      const env = serverEnv();
      return {
        fields: fieldsOf(GENERAL_KEYS, settings as unknown as Record<string, unknown>),
        preview: previewPathTemplate(settings.pathTemplate, {
          mode: settings.sanitizeMode,
          maxSegmentLength: settings.maxSegmentLength,
          discMode: settings.discMode,
        }),
        tokens: PATH_TOKENS.map((entry) => ({ ...entry })),
        defaultTemplate: DEFAULT_PATH_TEMPLATE,
        discModes: [...DISC_MODES],
        resolved: {
          host: settings.libraryRoot === "" ? env.MM_LIBRARY_ROOT : settings.libraryRoot,
          container:
            settings.toolboxLibraryRoot === ""
              ? env.MM_TOOLBOX_LIBRARY_ROOT
              : settings.toolboxLibraryRoot,
        },
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * A live preview, for a template that has not been saved yet.
 *
 * It is a server call rather than a browser computation on purpose: the answer must come from
 * the same function `place` will call, or the preview is decoration.
 */
export const previewTemplate = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      template: z.string(),
      discMode: z.enum(DISC_MODES).default("prefix"),
      sanitizeMode: z.enum(["unicode", "windows", "strict"]).default("windows"),
    }),
  )
  .handler(
    async ({
      data,
    }): Promise<{
      ok: boolean;
      reason: string;
      preview: readonly { label: string; path: string }[];
    }> => {
      try {
        const check = validatePathTemplate(data.template);
        if (!check.ok) return { ok: false, reason: check.reason, preview: [] };
        const settings = await loadSettings(db());
        return {
          ok: true,
          reason: "",
          preview: previewPathTemplate(data.template, {
            discMode: data.discMode,
            mode: data.sanitizeMode,
            maxSegmentLength: settings.maxSegmentLength,
          }),
        };
      } catch (error) {
        return toFailure(error);
      }
    },
  );

export const saveGeneralSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ values: z.record(z.string(), z.unknown()) }))
  .handler(async ({ data }): Promise<{ saved: readonly string[] }> => {
    try {
      const saved: string[] = [];
      for (const [key, value] of Object.entries(data.values)) {
        if (!inGroup(GENERAL_KEYS, key)) {
          throw new MMError("INVALID_INPUT", `"${key}" is not a Library & files setting.`);
        }
        // A masked secret coming back unchanged means "leave it alone", not "set it to the mask".
        if (SETTING_DEFINITIONS[key].secret === true && String(value).startsWith("set (")) continue;
        await setSetting(key, value, { db: db(), setBy: "user" });
        saved.push(key);
      }
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });
