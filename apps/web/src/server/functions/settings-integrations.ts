/**
 * Settings → Integrations: Navidrome, notifications, and the backup.
 *
 * Three rules hold this tab together:
 *
 *  - **A password is written but never read back.** `fetchIntegrationSettings` returns the
 *    masked form (`set (5 chars, …in)`), and an empty string on save means "leave it alone"
 *    rather than "clear it" — otherwise loading the page and pressing Save would wipe the
 *    credential, which is the classic way a settings form loses a password.
 *  - **Notifications are delivered here as of P08.** The channel, its target and the events
 *    are settings; `services/notifications.ts` owns the three transports, and `testNotification`
 *    sends one now against the values in the form.
 *  - **The backup is documents and cache** (`docs/03-metadonnees.md` §8): restoring is
 *    re-projecting, so the export does not carry a single audio byte.
 */
import { z } from "zod";
import { notifiableEventSchema } from "@mm/contracts";
import { createServerFn } from "@tanstack/react-start";
import { db } from "#/server/db/client.ts";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import {
  navidromeStatus,
  requestRescan,
  type NavidromeStatus,
} from "#/server/services/navidrome.ts";
import { loadSettings, maskSetting, setSetting } from "#/server/services/settings.ts";
import { send as sendNotification, type DeliveryOutcome } from "#/server/services/notifications.ts";

const form = z.object({
  navidromeEnabled: z.boolean(),
  navidromeUrl: z.string(),
  navidromeUser: z.string(),
  /** Empty means "unchanged". A settings form must not be able to erase a credential. */
  navidromePassword: z.string(),
  navidromeRescanOnVerify: z.boolean(),
  navidromeWaitTimeoutMs: z.number().int().min(1_000).max(3_600_000),
  notificationsEnabled: z.boolean(),
  notificationsChannel: z.enum(["none", "ntfy", "discord", "email"]),
  /** Empty means "unchanged", like every other secret on this tab. */
  notificationsTarget: z.string(),
  notificationsEvents: z.array(notifiableEventSchema),
  /* SMTP, used only by `notificationsChannel: "email"`. */
  smtpHost: z.string(),
  smtpPort: z.number().int().min(1).max(65_535),
  smtpUser: z.string(),
  /** Empty means "unchanged". */
  smtpPassword: z.string(),
  smtpFrom: z.string(),
  smtpTls: z.boolean(),
});

export type IntegrationsForm = z.infer<typeof form>;

/** The fields of this tab where an empty submission means "unchanged", not "clear". */
const SECRET_FIELDS = new Set(["navidromePassword", "smtpPassword", "notificationsTarget"]);

export interface IntegrationsPayload {
  readonly values: Omit<
    IntegrationsForm,
    "navidromePassword" | "smtpPassword" | "notificationsTarget"
  >;
  /** `set (5 chars, …in)` or `""`. Never the value. */
  readonly passwordMask: string;
  readonly smtpPasswordMask: string;
  /** The notification target is a topic URL or a Discord webhook: a secret in practice. */
  readonly notificationsTargetMask: string;
  readonly navidrome: NavidromeStatus;
}

export const fetchIntegrationSettings = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<IntegrationsPayload> => {
    try {
      const database = db();
      const settings = await loadSettings(database);
      return {
        values: {
          navidromeEnabled: settings.navidromeEnabled,
          navidromeUrl: settings.navidromeUrl,
          navidromeUser: settings.navidromeUser,
          navidromeRescanOnVerify: settings.navidromeRescanOnVerify,
          navidromeWaitTimeoutMs: settings.navidromeWaitTimeoutMs,
          notificationsEnabled: settings.notificationsEnabled,
          notificationsChannel: settings.notificationsChannel,
          notificationsEvents: settings.notificationsEvents,
          smtpHost: settings.smtpHost,
          smtpPort: settings.smtpPort,
          smtpUser: settings.smtpUser,
          smtpFrom: settings.smtpFrom,
          smtpTls: settings.smtpTls,
        },
        passwordMask: String(maskSetting("navidromePassword", settings.navidromePassword)),
        smtpPasswordMask: String(maskSetting("smtpPassword", settings.smtpPassword)),
        notificationsTargetMask: String(
          maskSetting("notificationsTarget", settings.notificationsTarget),
        ),
        navidrome: await navidromeStatus({ db: database, settings }),
      };
    } catch (error) {
      return toFailure(error);
    }
  });

export const saveIntegrationSettings = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(form)
  .handler(async ({ data }): Promise<{ saved: number }> => {
    try {
      const database = db();
      let saved = 0;
      for (const [key, value] of Object.entries(data)) {
        // An empty secret means "leave it alone". A settings form must not be able to erase
        // a credential just because it was never shown the current one.
        if (SECRET_FIELDS.has(key) && value === "") continue;
        await setSetting(key as keyof IntegrationsForm, value, { db: database });
        saved += 1;
      }
      return { saved };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * The "Test" button.
 *
 * It takes the form's current values rather than the stored ones, so you can find out whether
 * a password works *before* saving it — which is the only order in which the button is useful.
 */
export const testNavidrome = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      url: z.string().optional(),
      user: z.string().optional(),
      password: z.string().optional(),
    }),
  )
  .handler(async ({ data }): Promise<NavidromeStatus> => {
    try {
      const database = db();
      const stored = await loadSettings(database);
      const settings = {
        ...stored,
        navidromeEnabled: true,
        navidromeUrl: data.url ?? stored.navidromeUrl,
        navidromeUser: data.user ?? stored.navidromeUser,
        navidromePassword:
          data.password === undefined || data.password === ""
            ? stored.navidromePassword
            : data.password,
      };
      return await navidromeStatus({ db: database, settings });
    } catch (error) {
      return toFailure(error);
    }
  });

