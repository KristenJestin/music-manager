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
| `bun run dev`                         | compose up, wait for postgres, then the web app on <http://localhost:3000>       |
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
| `bun run compose:up` / `compose:down` | the dev stack alone                                                              |

`bun run check` must be green at the end of every phase, and the previous phases' fixture E2E
must still pass.

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
