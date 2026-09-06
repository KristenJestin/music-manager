# CLAUDE.md — Music Manager v2

Instructions for agents and humans working in this repository.

## What this is

A self-hosted music importer and tagger. You paste a YouTube URL; the app matches it against
MusicBrainz, downloads audio, writes the fullest possible set of standard tags, and files the
result into a library that Navidrome/Feishin/Symfonium read.

Two guiding facts:

- **The database is the source of truth** for metadata, with provenance per field. Files are a
  regenerable projection of it.
- **Objective number one is the maximum of valid tags per track**, written to the standard
  superset (the Picard table), not to one server's dialect.

## Where the specification lives

This repository holds **code only**. The specification lives one level up and is authoritative:

| Path                        | Content                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `../docs/README.md`         | index and ten-line summary                                                 |
| `../docs/phases/PNN-*.md`   | one self-contained spec per phase — **your scope is exactly one of these** |
| `../docs/decisions.md`      | dated decision log; record any deviation here                              |
| `../docs/08-plan-de-dev.md` | repository layout, conventions, Definition of Done                         |
| `../prototypes/A-console/`  | frozen visual reference for the Console UI                                 |
| `../orchestration/reports/` | where agent reports go (`PNN-<role>-<n>.md`)                               |
| `../_scratch/`              | drafts, dumps, experiments                                                 |

**Nothing that is not code, tests, configuration or operations documentation may enter this
repository.** No notes, no screenshots, no scratch files, no reports. Those go to
`../orchestration/` or `../_scratch/`.

Documentation is in French; the UI, code identifiers and commit messages are in English.

## Layout

```
apps/web/              TanStack Start on Bun: Console UI, server functions, /api/v1, MCP, worker, CLI
  src/routes/          file-based routes; a route with `server.handlers` and no component is an API endpoint
  src/server/          server-only code: env, db, auth, services, server functions
  src/components/ui/   shadcn/ui components (Base UI) — do not hand-edit, re-add with the CLI
  src/components/      the shared Console components; `shell/` is the frame around every page
  e2e/                 Playwright specs for the Console (`bun run e2e`)
packages/domain/       pure TypeScript: tag map, metadata document, resolvers, completeness, matching
packages/contracts/    shared zod schemas + the generated toolbox client (toolbox/ is generated)
services/toolbox/      Python (uv, FastAPI): yt-dlp, mutagen, fpcalc, rsgain — stateless, no database
docker/                Dockerfiles
scripts/               root scripts, run by Bun, cross-platform
```

## Commands

Everything runs from the repository root with Bun. There is no `make`.

| Command                               | What it does                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `bun install`                         | install the workspace                                                            |
| `bun run dev`                         | this checkout's stack up, then the web app on `PORT` (default 3000)              |
| `bun run dev:portless`                | the same, behind `https://music-manager.localhost` — no port to remember         |
| `bun run stack:up` / `stack:down`     | only the containers **this checkout** owns (`compose:up`/`down` are aliases)     |
| `bun run stack:info`                  | print what this checkout resolves to: project, ports, database, library, URL     |
| `bun run check`                       | **the gate**: tsr generate, tsc, eslint, prettier, vitest, ruff, pyright, pytest |
| `bun run test`                        | vitest + pytest only                                                             |
| `bun run lint` / `bun run format`     | eslint / prettier --write                                                        |
| `bun run db:generate`                 | write a migration from the Drizzle schema                                        |
| `bun run db:migrate`                  | apply pending migrations                                                         |
| `bun run db:reset`                    | drop and recreate schema `public`, then migrate                                  |
| `bun run toolbox:openapi`             | regenerate `packages/contracts/toolbox/` from the FastAPI app                    |
| `bun run worker`                      | the job orchestrator (pg-boss): steps, the single download slot, cron            |
| `bun run mm -- <cmd>`                 | the CLI: `import`, `jobs`, `job`, `retry`, `inbox`, `settings`                   |
| `bun run e2e-fixture`                 | the offline vertical slice, end to end (CLI, worker, toolbox — no browser)       |
| `bun run e2e`                         | the Console's Playwright tests: brings up its own app, worker and database       |
| `bun run e2e-migrate`                 | the v1 take-over: a fixture v1 installation, dry run then real run               |
| `bun run e2e-verify`                  | the Navidrome read-back, against a real Navidrome container                      |
| `bun run e2e:all`                     | **all four of the above**, cheapest first; `--only fixture,web` for a subset     |
| `bun run compose:up` / `compose:down` | aliases of `stack:up` / `stack:down`                                             |

