#!/usr/bin/env bash
# Is this deployment actually working? (`docs/phases/P10-production.md` § Exploitation.)
#
#   ./scripts/smoke.sh              # health, headers, login, an offline fixture import
#   ./scripts/smoke.sh --real       # …and one real short import, if this box has network
#   ./scripts/smoke.sh --no-import  # the cheap half only, for a cron/monitoring probe
#
# It talks to the stack the way a client does — over the published port, with a cookie jar —
# rather than by running things inside the containers, because the thing being tested is the
# deployment and not the code. The one exception is the toolbox, and that exception *is* a
# check: the only way to reach it is from inside the compose network, and the script proves
# that by first showing there is no published port at all.
#
# The credentials come from `.env` (MM_ADMIN_EMAIL / MM_ADMIN_PASSWORD) or from the
# environment. They are never printed, and the cookie jar lives in a temporary directory that
# is removed on exit.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ops-lib.sh"

DO_IMPORT=1
DO_REAL=0
REAL_URL="${MM_SMOKE_REAL_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"
while [ $# -gt 0 ]; do
  case "$1" in
    --no-import) DO_IMPORT=0; shift ;;
    --real) DO_REAL=1; shift ;;
    --real-url) DO_REAL=1; REAL_URL="$2"; shift 2 ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

need docker
need curl

BASE="$(web_url)"
# Better Auth compares the browser's `Origin` against MM_WEB_URL and answers 403 INVALID_ORIGIN
# when they differ — so a probe that pokes the published port has to *claim* the public origin,
# exactly as the reverse proxy's client does. `http://127.0.0.1:3200` and `http://localhost:3200`
# are two different origins as far as that check is concerned, which is the whole trap.
ORIGIN="$(env_value MM_WEB_URL "$BASE")"
ORIGIN="${ORIGIN%/}"
WORK="$(mktemp -d)"
JAR="$WORK/cookies"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
fail() { bad "$*"; FAILED=1; }

say "target   $BASE"
say "project  ${MM_COMPOSE_PROJECT:-<from $MM_COMPOSE_FILE>}"

# ---------------------------------------------------------------------------
step "1. the web service answers /health"
# ---------------------------------------------------------------------------
HEALTH=""
for _ in $(seq 1 30); do
  HEALTH="$(curl -fsS --max-time 5 "$BASE/health" 2>/dev/null || true)"
  [ -n "$HEALTH" ] && break
  sleep 2
done
if [ -z "$HEALTH" ]; then
  fail "no answer from $BASE/health"
else
  ok "version $(printf '%s' "$HEALTH" | json_get version) — $HEALTH"
fi

# ---------------------------------------------------------------------------
step "2. the toolbox is reachable from the network and from nowhere else"
# ---------------------------------------------------------------------------
# `docker compose port` prints the host mapping of a container port. No output means the port
# was never published — which is the requirement, stated as a fact about the running stack
# rather than as a claim about the compose file.
# An unpublished port makes compose print nothing on some versions and the placeholder
# `invalid IP:0` on others, so "published" is "there is a real port number after the colon".
PUBLISHED="$(compose port toolbox 8100 2>/dev/null | tr -d '\r' | grep -E ':[1-9][0-9]*$' || true)"
if [ -n "$PUBLISHED" ]; then
  fail "the toolbox is published on $PUBLISHED — it must not be reachable from outside"
else
  ok "no published port for the toolbox"
fi

# The image has python and no curl, which is also what its own HEALTHCHECK uses.
TB="$(compose exec -T toolbox python -c \
  "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=5).read().decode())" \
  2>/dev/null | tr -d '\r' || true)"
if printf '%s' "$TB" | grep -q '"ok"'; then
  ok "toolbox /health answers on the compose network"
  printf '%s\n' "$TB" | cut -c1-200 | sed 's/^/     /'
else
  fail "the toolbox did not answer /health from inside the network"
fi