export const rescanNavidrome = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ full: z.boolean().default(false) }).default({ full: false }))
  .handler(
    async ({ data }): Promise<{ started: boolean; scanning: boolean; error: string | null }> => {
      try {
        return await requestRescan({ db: db(), full: data.full });
      } catch (error) {
        return toFailure(error);
      }
    },
  );

/* ------------------------------------------------------------------ */
/* backup                                                              */
/* ------------------------------------------------------------------ */

export interface BackupPayload {
  readonly version: 1;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly counts: Record<string, number>;
  readonly settings: Record<string, unknown>;
  readonly documents: readonly Record<string, unknown>[];
  readonly cache: readonly Record<string, unknown>[];
}

/**
 * Export the database's metadata: settings, documents and the raw source cache.
 *
 * §8 again: the cache is small (JSON and images) and is what makes "never re-download" true,
 * so it is the thing worth backing up. Credentials are **not** exported — a backup file that
 * carries your Last.fm key is a backup you cannot share with anyone, including a support
 * thread.
 */
export const exportBackup = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .handler(async (): Promise<BackupPayload> => {
    try {
      const database = db();
      const {
        metadataDocuments,
        sourceCache,
        settings: settingsTable,
      } = await import("#/server/db/schema/index.ts");
      const { isSecretSetting, isSettingKey } = await import("#/server/services/settings.ts");
      const { APP_VERSION } = await import("#/server/version.ts");

      const documents = await database.select().from(metadataDocuments);
      const cache = await database.select().from(sourceCache);
      const rows = await database.select().from(settingsTable);

      const exported: Record<string, unknown> = {};
      for (const row of rows) {
        if (isSettingKey(row.key) && !isSecretSetting(row.key)) exported[row.key] = row.value;
      }

      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        appVersion: APP_VERSION,
        counts: { documents: documents.length, cache: cache.length, settings: rows.length },
        settings: exported,
        documents: documents as unknown as Record<string, unknown>[],
        cache: cache as unknown as Record<string, unknown>[],
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Import a backup.
 *
 * Only the settings block is applied, and only through `parseValue`: restoring documents and
 * cache rows into a live database is a merge with foreign keys into imports that may not
 * exist, and doing it badly is worse than not doing it. The counts are reported so the
 * operator can see what the file contained.
 */
export const importBackup = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      payload: z.object({
        version: z.literal(1),
        settings: z.record(z.string(), z.unknown()).default({}),
        documents: z.array(z.unknown()).default([]),
        cache: z.array(z.unknown()).default([]),
      }),
    }),
  )
  .handler(
    async ({
      data,
    }): Promise<{ settings: number; skipped: string[]; documents: number; cache: number }> => {
      try {
        const database = db();
        const { isSecretSetting, isSettingKey } = await import("#/server/services/settings.ts");
        let applied = 0;
        const skipped: string[] = [];
        for (const [key, value] of Object.entries(data.payload.settings)) {
          if (!isSettingKey(key) || isSecretSetting(key)) {
            skipped.push(key);
            continue;
          }
          try {
            await setSetting(key, value, { db: database, setBy: "import" });
            applied += 1;
          } catch {
            skipped.push(key);
          }
        }
        return {
          settings: applied,
          skipped,
          documents: data.payload.documents.length,
          cache: data.payload.cache.length,
        };
      } catch (error) {
        return toFailure(error);
      }
    },
  );

/**
 * The notifications "Test" button (P08).
 *
 * Like `testNavidrome`, it takes the values *in the form* so that a target can be checked
 * before it is saved. The stored settings supply everything else — the SMTP block in
 * particular, which has no reason to be re-sent from the page just to send one message.
 *
 * An empty `target` means "use the stored one", which is the same rule the save handler
 * applies: the field is masked on load, so an untouched form has nothing in it.
 */
export const testNotification = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      channel: z.enum(["none", "ntfy", "discord", "email"]).optional(),
      target: z.string().optional(),
    }),
  )
  .handler(async ({ data }): Promise<DeliveryOutcome> => {
    try {
      const database = db();
      const stored = await loadSettings(database);
      const settings = {
        ...stored,
        notificationsChannel: data.channel ?? stored.notificationsChannel,
        notificationsTarget:
          data.target === undefined || data.target === ""
            ? stored.notificationsTarget
            : data.target,
      };
      return await sendNotification(
        {
          event: "import.done",
          title: "Music Manager — test notification",
          body: "If you are reading this, the channel works.",
          path: "/settings/integrations",
          priority: "low",
        },
        { settings, db: database },
      );
    } catch (error) {
      return toFailure(error);
    }
  });