`bun run check` must be green at the end of every phase, and `bun run e2e:all` — the four
end-to-end runs — with it. `check` is the fast gate (types, lint, unit tests, no browser);
`e2e:all` is the slow one, and it is the half that catches a pipeline that stopped working.
**Both want this checkout's toolbox up in fixtures mode first:**
`MM_TOOLBOX_FIXTURES=1 bun run stack:up`. `check` runs without it — the integration tests say
so and skip themselves — but a toolbox that answers _in real mode_ fails them, which is the one
state that looks like a regression and is not.

All four runners, and `check`'s vitest step, resolve the checkout they are in
(`scripts/e2e-checkout.ts`, `devEnv()`): their own database, their own toolbox port, their own
library subdirectory, and `-p` on every `docker compose` call. Running them from a worktree is
therefore safe, and running two of them at once is too. Before that resolution existed, `check`
from a worktree fell back to `localhost:5432/mm` and `localhost:8100` — the owner's postgres and
the owner's toolbox.

## Conventions

- **TypeScript strict**, ESM, `noUncheckedIndexedAccess`. No unjustified `any` (eslint errors
  on it). Prefer `import type`.
- **zod at every boundary**: HTTP, CLI, MCP, settings, environment. Parse, do not cast.
- **Typed errors** (`MMError` with `code`, `hint`, `action`) on both sides of the TS↔Python
  bridge, using the same codes as the error decoder.
- **Tailwind tokens only.** The Console palette is defined once in `apps/web/src/styles.css`
  as `@theme` variables. Use `bg-surface-2`, `text-fg-2`, `border-line`, `text-ok`,
  `bg-warn-soft`, `bg-primary`… **Arbitrary values (`bg-[#151920]`, `text-[13px]`) are
  forbidden.** If a value is missing, add a token.
  Note that shadcn's `accent` is the _hover surface_; the Console amber is `primary`.
- **Shared components.** A component used twice belongs in `apps/web/src/components/`.
  Add shadcn components with `bunx shadcn@latest add <name>` rather than by hand.
- **No network in unit tests.** Ever. Use recorded fixtures, cassettes and golden files.
- **Fixtures mode** (`MM_FIXTURES=1`, `MM_TOOLBOX_FIXTURES=1`) must stay fully offline: it is
  what the E2E tests and the demo run on. Bring the stack up in that mode with the overlay:
  `docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox`.
- **The library is named twice**, because the orchestrator and the toolbox see the same
  directory through different paths: `MM_LIBRARY_ROOT` (this process) and
  `MM_TOOLBOX_LIBRARY_ROOT` (inside the container). Every path crossing the bridge is
  translated between them by `apps/web/src/server/paths.ts`, and every path stored in a row is
  library-relative with forward slashes. Downloads land in `<library>/.mm-work/<import>/`,
  which is inside the same mount — so `place` is a rename, hence genuinely atomic — and
  dot-prefixed, so Navidrome's scanner ignores it.
- **One orchestrator.** `docs/06-stack.md` fixes the concurrency at one: a single `download`
  queue (pg-boss `singleton`, one consumer) and a toolbox that answers `409 LOCKED` to a
  second caller. The worker clears its own queues on startup on that basis.
- **The tag map in `packages/domain` is the only source of tag names.** The toolbox receives
  already-projected key/value pairs; it knows nothing about MusicBrainz.
- **Drizzle is the sole owner of the schema.** Python never touches the database, and Better
  Auth's four tables are hand-written in `src/server/db/schema/auth.ts` rather than generated
  into a second schema file. `advanced.database.validateSchema` re-checks them at boot, so a
  drift from the library is a startup error rather than a 500 later.
- **One account.** The Console has a single administrator, created once from `MM_ADMIN_EMAIL` /
  `MM_ADMIN_PASSWORD` or from `/setup` while the `user` table is empty. Public sign-up is off.
  Every route and every server function requires a session except `/health` and `/api/auth/*`;
  `apps/web/src/server/functions/functions.guard.test.ts` is what keeps that true.
