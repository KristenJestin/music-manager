/**
 * Settings → Downloader.
 *
 * The whole tab is one read and one write, both validated by the settings registry rather
 * than by a schema written twice: `parseValue` in `services/settings.ts` is the only judge of
 * what a knob may hold, so a field the Console offers can never store something the worker
 * would then choke on.
 *
 * The tool paths are **read-only**, and deliberately so. The binaries live in the toolbox
 * image (`CLAUDE.md` § Machine setup); a text box that let you point `ffmpeg` somewhere on
 * the host would be a lie on every installation but one.
 */
import { z } from "zod";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { loadSettings, setSetting } from "#/server/services/settings.ts";
import { downloaderHealth, type DownloaderHealth } from "#/server/services/tools.ts";

const form = z.object({
  ytdlpAutoUpdate: z.boolean(),
  ytdlpUpdateCron: z.string().min(1),
  ytdlpChannel: z.enum(["stable", "nightly", "master"]),
  ytdlpPin: z.string(),
  ytdlpOnUpdateFailure: z.enum(["warn", "pause_downloads", "rollback"]),
  cookiesMode: z.enum(["anonymous", "file"]),
  cookiesFile: z.string(),
  downloadProxy: z.string(),
  downloadJitterMinMs: z.number().int().min(0),
  downloadJitterMaxMs: z.number().int().min(0),
  downloadMaxAttempts: z.number().int().min(1).max(10),
  downloadBackoffBaseMs: z.number().int().min(0),
  downloadBackoffMaxMs: z.number().int().min(0),
  downloadFormat: z.string().min(1),
  ytdlpPlayerClient: z.string(),
  ytdlpExtraArgs: z.array(z.string()),
});

export type DownloaderForm = z.infer<typeof form>;

export interface DownloaderSettingsPayload {
  readonly values: DownloaderForm;
  readonly health: DownloaderHealth;
}

export const fetchDownloaderSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<DownloaderSettingsPayload> => {
    try {
      const database = db();
      const settings = await loadSettings(database);
      return {
        values: {
          ytdlpAutoUpdate: settings.ytdlpAutoUpdate,
          ytdlpUpdateCron: settings.ytdlpUpdateCron,
          ytdlpChannel: settings.ytdlpChannel,
          ytdlpPin: settings.ytdlpPin,
          ytdlpOnUpdateFailure: settings.ytdlpOnUpdateFailure,
          cookiesMode: settings.cookiesMode,
          cookiesFile: settings.cookiesFile,
          downloadProxy: settings.downloadProxy,
          downloadJitterMinMs: settings.downloadJitterMinMs,
          downloadJitterMaxMs: settings.downloadJitterMaxMs,
          downloadMaxAttempts: settings.downloadMaxAttempts,
          downloadBackoffBaseMs: settings.downloadBackoffBaseMs,
          downloadBackoffMaxMs: settings.downloadBackoffMaxMs,
          downloadFormat: settings.downloadFormat,
          ytdlpPlayerClient: settings.ytdlpPlayerClient,
          ytdlpExtraArgs: settings.ytdlpExtraArgs,
        },
        health: await downloaderHealth({ db: database, settings }),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const saveDownloaderSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(form)
  .handler(async ({ data }): Promise<{ saved: number }> => {
    try {
      const database = db();
      let saved = 0;
      for (const [key, value] of Object.entries(data)) {
        await setSetting(key as keyof DownloaderForm, value, { db: database });
        saved += 1;
      }
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });
