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
  src/server/          server-only code: env, db, services
  src/components/ui/   shadcn/ui components (Base UI) — do not hand-edit, re-add with the CLI
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
| `bun run e2e`                         | placeholder until P03                                                            |
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
  what the E2E tests and the demo run on.
- **The tag map in `packages/domain` is the only source of tag names.** The toolbox receives
  already-projected key/value pairs; it knows nothing about MusicBrainz.
- **Drizzle is the sole owner of the schema.** Python never touches the database.
- Python: `ruff`, `pyright` strict, `pydantic` v2, `structlog` for JSON logs.
- **Commits follow the Angular convention**: `type(scope): subject` (`feat`, `fix`, `chore`,
  `docs`, `test`, `refactor`…), scope is the phase (`feat(P03): …`), body explains the why
  when it's not obvious. One branch per phase (`phase/PNN-nom`); squashing is not required.
- **Browser-driven tests use only the `agent-browser` CLI** installed on the machine
  (`agent-browser open/snapshot/click/fill/screenshot…`). **Never** use an agent's built-in
  browser tool or an MCP browser/navigation tool for these — an agent doing so is a mistake,
  not a valid alternative. `@playwright/test` is for non-regression scenarios only, reusing
  the same Chromium `agent-browser` already has installed (`executablePath`), never a
  separate Playwright browser install.

## Toolbox

`services/toolbox/` is a stateless FastAPI service around yt-dlp, mutagen, fpcalc, rsgain,
Pillow and ytmusicapi. It has no database, no business logic and no memory between requests
except one thing: **the single download slot**.

| Route                              | What it does                                                             |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `GET /health`                      | versions of the four binaries, fixtures mode, whether a download is running |
| `POST /extract`                    | resolve a URL to entries, no download                                    |
| `POST /download`                   | NDJSON `progress` / `postprocess` / `done` / `error`; **409 `LOCKED`** if one is already running |
| `POST /probe`                      | ffprobe, including every tag present                                     |
| `POST /fingerprint`                | fpcalc, plus AcoustID when a key is given                                |
| `POST /tag`                        | mutagen write + readback, pictures, `.lrc` sidecar                       |
| `POST /replaygain`                 | rsgain scan, writes `REPLAYGAIN_*` and `R128_*` (Opus)                   |
| `POST /place`                      | atomic move into the library                                             |
| `POST /artwork/prepare`            | crop to square, resize, JPEG                                             |
| `POST /ytmusic/search`             | YouTube Music album playlists (`OLAK5uy_…`)                              |
| `POST /ytdlp/update` `/selftest`   | keep the downloader alive, structured results                            |
| `POST /cookies/test`               | parse a `cookies.txt` offline and say if it is a usable session          |

- **Tag keys are canonical (Vorbis) names.** `packages/domain` owns the names and hands over
  a flat `[{key, value}]` list; the toolbox owns the *encoding* — which ID3v2.4 frame, which
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

## Generated files — never edit by hand

- `apps/web/src/routeTree.gen.ts` — gitignored, produced by `tsr generate` / the Vite plugin.
- `apps/web/drizzle/**` — migrations, produced by `bun run db:generate` and committed.
- `packages/contracts/toolbox/**` — produced by `bun run toolbox:openapi` and committed.
  Running it twice must leave the working tree clean.
