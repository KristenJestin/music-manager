#!/usr/bin/env bash
# Shared by `backup.sh`, `restore.sh` and `smoke.sh`.
#
# These three are the only shell scripts in the repository — everything else is Bun and
# cross-platform (`CLAUDE.md` § Commands). They are shell because they are *operations*: they
# run on a server that has Docker and a POSIX shell and, deliberately, nothing else installed.
# They must therefore not need Bun on the host, or Node, or jq.
#
# Sourced, not executed:  . "$(dirname "$0")/ops-lib.sh"
#
# The name is `ops-lib.sh` and not `lib.sh` because `scripts/lib.ts` is the *Bun* helpers of the
# same directory, and two files called `lib` that run under two different interpreters is a
# question nobody should have to ask.

set -euo pipefail

# Git Bash on Windows rewrites arguments that look like absolute POSIX paths, which mangles
# every *in-container* path handed to `docker compose exec` (`/app/apps/web/bin/…` becomes
# `C:/Program Files/Git/app/…`). Excluding `/app` fixes exactly that and nothing else — turning
# the conversion off wholesale (`MSYS2_ARG_CONV_EXCL='*'`) breaks the *host* paths in the same
# scripts, because mingw `curl` then receives `/tmp/…` and cannot write to it. On a server the
# variable does not exist and is ignored.
export MSYS2_ARG_CONV_EXCL='/app'

MM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export MM_ROOT

# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_BAD=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
  C_OK=''; C_BAD=''; C_DIM=''; C_OFF=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '\n%s=== %s ===%s\n' "$C_DIM" "$*" "$C_OFF"; }
ok()   { printf '%s  ok %s%s\n' "$C_OK" "$C_OFF" "$*"; }
bad()  { printf '%sfail %s%s\n' "$C_BAD" "$C_OFF" "$*" >&2; }
die()  { bad "$*"; exit 1; }

# ---------------------------------------------------------------------------
# compose
# ---------------------------------------------------------------------------
# Every script talks to one stack, described by three things an operator may override:
#
#   MM_COMPOSE_FILE     default docker-compose.prod.yml, relative to the repository root
#   MM_COMPOSE_PROJECT  default unset — compose then uses `name:` from the file
#   MM_ENV_FILE         default unset — compose then uses ./.env
#
# They are environment variables rather than flags so that a cron entry can set them once:
#   MM_COMPOSE_PROJECT=music-manager /opt/music-manager/scripts/backup.sh
MM_COMPOSE_FILE="${MM_COMPOSE_FILE:-docker-compose.prod.yml}"

compose() {
  local args=(compose -f "$MM_ROOT/$MM_COMPOSE_FILE")
  [ -n "${MM_COMPOSE_PROJECT:-}" ] && args+=(-p "$MM_COMPOSE_PROJECT")
  [ -n "${MM_ENV_FILE:-}" ] && args+=(--env-file "$MM_ENV_FILE")
  (cd "$MM_ROOT" && docker "${args[@]}" "$@")
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required and is not on PATH."
}

# ---------------------------------------------------------------------------
# reading the environment file
# ---------------------------------------------------------------------------
# The scripts need three values compose already knows (the postgres user, database and the
# published port). Reading `.env` here rather than asking compose keeps them working when the
# stack is down, which is exactly the moment `restore.sh` runs.
env_value() {
  local key="$1" fallback="${2:-}" file="${MM_ENV_FILE:-$MM_ROOT/.env}" line
  if [ -f "$file" ]; then
    line="$(grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
    if [ -n "$line" ]; then
      line="${line#*=}"
      line="${line%\"}"; line="${line#\"}"
      line="${line%\'}"; line="${line#\'}"
      [ -n "$line" ] && { printf '%s' "$line"; return; }
    fi
  fi
  printf '%s' "$fallback"
}

pg_user() { env_value MM_POSTGRES_USER mm; }
pg_db()   { env_value MM_POSTGRES_DB mm; }

# The URL the scripts poke from the host. `MM_WEB_URL` is the *public* address (it can be
# behind a proxy on another machine), so it is not usable as a probe target; the published
# port is.
web_url() {
  if [ -n "${MM_SMOKE_URL:-}" ]; then printf '%s' "${MM_SMOKE_URL%/}"; return; fi
  local bind port
  bind="$(env_value MM_WEB_BIND 127.0.0.1)"
  [ "$bind" = "0.0.0.0" ] && bind=127.0.0.1
  port="$(env_value MM_WEB_PORT 3200)"
  printf 'http://%s:%s' "$bind" "$port"
}

# ---------------------------------------------------------------------------
# JSON, without jq
# ---------------------------------------------------------------------------
# `jq` is used when it is installed, and it is worth installing. The fallback reads the **first**
# occurrence of a key in document order, which is all these scripts ever ask for: the payloads
# they read (`/health`, `/api/v1/imports/{id}`, the backup manifest) put their top-level scalars
# before any nested array.
#
# First, not last, and that distinction cost an hour: `sed 's/.*"status":"\([^"]*\)".*/\1/'` is
# greedy, so on an import detail it returned the `status` of the last *inbox item* — "open" —
# while the import itself said "failed", and the smoke run reported a timeout instead of a
# failure. `grep -o | head -1` takes them in order and cannot do that.
#
# Anything more than this is a JSON parser written in sed, and that is not a thing to own.
json_get() {
  local key="$1" body
  body="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r --arg k "$key" '.[$k] // empty'
    return
  fi
  printf '%s' "$body" | tr -d '\n' \
    | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n 1 \
    | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/'
}

json_get_number() {
  local key="$1" body
  body="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r --arg k "$key" '.[$k] // empty'
    return
  fi
  printf '%s' "$body" | tr -d '\n' \
    | grep -o "\"${key}\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" \
    | head -n 1 \
    | sed 's/.*:[[:space:]]*//'
}