# ---------------------------------------------------------------------------
step "3. security headers and the rate limit are in front of everything"
# ---------------------------------------------------------------------------
HEADERS="$(curl -fsSI --max-time 5 "$BASE/login" 2>/dev/null || true)"
for header in x-frame-options x-content-type-options content-security-policy referrer-policy; do
  if printf '%s' "$HEADERS" | tr 'A-Z' 'a-z' | grep -q "^$header:"; then
    ok "$header"
  else
    fail "$header is missing from GET /login"
  fi
done

# ---------------------------------------------------------------------------
step "4. sign in"
# ---------------------------------------------------------------------------
EMAIL="${MM_ADMIN_EMAIL:-$(env_value MM_ADMIN_EMAIL)}"
PASSWORD="${MM_ADMIN_PASSWORD:-$(env_value MM_ADMIN_PASSWORD)}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  say "     ?  no MM_ADMIN_EMAIL / MM_ADMIN_PASSWORD — skipping everything that needs a session"
  DO_IMPORT=0
else
  # The Console is a browser app: `ensureAdmin()` runs inside the first request that asks for a
  # session, so a fresh installation has no user row until something loads a page. One GET is
  # what turns MM_ADMIN_EMAIL into an account.
  curl -fsS --max-time 20 -o /dev/null "$BASE/" 2>/dev/null || true

  # The body is written to a file rather than interpolated on the command line: an argument
  # list is visible in `ps` to every user on the box, and the password is in it.
  printf '{"email":"%s","password":"%s"}' \
    "$(printf '%s' "$EMAIL" | sed 's/[\\"]/\\&/g')" \
    "$(printf '%s' "$PASSWORD" | sed 's/[\\"]/\\&/g')" > "$WORK/login-body.json"
  CODE="$(curl -sS --max-time 20 -o "$WORK/login.json" -w '%{http_code}' \
    -c "$JAR" -b "$JAR" \
    -H 'content-type: application/json' \
    -H "origin: $ORIGIN" \
    --data-binary "@$WORK/login-body.json" \
    "$BASE/api/auth/sign-in/email" || true)"
  rm -f "$WORK/login-body.json"
  if [ "$CODE" = "200" ]; then
    ok "signed in as $EMAIL"
  else
    fail "sign-in answered HTTP $CODE"
    sed 's/^/     /' "$WORK/login.json" 2>/dev/null | cut -c1-300
    DO_IMPORT=0
  fi

  ME="$(curl -sS --max-time 10 -b "$JAR" "$BASE/api/v1/me" || true)"
  if printf '%s' "$ME" | grep -q '"kind"'; then
    ok "/api/v1/me accepts the session cookie"
  else
    fail "/api/v1/me refused the session: $(printf '%s' "$ME" | cut -c1-200)"
  fi
fi

# ---------------------------------------------------------------------------
# an import, start to finish
# ---------------------------------------------------------------------------
run_import() {
  local label="$1" url="$2" timeout="$3" body id status step_name
  step "$label"
  body="$(curl -sS --max-time 60 -b "$JAR" -H 'content-type: application/json' \
    -d "{\"url\":\"$url\",\"options\":{\"autoConfirm\":true},\"priority\":\"next\"}" \
    "$BASE/api/v1/imports" || true)"
  id="$(printf '%s' "$body" | json_get id)"
  if [ -z "$id" ]; then
    fail "the import was not created: $(printf '%s' "$body" | cut -c1-400)"
    return 1
  fi
  ok "import $id created from $url"

  local waited=0
  while [ "$waited" -lt "$timeout" ]; do
    body="$(curl -sS --max-time 15 -b "$JAR" "$BASE/api/v1/imports/$id" || true)"
    status="$(printf '%s' "$body" | json_get status)"
    step_name="$(printf '%s' "$body" | json_get step)"
    case "$status" in
      done)
        ok "reached done after ${waited}s"
        return 0
        ;;
      failed | cancelled)
        fail "the import ended $status at step $step_name"
        printf '%s' "$body" | cut -c1-500 | sed 's/^/     /'
        return 1
        ;;
      awaiting_confirm | awaiting_review)
        fail "the import is parked in $status at step $step_name — a smoke run must not need a human"
        return 1
        ;;
    esac
    sleep 3
    waited=$((waited + 3))
    [ $((waited % 30)) -eq 0 ] && say "     … $status / $step_name (${waited}s)"
  done
  fail "still $status at step $step_name after ${timeout}s"
  return 1
}

