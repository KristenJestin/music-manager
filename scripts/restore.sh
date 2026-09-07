#!/usr/bin/env bash
# Restore a backup taken by `scripts/backup.sh`, into a database that may or may not exist.
#
#   ./scripts/restore.sh backups/music-manager-20260907-213000.tar.gz
#   ./scripts/restore.sh --yes <archive>      # no confirmation prompt (cron, CI)
#
# It is written to be the second half of the acceptance criterion of
# `docs/phases/P10-production.md`:
#
#   ./scripts/backup.sh && docker compose -f docker-compose.prod.yml down -v \
#     && ./scripts/restore.sh <archive> && ./scripts/smoke.sh
#
# — so it starts postgres itself if the stack is down, which after `down -v` means an empty
# volume and a database with nothing in it.
#
# **The order matters and is the whole design.** `web` applies the Drizzle migrations when it
# starts; a `pg_restore` into an already-migrated database is a fight between two definitions of
# the same tables. So this script brings up **postgres alone**, drops and recreates the
# database, restores into the empty one, and only then starts the rest — at which point `web`
# runs its migrations, finds the journal restored from the dump, and has nothing to do.
#
# `postgres.dump` is the source of truth. `export.json` is carried along and its counts are
# compared with what landed, because "the restore said OK" and "the rows are there" are two
# different claims and only the second one is worth anything.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ops-lib.sh"

ARCHIVE=""
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) ASSUME_YES=1; shift ;;
    -h | --help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown argument: $1" ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done

[ -n "$ARCHIVE" ] || die "usage: ./scripts/restore.sh [--yes] <archive.tar.gz>"
[ -f "$ARCHIVE" ] || die "no such archive: $ARCHIVE"
need docker

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

step "reading $ARCHIVE"
# Read from stdin, for the same reason `backup.sh` writes to stdout: a path with a drive letter
# looks like `host:path` to GNU tar.
tar -xzf - -C "$WORK" < "$ARCHIVE"
[ -f "$WORK/postgres.dump" ] || die "the archive has no postgres.dump — is it a Music Manager backup?"
[ -f "$WORK/manifest.json" ] && sed 's/^/    /' "$WORK/manifest.json"

EXPECT_IMPORTS="$(json_get_number imports < "$WORK/manifest.json" 2>/dev/null || true)"
EXPECT_TRACKS="$(json_get_number libraryTracks < "$WORK/manifest.json" 2>/dev/null || true)"
EXPECT_CACHE="$(json_get_number sourceCache < "$WORK/manifest.json" 2>/dev/null || true)"

USER_NAME="$(pg_user)"
DB_NAME="$(pg_db)"

if [ "$ASSUME_YES" -ne 1 ]; then
  say ""
  say "This DROPS the database \"$DB_NAME\" of this stack and replaces it with the archive."
  printf 'Type the database name to continue: '
  read -r answer
  [ "$answer" = "$DB_NAME" ] || die "aborted"
fi

step "postgres alone"
# Only postgres. Starting `web` here would migrate the database we are about to drop.
compose up -d postgres
for _ in $(seq 1 60); do
  if compose exec -T postgres pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1; then break; fi
  sleep 2
done
compose exec -T postgres pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1 \
  || die "postgres did not become ready"
ok "postgres is ready"

step "a database with nothing in it"
# `dropdb --force` (postgres 13+) disconnects whoever is still attached — pg_boss keeps a
# connection open for LISTEN, and a single stale one is enough to make DROP DATABASE fail.
compose exec -T postgres dropdb --force --if-exists -U "$USER_NAME" "$DB_NAME"
compose exec -T postgres createdb -U "$USER_NAME" -O "$USER_NAME" "$DB_NAME"
ok "$DB_NAME recreated"

step "pg_restore"
# `--no-owner`/`--no-privileges`: the dump was taken without them, and a restore that insists
# on recreating a role the target does not have fails for a reason nobody cares about.
if compose exec -T postgres pg_restore -U "$USER_NAME" -d "$DB_NAME" --no-owner --no-privileges \
  < "$WORK/postgres.dump" > "$WORK/restore.log" 2>&1; then
  ok "restored"
else
  # pg_restore exits non-zero on warnings too (an extension already present, a comment on an
  # object it did not create). Report them and let the row counts below be the verdict.
  bad "pg_restore reported problems:"
  sed 's/^/    /' "$WORK/restore.log" | tail -n 20 >&2
fi

step "counting what landed"
count() {
  compose exec -T postgres psql -tAqU "$USER_NAME" -d "$DB_NAME" -c "select count(*) from $1" 2>/dev/null | tr -d '\r' || printf 'n/a'
}
GOT_IMPORTS="$(count imports)"
GOT_TRACKS="$(count library_tracks)"
GOT_CACHE="$(count source_cache)"

compare() {
  local label="$1" expected="$2" got="$3"
  if [ -z "$expected" ] || [ "$expected" = "null" ]; then
    say "     ?  $label: $got (the manifest did not say)"
    return 0
  fi
  if [ "$expected" = "$got" ]; then
    ok "$label: $got"
    return 0
  fi
  bad "$label: expected $expected, found $got"
  return 1
}

FAILED=0
compare "imports" "$EXPECT_IMPORTS" "$GOT_IMPORTS" || FAILED=1
compare "library_tracks" "$EXPECT_TRACKS" "$GOT_TRACKS" || FAILED=1
compare "source_cache" "$EXPECT_CACHE" "$GOT_CACHE" || FAILED=1

step "starting the rest of the stack"
compose up -d
ok "up"

say ""
if [ "$FAILED" -eq 0 ]; then
  say 'Restored: the database only. The audio files live on the "library" volume, which this'
  say 'script never touches — and which "docker compose down -v" *does* delete, so a full'
  say 'rehearsal of the acceptance sequence comes back with the right rows and an empty library.'
  say "Check it: ./scripts/smoke.sh"
else
  die "the row counts do not match the manifest — do not treat this restore as complete"
fi
