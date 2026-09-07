#!/bin/sh
# Entrypoint for the web image. One image, several roles.
#
#   web      migrations, then the Nitro server        (the default)
#   worker   the pg-boss orchestrator, same image, same commit
#   migrate  apply pending migrations and exit        (for a manual run)
#   mm       the CLI: `docker compose exec web mm import <url>`
#   *        anything else is run as given, so `sh` still gets you a shell
#
# **Migrations run in the `web` role and nowhere else.** They are DDL on a shared database, and
# two containers applying them at once is the one way to turn a routine upgrade into an outage;
# Drizzle's journal is not a lock. `worker` waits for `web` to be healthy (`docker-compose.prod.yml`),
# which by then means "migrated and serving". Set MM_MIGRATE_ON_START=0 to take the step out of
# the boot path and run `migrate` yourself — the escape hatch for a migration you want to watch.
set -e

role="${1:-web}"
shift 2>/dev/null || true

app=/app/apps/web

migrate() {
  echo '{"source":"web","level":"info","msg":"applying migrations"}' >&2
  bun "$app/src/server/db/migrate.ts"
}

case "$role" in
  web)
    case "${MM_MIGRATE_ON_START:-1}" in
      1 | true | yes | on) migrate ;;
      *) echo '{"source":"web","level":"warn","msg":"MM_MIGRATE_ON_START is off"}' >&2 ;;
    esac
    # `.output/server/index.mjs` is the Nitro `bun` preset's entry; it reads PORT itself.
    exec bun "$app/.output/server/index.mjs"
    ;;
  worker)
    exec bun "$app/src/worker/index.ts"
    ;;
  migrate)
    migrate
    ;;
  mm)
    exec bun "$app/bin/mm.ts" "$@"
    ;;
  *)
    exec "$role" "$@"
    ;;
esac
