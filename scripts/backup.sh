#!/usr/bin/env bash
# Take a backup of a running Music Manager stack.
#
#   ./scripts/backup.sh                 # -> backups/music-manager-<stamp>.tar.gz
#   ./scripts/backup.sh -o /srv/backups
#
# The archive holds two files and a manifest:
#
#   postgres.dump   pg_dump -Fc of the whole database. The authoritative copy; `restore.sh`
#                   replays this one.
#   export.json     the portable projection — metadata documents, the raw source cache, the
#                   non-secret settings (`docs/03-metadonnees.md` §8). It outlives a Postgres
#                   major version and can be read without a database.
#   manifest.json   what this is a backup of: date, app version, image digests, row counts.
#                   `restore.sh` prints the counts back so the two can be compared.
#
# **The music is not in here.** The library is a volume of its own, it is measured in hundreds
# of gigabytes, and files are a regenerable projection of the database — which is exactly why
# the database is the thing worth backing up nightly. `docs/deploy.md` § « Sauvegarde » says
# how to back up the library itself (rsync, restic, the hypervisor's snapshot: not this).
#
# Nothing here prints a secret: pg_dump talks to postgres over the compose network with the
# password already in the container's environment, and `export.json` excludes every credential.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ops-lib.sh"

OUT_DIR="$MM_ROOT/backups"
while [ $# -gt 0 ]; do
  case "$1" in
    -o | --out) OUT_DIR="$2"; shift 2 ;;
    -h | --help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

need docker

STAMP="$(date -u +%Y%m%d-%H%M%S)"
NAME="music-manager-$STAMP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT_DIR"

step "checking the stack"
compose ps --status running --services | grep -qx postgres \
  || die "the postgres service is not running. Start the stack first: docker compose -f $MM_COMPOSE_FILE up -d"
ok "postgres is up"

USER_NAME="$(pg_user)"
DB_NAME="$(pg_db)"

step "pg_dump"
# `-Fc` (custom format) rather than plain SQL: it is compressed, and `pg_restore` can be told
# to continue past an object it cannot recreate — which is what makes restoring into a
# database created by a *newer* postgres survivable.
compose exec -T postgres pg_dump -U "$USER_NAME" -d "$DB_NAME" -Fc --no-owner --no-privileges \
  > "$WORK/postgres.dump"
[ -s "$WORK/postgres.dump" ] || die "pg_dump produced an empty file"
ok "postgres.dump ($(du -h "$WORK/postgres.dump" | cut -f1))"

step "export.json"
# The same code path as the Console's Export button (`server/services/backup.ts`), so a backup
# taken by cron and one taken by hand are the same file.
if compose exec -T web bun /app/apps/web/bin/backup-export.ts > "$WORK/export.json" 2> "$WORK/export.log"; then
  ok "export.json ($(du -h "$WORK/export.json" | cut -f1)) — $(tail -n 1 "$WORK/export.log")"
else
  # A stack whose `web` is down still deserves a database dump; the JSON is the redundant half.
  bad "the JSON export failed — the dump above is still valid"
  sed 's/^/    /' "$WORK/export.log" >&2
  printf '{"version":1,"unavailable":true}\n' > "$WORK/export.json"
fi

step "manifest"
DOCUMENTS="$(json_get_number documents < "$WORK/export.json" || true)"
CACHE_ROWS="$(compose exec -T postgres psql -tAqU "$USER_NAME" -d "$DB_NAME" -c 'select count(*) from source_cache' 2>/dev/null | tr -d '\r' || true)"
IMPORTS="$(compose exec -T postgres psql -tAqU "$USER_NAME" -d "$DB_NAME" -c 'select count(*) from imports' 2>/dev/null | tr -d '\r' || true)"
TRACKS="$(compose exec -T postgres psql -tAqU "$USER_NAME" -d "$DB_NAME" -c 'select count(*) from library_tracks' 2>/dev/null | tr -d '\r' || true)"
APP_VERSION="$(curl -fsS "$(web_url)/health" 2>/dev/null | json_get version || true)"

cat > "$WORK/manifest.json" <<JSON
{
  "kind": "music-manager-backup",
  "version": 1,
  "takenAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "appVersion": "${APP_VERSION:-unknown}",
  "database": "$DB_NAME",
  "counts": {
    "imports": ${IMPORTS:-null},
    "libraryTracks": ${TRACKS:-null},
    "sourceCache": ${CACHE_ROWS:-null},
    "documents": ${DOCUMENTS:-null}
  }
}
JSON
sed 's/^/    /' "$WORK/manifest.json"

step "archive"
ARCHIVE="$OUT_DIR/$NAME.tar.gz"
# `-C` so the archive holds three plain names and not a temporary directory's path, and the
# archive goes to **stdout**: `tar -czf D:/…` makes GNU tar read `D:` as a remote host
# ("Cannot connect to D: resolve failed"), which is how an agent testing this from a Windows
# checkout loses a backup it just spent a minute making. `> "$ARCHIVE"` has no such syntax.
tar -czf - -C "$WORK" manifest.json postgres.dump export.json > "$ARCHIVE"
( cd "$OUT_DIR" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" ) 2>/dev/null || true

ok "$ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
say ""
say "Restore it with:  ./scripts/restore.sh \"$ARCHIVE\""