- Python: `ruff`, `pyright` strict, `pydantic` v2, `structlog` for JSON logs.
- **Commits follow the Angular convention**: `type(scope): subject` (`feat`, `fix`, `chore`,
  `docs`, `test`, `refactor`…), scope is the phase (`feat(P03): …`), body explains the why
  when it's not obvious. One branch per phase (`phase/PNN-nom`); squashing is not required.
- **Browser-driven tests use only the `agent-browser` CLI** installed on the machine
  (`agent-browser open/snapshot/click/fill/screenshot…`). **Never** use an agent's built-in
  browser tool or an MCP browser/navigation tool for these — an agent doing so is a mistake,
  not a valid alternative. `@playwright/test` is for non-regression scenarios only, reusing
  the Chromium already in the cache (`executablePath`, resolved by `apps/web/e2e/chromium.ts`;
  `MM_E2E_CHROMIUM` overrides it), never a separate Playwright browser install — do **not**
  run `playwright install`. Two host quirks are handled there and worth knowing: the
  `chromium_headless_shell` build hangs on launch, so the full `chrome-win64/chrome.exe` of the
  same revision is used with `--no-sandbox`; and **Playwright runs under Node, not Bun**,
  because it drives Chromium over file descriptors 3 and 4 that Bun does not pass through.
  `bun run e2e` is still the entry point; it shells out to `node` for that one step.
- **Server functions declare `createServerFn` literally.** The Vite plugin recognises
  `createServerFn(...).handler(...)` syntactically in order to replace the handler with an RPC
  stub in the browser bundle. A helper that returns a pre-configured builder defeats it and
  ships Drizzle, `postgres` and Better Auth to the client; so does any **non-handler export**
  from a server-function module. See `apps/web/src/server/functions/base.ts`.
  `apps/web/src/client-boundary.guard.test.ts` enforces the boundary: a file that reaches the
  browser may value-import `#/server/**` only as a `createServerFn` export from
  `server/functions/**`, or from a module the test can _prove_ imports nothing impure. That is
  why the pipeline vocabularies live in `server/db/schema/enums.vocab.ts` (no imports) while the
  `pgEnum` wrappers stay in `enums.ts` — the Console needs `STEPS` as a value, and it should not
  cost the visitor `drizzle-orm/pg-core`. Prefer `import type` and the split will not bite.
- **`bun run dev` runs SSR under Node, not Bun.** `vite dev` is a `#!/usr/bin/env node` bin, so
  the dev server — and every SSR render inside it — has no `Bun` global, whatever launched it.
  Server code must therefore use `node:crypto`, `node:fs` and friends rather than `Bun.*`;
  `Bun.*` is fine in `scripts/**`, which really does run under Bun. Getting this wrong fails far
  from its cause: `authSecret` called `Bun.CryptoHasher`, threw during SSR, and the router
  serialised the dead match into the HTML so the browser showed _“Something went wrong! Bun is
  not defined”_ — which reads exactly like a client bundle leak and is not one. It only fired
  with an empty `MM_AUTH_SECRET`, so the fixtures E2E (which sets one) never saw it. The
  `runtime portability` block of `client-boundary.guard.test.ts` now fails on any new `Bun.`.

### Ports and `.env`

- **The dev port is `PORT`, default 3000.** `PORT=3100 bun run dev` is the normal way to get a
  server of your own; `:3000` is routinely taken on this machine. Setting `PORT` also turns on
  Vite's `strictPort`, so a busy port is an error instead of a silent slide to 3001.
- **A port change is also an `MM_WEB_URL` change.** Better Auth checks the browser's origin
  against `MM_WEB_URL`, which defaults to `http://localhost:3000`, so an app moved to another
  port serves a perfect login form that answers **“Invalid origin”** on submit. `bun run dev`
  derives `MM_WEB_URL` from `PORT` for you; if you launch Vite yourself, set it yourself. An
  explicit value always wins — that is the reverse-proxy case.
