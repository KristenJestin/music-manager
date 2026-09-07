#!/usr/bin/env bun
/**
 * Print the portable half of a backup to stdout, as JSON.
 *
 *   docker compose -f docker-compose.prod.yml exec -T web \
 *     bun /app/apps/web/bin/backup-export.ts > export.json
 *
 * `scripts/backup.sh` is the thing that actually calls it; this file exists because that script
 * has no Console session and `exportBackup` — the button in Settings → Integrations — is a
 * server function behind one. Both go through `services/backup.ts`, so the file an operator
 * takes from a cron job and the file the owner downloads from the browser are the same file.
 *
 * Only stdout carries the JSON. Anything this needs to say goes to stderr, so
 * `… > export.json` cannot end up with a diagnostic in the middle of the document.
 */
import { db } from "#/server/db/client.ts";
import { buildBackup } from "#/server/services/backup.ts";

const database = db();
try {
  const payload = await buildBackup(database);
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  console.error(
    `backup-export: ${String(payload.counts["documents"] ?? 0)} documents, ` +
      `${String(payload.counts["cache"] ?? 0)} cached responses, ` +
      `${String(payload.counts["settings"] ?? 0)} settings`,
  );
} finally {
  // The pool would otherwise hold the process open for its idle timeout, and a backup script
  // that hangs for thirty seconds after producing its file looks exactly like one that failed.
  await database.$client.end();
}