if [ "$DO_IMPORT" -eq 1 ]; then
  # `fixture://` needs both halves of fixtures mode: MM_TOOLBOX_FIXTURES for the download and
  # MM_FIXTURES for MusicBrainz and the rest. A stack in real mode answers "unknown scheme".
  if [ "$(env_value MM_FIXTURES 0)" = "1" ] && [ "$(env_value MM_TOOLBOX_FIXTURES 0)" = "1" ]; then
    step "5a. seeding the offline source cache"
    # Fixtures mode does not *invent* MusicBrainz answers, it replays recorded ones out of
    # `source_cache`. A fresh database has none, so `tag` fails with OFFLINE_CACHE_MISS after
    # a download that went perfectly — which reads like a broken pipeline and is an empty
    # table. Seeding is idempotent; `bun run cache:seed-fixtures` is the same thing on a host.
    if compose exec -T web bun /app/apps/web/src/server/integrations/seed-fixtures.ts 2>&1 | tail -n 1 | sed 's/^/     /'; then
      ok "source cache seeded"
    else
      fail "could not seed the offline source cache"
    fi
    run_import "5b. an offline import (fixture://skinny-love)" "fixture://skinny-love" 300 || true
  else
    say ""
    say "     ?  MM_FIXTURES / MM_TOOLBOX_FIXTURES are not both 1 — skipping the fixture import."
    say "        That is the right setting for a real installation; run the fixture pass on a"
    say "        stack started with both at 1 (that is what the P10 acceptance run does)."
  fi

  if [ "$DO_REAL" -eq 1 ]; then
    if [ "$(env_value MM_FIXTURES 0)" = "1" ]; then
      # In fixtures mode every source is a recording, so a real URL fails at `match` with
      # OFFLINE_CACHE_MISS — a confusing way to say "this stack is offline on purpose".
      say "     ?  MM_FIXTURES=1 — a real import cannot work on an offline stack, skipping"
    elif curl -fsS --max-time 8 -o /dev/null https://musicbrainz.org/ 2>/dev/null; then
      run_import "6. a real import ($REAL_URL)" "$REAL_URL" 900 || true
    else
      say "     ?  no network to musicbrainz.org — skipping the real import"
    fi
  fi
fi

# ---------------------------------------------------------------------------
step "last. the sign-in rate limit actually refuses"
# ---------------------------------------------------------------------------
# Deliberately at the end: it spends the login bucket, so anything after it would be answered
# 429 for reasons that have nothing to do with what it was testing.
LIMIT="$(env_value MM_RATE_LIMIT_LOGIN 10)"
[ -z "$LIMIT" ] && LIMIT=10
if [ "$LIMIT" = "0" ]; then
  say "     ?  MM_RATE_LIMIT_LOGIN=0 — the bucket is off, nothing to check"
else
  SAW_429=0
  ATTEMPTS=$((LIMIT + 3))
  for _ in $(seq 1 "$ATTEMPTS"); do
    CODE="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
      -H 'content-type: application/json' -H "origin: $ORIGIN" \
      -d '{"email":"nobody@example.invalid","password":"wrong-on-purpose"}' \
      "$BASE/api/auth/sign-in/email" || true)"
    [ "$CODE" = "429" ] && { SAW_429=1; break; }
  done
  if [ "$SAW_429" -eq 1 ]; then
    ok "a burst of wrong passwords is cut off with 429"
  else
    fail "$ATTEMPTS wrong passwords in a row were all accepted for processing (limit $LIMIT)"
  fi
fi

say ""
if [ "$FAILED" -eq 0 ]; then
  ok "smoke: everything above passed"
  exit 0
fi
die "smoke: at least one check failed"