- **`bun run --cwd apps/web dev` does not load `v2/.env`.** Bun reads `.env` from the current
  directory, and `--cwd` makes that `apps/web`, which has none — so the app comes up with no
  `DATABASE_URL` and no keys, looking misconfigured rather than mis-launched. `bun run dev`
  reads `v2/.env` and hands it to the child explicitly (`scripts/dev.ts`). To run the app alone,
  export the variables first:

  ```bash
  set -a; . ./.env; set +a          # from v2/
  PORT=3100 MM_WEB_URL=http://localhost:3100 bun run --cwd apps/web dev
  ```

### portless — a name instead of a port

[portless](https://portless.sh/) is installed on this machine. It runs a local HTTPS proxy and
gives the command it launches an ephemeral `PORT` plus a `PORTLESS_URL`:

```bash
bun run dev:portless              # from v2/       → https://music-manager.localhost
bun run dev:portless              # from a worktree → https://music-manager-<slug>.localhost
```

- **The app name is derived, never typed.** `scripts/checkout.ts` owns it: `music-manager` in
  `v2/`, `music-manager-<slug>` in a worktree. Same URL every time the same checkout starts.
- **`MM_WEB_URL` follows `PORTLESS_URL`**, so Better Auth's origin check passes. Forget that
  and you get a login form that renders perfectly and answers **"Invalid origin"** on submit —
  the same trap as a port change, one origin further away.
- **Cookies stop colliding.** `http://localhost:3100` and `http://localhost:3101` are _one_
  origin as far as cookies and `localStorage` are concerned, so two agents' sessions overwrite
  each other. Two `.localhost` names are two origins.
- The certificate is portless's own CA, already in the OS trust store (`portless doctor`).
  `curl` needs `--cacert %USERPROFILE%\.portless\ca.pem` or, in a hurry, `-k`.
- `PORTLESS=0 bun run dev` and plain `bun run dev` still work on a bare port; nothing depends
  on the proxy. `portless list` shows who holds what, `portless prune` clears crashed sessions.

## Worktrees

**Every dev task happens in a `git worktree`, never in `v2/` itself.** The owner keeps `v2/` to
test main while an agent builds elsewhere. A worktree is a full, isolated stack.

```bash
# from v2/
git worktree add ../v2-wt-<slug> -b phase/PNN-<nom>
cd ../v2-wt-<slug>
bun install                 # a worktree has no node_modules of its own
bun run stack:info          # read it: project, ports, database, library, URL
bun run dev:portless        # or: bun run dev
bun run dev:worker          # `bun run worker`, same environment (second terminal)
```

`scripts/checkout.ts` derives everything from the directory you are in, and `scripts/stack.ts`
is the only thing that talks to compose:

|                 | `v2/` (primary)                   | `../v2-wt-<slug>`                                        |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| compose project | `mm-dev`                          | `mm-<slug>`                                              |
| containers      | postgres, navidrome, toolbox      | **toolbox only** (`--navidrome` adds one)                |
| toolbox         | `:8100`                           | a stable port in 8200–8899                               |
| database        | the one in `.env`                 | `mm_<slug>`, same postgres, created and migrated for you |
| library         | `v2/.local/library`               | `<worktree>/.local/library`                              |
| URL             | `https://music-manager.localhost` | `https://music-manager-<slug>.localhost`                 |

- **`.env` is the owner's, and it stays there.** It is gitignored, so a worktree has none. The
  scripts read `v2/.env` through `git rev-parse --git-common-dir` and then override
  `DATABASE_URL`, `MM_TOOLBOX_URL` and `MM_LIBRARY_ROOT` for the worktree. Drop a `.env` in the
  worktree only to _override_ a key; it is merged on top, and any key you set there (or export
  in the shell) is left alone — that is the escape hatch, and also the way to point a worktree
  at the shared library on purpose.
- **Postgres is shared on purpose.** One server, one database per checkout. A second postgres
  would cost a gigabyte to hold a few megabytes; a database is free.

### What you must never do from a worktree

- **Never run `docker compose` by hand, and never without `-p`.** `docker-compose.dev.yml`
  declares `name: mm-dev` and bind-mounts `./.local/library`, relative to _your_ copy of the
  file. `docker compose -f docker-compose.dev.yml up -d` from a worktree therefore finds the
  shared `mm-dev-toolbox-1` **by name** and recreates it mounting _your_ library — the owner's
  library silently disappears from under him. That happened during P07-verify-1
  (`../orchestration/reports/P07-verify-1.md` §9). Use `bun run stack:up` / `stack:down`, which
  always pass `-p`, and check with:

  ```bash
  docker inspect mm-dev-toolbox-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
  # must still say  …\v2\.local\library -> /library
  ```

- **Never `docker compose down` the `mm-dev` project**, never restart `mm-dev-*`, never stop the
  owner's dev server or worker. `bun run stack:down` from your worktree stops only `mm-<slug>`.
- **Never `bun run db:reset`, `db:migrate` or `mm` with an inherited `DATABASE_URL`.** Go
  through the package scripts; they resolve the checkout. `bun run stack:info` tells you which
  database you are about to touch — read it before anything destructive.
- Never delete `.local/` in `v2/`. Yours is `<worktree>/.local/`.
- **Never drop a database, remove a container, an image or a worktree by pattern** (`LIKE
'mm_%'`, `docker ps -q --filter name=mm-`, `psql -c "select datname ... where datname like"`).
  Other agents run their own isolated stacks at the same time with names from the same family.
  Delete only the exact names you created, as printed by `bun run stack:info`. That rule exists
  because P08-P11-verify-1 dropped `mm_web_e2e_<pid>` from under a running Playwright suite of
  another agent (`../orchestration/reports/P08-P11-verify-1.md` §8).

### Cleaning up

```bash
bun run stack:down                              # from the worktree: only mm-<slug>
psql "<admin-url>" -c 'drop database mm_<slug>' # or leave it; it is small
cd ../v2 && git worktree remove ../v2-wt-<slug> --force
docker image rm mm-<slug>-toolbox               # the per-project toolbox image
```

## Toolbox

`services/toolbox/` is a stateless FastAPI service around yt-dlp, mutagen, fpcalc, rsgain,
Pillow and ytmusicapi. It has no database, no business logic and no memory between requests
except one thing: **the single download slot**.

| Route                            | What it does                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health`                    | versions of the four binaries, fixtures mode, whether a download is running                      |
| `POST /extract`                  | resolve a URL to entries, no download                                                            |
| `POST /download`                 | NDJSON `progress` / `postprocess` / `done` / `error`; **409 `LOCKED`** if one is already running |
| `POST /probe`                    | ffprobe, including every tag present                                                             |
| `POST /fingerprint`              | fpcalc, plus AcoustID when a key is given                                                        |
| `POST /tag`                      | mutagen write + readback, pictures, `.lrc` sidecar                                               |
| `POST /replaygain`               | rsgain scan, writes `REPLAYGAIN_*` and `R128_*` (Opus)                                           |
| `POST /place`                    | atomic move into the library                                                                     |
| `POST /artwork/prepare`          | crop to square, resize, JPEG                                                                     |
| `POST /ytmusic/search`           | YouTube Music album playlists (`OLAK5uy_…`)                                                      |
| `POST /ytdlp/update` `/selftest` | keep the downloader alive, structured results                                                    |
| `POST /cookies/test`             | parse a `cookies.txt` offline and say if it is a usable session                                  |

- **Tag keys are canonical (Vorbis) names.** `packages/domain` owns the names and hands over
  a flat `[{key, value}]` list; the toolbox owns the _encoding_ — which ID3v2.4 frame, which
  MP4 atom, `TIPL`/`TMCL`/`UFID`/`SYLT`, `METADATA_BLOCK_PICTURE`, `----:com.apple.iTunes:*`.
  A field the target format has no slot for (the `—` cells of `docs/03-metadonnees.md` §2) is
  dropped rather than invented; `R128_*` is written on Opus only.
- **Errors** are `{code, message, hint, action}` from `errors.py`, on HTTP bodies and inside
  NDJSON `error` events alike. The codes and hints are the Console's error decoder.
- **Fixtures mode** (`MM_TOOLBOX_FIXTURES=1`) answers every endpoint from
  `src/toolbox/fixtures/data/`: `fixture://discovery` (15 videos for 14 tracks),
  `fixture://skinny-love`, `fixture://currents`, and `fixture://discovery?fp=mismatch` for a
  fingerprint disagreement. `#n` selects one entry. `/download` copies a bundled five-second
  Opus sample; `MM_TOOLBOX_FIXTURE_DELAY_MS` paces it.
- **Environment**: `MM_TOOLBOX_TOKEN` (bearer, empty = off), `MM_TOOLBOX_FIXTURES`,
  `MM_YTDLP_AUTOUPDATE`, `MM_ACOUSTID_KEY`, `MM_LIBRARY_ROOT`, `MM_TOOLBOX_FIXTURE_DELAY_MS`.
- **Tests**: `uv run pytest` is offline and needs no binaries — the ones that do skip
  themselves. `pytest -m conformance` needs `docker compose up -d navidrome` and is the
  proof that what we write is what Navidrome reads (`docs/03-metadonnees.md` §7).

## Machine setup

- **Bun** is the runtime and package manager for all TypeScript. Node is not required.
- **uv** manages the toolbox's Python 3.13. On Windows it is often installed to
  `%USERPROFILE%\.local\bin\uv.exe` **without being on PATH** — the root scripts resolve it
  via `resolveUv()` in `scripts/lib.ts` (PATH first, then that path). Call it the same way
  if you shell out by hand:
  `"$HOME/.local/bin/uv.exe" run pytest` from `services/toolbox`.
- **Docker Desktop must be running** before `bun run dev`, `bun run check`'s integration
  parts, or any `docker compose` command. Start it from the Start menu, or:
  `Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"`, then poll
  `docker info` until it answers — it takes up to a minute. `bun run dev` fails with a clear
  message if the daemon is down.
- `.local/` holds all mutable state (Navidrome's database, the music library bind mount). It
  is gitignored and safe to delete. Postgres uses a named volume.
- Media binaries (`ffmpeg`, `fpcalc`, `rsgain`, `yt-dlp`) are **not required on the host** —
  they live in the toolbox image. `GET localhost:8100/health` reports their versions, and a
  `null` there means the image is broken.
- **Never terminate processes by name or command-line pattern; only by a PID you spawned
  yourself.** Several agents run on this machine at once, each with its own dev server, and a
  filter like `CommandLine -like '*index.ts*'` matches all of them — an agent doing this once
  killed another agent's `bun run --hot src/index.ts` on the mistaken belief it owned `:3000`
  (`orchestration/reports/P06-build-1.md`). It happened again in P07: `Get-CimInstance
Win32_Process | Where-Object { $_.CommandLine -like '*worker*index.ts*' } | taskkill` killed
  a sibling agent's `bun run scripts/e2e-web.ts` worker mid-suite
  (`orchestration/reports/P07a-build-1.md`, opening incident). Both times the tool was a
  pattern match across _all_ processes on the machine, run because it was faster than tracking
  a PID — it is not: list a process tree from a PID you started, verify it, and only then kill
  that tree.

  **Bun**, from a handle you hold (`Bun.spawn`'s return value has `.pid`):

  ```ts
  const proc = Bun.spawn(["bun", "run", "worker/index.ts"], { ... });
  // ... later, to stop only this tree:
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
  } else {
    proc.kill(9); // Bun.spawn already tracks and reaps the child; no pattern match involved.
  }
  ```

  **PowerShell**, when the handle is gone (a previous run, a different shell) and only the PID
  is known — verify the tree belongs to you _before_ killing it, in two separate steps, never
  one that both finds and kills:

  ```powershell
  # 1. Verify: what is this PID, and what did it spawn?
  Get-CimInstance Win32_Process -Filter "ProcessId = $pid"
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $pid"   # its children, same way

  # 2. Only then, kill that one tree by PID — never by -Filter "CommandLine -like …" or
  #    Stop-Process -Name, both of which match every process on the machine that looks similar,
  #    not just yours.
  taskkill /PID $pid /T /F
  ```

  Use `PORT=3100+` (or a script's own dedicated port, e.g. `bun run e2e`'s default is chosen
  freely by the OS, never `:3170` or `:3000` fixed) for ad hoc dev servers so a fixed port is
  never the thing two agents fight over.

## Generated files — never edit by hand

- `apps/web/src/routeTree.gen.ts` — gitignored, produced by `tsr generate` / the Vite plugin.
- `apps/web/drizzle/**` — migrations, produced by `bun run db:generate` and committed.
- `packages/contracts/toolbox/**` — produced by `bun run toolbox:openapi` and committed.
  Running it twice must leave the working tree clean.
