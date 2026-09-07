/**
 * The JSON half of a backup (`docs/03-metadonnees.md` §8, `docs/phases/P10-production.md`).
 *
 * A backup of this application is two files, and they are not redundant:
 *
 *  - **`postgres.dump`** — everything, in PostgreSQL's own format. It is what `restore.sh`
 *    replays, and it is the only thing that can bring back an installation byte for byte.
 *  - **`export.json`** — the *portable* projection: the metadata documents, the raw source
 *    cache and the non-secret settings. It survives a Postgres major-version change, it can be
 *    read by a human or an agent without a database, and it is the file `docs/03-metadonnees.md`
 *    §8 asks for because the cache is what makes "never download the same thing twice" true.
 *
 * Neither carries a single audio byte: the library is on a volume of its own, and files are a
 * regenerable projection of the database.
 *
 * **Why this lives in `services/` rather than beside the server function that used to hold it.**
 * `scripts/backup.sh` runs on the host, from an operator's shell, with no Console session — so
 * it cannot call a server function. `apps/web/bin/backup-export.ts` calls this instead, and the
 * Console's *Export* button calls it too, which is the point: one implementation, so a backup
 * taken from the command line and one taken from the browser cannot differ.
 *
 * Credentials are excluded (`isSecretSetting`), so the file can be attached to a bug report.
 */
import {
  metadataDocuments,
  settings as settingsTable,
  sourceCache,
} from "#/server/db/schema/index.ts";
import { isSecretSetting, isSettingKey } from "#/server/services/settings.ts";
import { APP_VERSION } from "#/server/version.ts";
import type { Database } from "#/server/db/client.ts";

export interface BackupPayload {
  readonly version: 1;
  readonly exportedAt: string;
  readonly appVersion: string;
  readonly counts: Record<string, number>;
  readonly settings: Record<string, unknown>;
  readonly documents: readonly Record<string, unknown>[];
  readonly cache: readonly Record<string, unknown>[];
}

/** Read the three tables and shape the file. */
export async function buildBackup(database: Database): Promise<BackupPayload> {
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
}
