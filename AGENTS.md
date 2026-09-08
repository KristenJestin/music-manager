# AGENTS.md

Instructions for coding agents and humans working in this repository. `README.md` is the
introduction for someone discovering the project; this file is the working manual.

## Project overview

A self-hosted music importer and tagger. You paste a YouTube URL; the app matches it against
MusicBrainz, downloads audio, writes the fullest possible set of standard tags, and files the
result into a library that Navidrome, Feishin and Symfonium read.

Two guiding facts:

- The database is the source of truth for metadata, with provenance per field. Files are a
  regenerable projection of it.
- Objective number one is the maximum of valid tags per track, written to the standard superset
  (the Picard table) and not to one server's dialect.

The functional specification and the development plan are maintained outside this repository, and
they are authoritative when they disagree with a comment here. This repository holds code, tests,
configuration and operations documentation. Nothing else belongs in it: no notes, no screenshots,
no scratch files, no agent reports. Those go wherever the specification lives.

Operations documentation in `docs/` is written in French. Code, identifiers, the UI and commit
messages are in English.

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
docs/                  operations documentation (deployment, v1 migration)
scripts/               root scripts, run by Bun, cross-platform
```

## Setup

- Bun is the runtime and package manager for all TypeScript. Node is not required as a separate
  install, though a few steps shell out to it (see below).
- uv manages the toolbox's Python 3.13. On Windows it is often installed to
  `%USERPROFILE%\.local\bin\uv.exe` without being on `PATH`; the root scripts resolve it through
  `resolveUv()` in `scripts/lib.ts` (`PATH` first, then that location). Call it the same way if you
  shell out by hand: `"$HOME/.local/bin/uv.exe" run pytest` from `services/toolbox`.
- Docker must be running before `bun run dev`, before `bun run check`'s integration parts, and
  before any `docker compose` command. `bun run dev` fails with a clear message when the daemon is
  down.
- `.local/` holds mutable state (Navidrome's database, the music library bind mount). It is
  gitignored and safe to delete. Postgres uses a named volume.
- Media binaries (`ffmpeg`, `fpcalc`, `rsgain`, `yt-dlp`) are not required on the host. They live in
  the toolbox image. `GET <toolbox>/health` reports their versions, and a `null` there means the
  image is broken.

```bash
bun install
cp .env.example .env
bun run stack:up
bun run dev
bun run worker      # second terminal
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

## Testing

`bun run check` must be green at the end of every task, and `bun run e2e:all` with it. `check` is
the fast gate (types, lint, unit tests, no browser); `e2e:all` is the slow one, and it is the half
that catches a pipeline that stopped working.

Both want this checkout's toolbox up in fixtures mode first:
`MM_TOOLBOX_FIXTURES=1 bun run stack:up`. `check` runs without it, because the integration tests
say so and skip themselves, but a toolbox answering _in real mode_ fails them. That is the one
state that looks like a regression and is not.

All four runners, and `check`'s vitest step, resolve the checkout they are in
(`scripts/e2e-checkout.ts`, `devEnv()`): their own database, their own toolbox port, their own
library subdirectory, and `-p` on every `docker compose` call. Running them from a worktree is
therefore safe, and running two of them at once is too.

- No network in unit tests. Ever. Use recorded fixtures, cassettes and golden files.
- Fixtures mode (`MM_FIXTURES=1`, `MM_TOOLBOX_FIXTURES=1`) must stay fully offline: it is what the
  E2E tests and the demo run on. Bring the stack up in that mode with the overlay:
  `docker compose -f docker-compose.dev.yml -f docker-compose.fixtures.yml up -d postgres toolbox`.
- Browser-driven exploration uses only the `agent-browser` CLI
  (`agent-browser open/snapshot/click/fill/screenshot…`). **Never** use an agent's built-in browser
  tool or an MCP browser/navigation tool for these. An agent doing so is making a mistake, not
  choosing a valid alternative.
- `@playwright/test` is for non-regression scenarios only, reusing the Chromium already in the
  cache (`executablePath`, resolved by `apps/web/e2e/chromium.ts`; `MM_E2E_CHROMIUM` overrides it),
  never a separate Playwright browser install. Do **not** run `playwright install`. Two quirks are
  handled there and worth knowing: the `chromium_headless_shell` build hangs on launch, so the full
  `chrome-win64/chrome.exe` of the same revision is used with `--no-sandbox`; and Playwright runs
  under Node, not Bun, because it drives Chromium over file descriptors 3 and 4 that Bun does not
  pass through. `bun run e2e` is still the entry point; it shells out to `node` for that one step.

## Code style and conventions

- TypeScript strict, ESM, `noUncheckedIndexedAccess`. No unjustified `any` (eslint errors on it).
  Prefer `import type`.
- zod at every boundary: HTTP, CLI, MCP, settings, environment. Parse, do not cast.
- Typed errors (`MMError` with `code`, `hint`, `action`) on both sides of the TypeScript to Python
  bridge, using the same codes as the error decoder.
- **Tailwind tokens only.** The Console palette is defined once in `apps/web/src/styles.css` as
  `@theme` variables. Use `bg-surface-2`, `text-fg-2`, `border-line`, `text-ok`, `bg-warn-soft`,
  `bg-primary`… Arbitrary values (`bg-[#151920]`, `text-[13px]`) are forbidden. If a value is
  missing, add a token. Note that shadcn's `accent` is the _hover surface_; the Console amber is
  `primary`.
- **Shared components.** A component used twice belongs in `apps/web/src/components/`. Add shadcn
  components with `bunx shadcn@latest add <name>` rather than by hand.
- The library is named twice, because the orchestrator and the toolbox see the same directory
  through different paths: `MM_LIBRARY_ROOT` (this process) and `MM_TOOLBOX_LIBRARY_ROOT` (inside
  the container). Every path crossing the bridge is translated between them by
  `apps/web/src/server/paths.ts`, and every path stored in a row is library-relative with forward
  slashes. Downloads land in `<library>/.mm-work/<import>/`, inside the same mount, so `place` is a
  rename and genuinely atomic. The dot prefix keeps Navidrome's scanner out of it.
- **One orchestrator.** Concurrency is fixed at one: a single `download` queue (pg-boss
  `singleton`, one consumer) and a toolbox that answers `409 LOCKED` to a second caller. The worker
  clears its own queues on startup on that basis.
- The tag map in `packages/domain` is the only source of tag names. The toolbox receives
  already-projected key/value pairs; it knows nothing about MusicBrainz.
- **Drizzle is the sole owner of the schema.** Python never touches the database, and Better Auth's
  four tables are hand-written in `src/server/db/schema/auth.ts` rather than generated into a second
  schema file. `advanced.database.validateSchema` re-checks them at boot, so a drift from the
  library is a startup error instead of a 500 later.
- **One account.** The Console has a single administrator, created once from `MM_ADMIN_EMAIL` and
  `MM_ADMIN_PASSWORD`, or from `/setup` while the `user` table is empty. Public sign-up is off.
  Every route and every server function requires a session except `/health` and `/api/auth/*`;
  `apps/web/src/server/functions/functions.guard.test.ts` is what keeps that true.
- Python: `ruff`, `pyright` strict, `pydantic` v2, `structlog` for JSON logs.
- **Server functions declare `createServerFn` literally.** The Vite plugin recognises
  `createServerFn(...).handler(...)` syntactically in order to replace the handler with an RPC stub
  in the browser bundle. A helper that returns a pre-configured builder defeats it and ships
  Drizzle, `postgres` and Better Auth to the client; so does any non-handler export from a
  server-function module. See `apps/web/src/server/functions/base.ts`.
  `apps/web/src/client-boundary.guard.test.ts` enforces the boundary: a file that reaches the
  browser may value-import `#/server/**` only as a `createServerFn` export from
  `server/functions/**`, or from a module the test can _prove_ imports nothing impure. That is why
  the pipeline vocabularies live in `server/db/schema/enums.vocab.ts` (no imports) while the
  `pgEnum` wrappers stay in `enums.ts`: the Console needs `STEPS` as a value, and it should not cost
  the visitor `drizzle-orm/pg-core`. Prefer `import type` and the split will not bite.
- **`bun run dev` runs SSR under Node, not Bun.** `vite dev` is a `#!/usr/bin/env node` bin, so the
  dev server, and every SSR render inside it, has no `Bun` global whatever launched it. Server code
  must therefore use `node:crypto`, `node:fs` and friends rather than `Bun.*`. `Bun.*` is fine in
  `scripts/**`, which really does run under Bun. Getting this wrong fails far from its cause:
  `authSecret` once called `Bun.CryptoHasher`, threw during SSR, and the router serialised the dead
  match into the HTML, so the browser showed _"Something went wrong! Bun is not defined"_. That
  reads exactly like a client bundle leak and is not one, and it only fired with an empty
  `MM_AUTH_SECRET`, so the fixtures E2E never saw it. The `runtime portability` block of
  `client-boundary.guard.test.ts` now fails on any new `Bun.`.

### Ports and `.env`

- The dev port is `PORT`, default 3000. `PORT=3100 bun run dev` is the normal way to get a server of
  your own when several are running side by side. Setting `PORT` also turns on Vite's `strictPort`,
  so a busy port is an error instead of a silent slide to 3001.
- A port change is also an `MM_WEB_URL` change. Better Auth checks the browser's origin against
  `MM_WEB_URL`, which defaults to `http://localhost:3000`, so an app moved to another port serves a
  perfect login form that answers "Invalid origin" on submit. `bun run dev` derives `MM_WEB_URL`
  from `PORT` for you; if you launch Vite yourself, set it yourself. An explicit value always wins,
  which is the reverse-proxy case.
- `bun run --cwd apps/web dev` does not load the root `.env`. Bun reads `.env` from the current
  directory, and `--cwd` makes that `apps/web`, which has none, so the app comes up with no
  `DATABASE_URL` and no keys, looking misconfigured rather than mis-launched. `bun run dev` reads
  the root `.env` and hands it to the child explicitly (`scripts/dev.ts`). To run the app alone,
  export the variables first:

  ```bash
  set -a; . ./.env; set +a          # from the repository root
  PORT=3100 MM_WEB_URL=http://localhost:3100 bun run --cwd apps/web dev
  ```

### portless, a name instead of a port

[portless](https://portless.sh/) is optional. When installed, it runs a local HTTPS proxy and gives
the command it launches an ephemeral `PORT` plus a `PORTLESS_URL`:

```bash
bun run dev:portless              # from the main checkout → https://music-manager.localhost
bun run dev:portless              # from a worktree        → https://music-manager-<slug>.localhost
```

- The app name is derived, never typed. `scripts/checkout.ts` owns it: `music-manager` in the main
  checkout, `music-manager-<slug>` in a worktree. Same URL every time the same checkout starts.
- `MM_WEB_URL` follows `PORTLESS_URL`, so Better Auth's origin check passes. Forget that and you get
  a login form that renders perfectly and answers "Invalid origin" on submit, the same trap as a
  port change one origin further away.
- Cookies stop colliding. `http://localhost:3100` and `http://localhost:3101` are _one_ origin as
  far as cookies and `localStorage` are concerned, so two agents' sessions overwrite each other. Two
  `.localhost` names are two origins.
- The certificate comes from portless's own CA, which its installer puts in the OS trust store
  (`portless doctor`). `curl` needs `--cacert` pointed at that CA, or `-k` in a hurry.
- `PORTLESS=0 bun run dev` and plain `bun run dev` still work on a bare port; nothing depends on the
  proxy. `portless list` shows who holds what, `portless prune` clears crashed sessions.

## Worktrees

**Every dev task happens in a `git worktree`, never in the main checkout.** That keeps the main
checkout free to test `main` while an agent builds elsewhere. A worktree is a full, isolated stack.

```bash
git worktree add ../mm-wt-<slug> -b feat/<slug>
cd ../mm-wt-<slug>
bun install                 # a worktree has no node_modules of its own
bun run stack:info          # read it: project, ports, database, library, URL
bun run dev:portless        # or: bun run dev
bun run dev:worker          # `bun run worker`, same environment (second terminal)
```

`scripts/checkout.ts` derives everything from the directory you are in, and `scripts/stack.ts` is
the only thing that talks to compose:

|                 | main checkout                     | worktree                                                 |
| --------------- | --------------------------------- | -------------------------------------------------------- |
| compose project | `mm-dev`                          | `mm-<slug>`                                              |
| containers      | postgres, navidrome, toolbox      | **toolbox only** (`--navidrome` adds one)                |
| toolbox         | `:8100`                           | a stable port in 8200–8899                               |
| database        | the one in `.env`                 | `mm_<slug>`, same postgres, created and migrated for you |
| library         | `<main>/.local/library`           | `<worktree>/.local/library`                              |
| URL             | `https://music-manager.localhost` | `https://music-manager-<slug>.localhost`                 |

- `.env` belongs to the main checkout and stays there. It is gitignored, so a worktree has none. The
  scripts read it through `git rev-parse --git-common-dir` and then override `DATABASE_URL`,
  `MM_TOOLBOX_URL` and `MM_LIBRARY_ROOT` for the worktree. Drop a `.env` in the worktree only to
  _override_ a key; it is merged on top, and any key you set there (or export in the shell) is left
  alone. That is the escape hatch, and also the way to point a worktree at the shared library on
  purpose.
- Postgres is shared on purpose. One server, one database per checkout. A second postgres would cost
  a gigabyte to hold a few megabytes; a database is free.

### What you must never do from a worktree

- **Never run `docker compose` by hand, and never without `-p`.** `docker-compose.dev.yml` declares
  `name: mm-dev` and bind-mounts `./.local/library`, relative to _your_ copy of the file.
  `docker compose -f docker-compose.dev.yml up -d` from a worktree therefore finds the shared
  `mm-dev-toolbox-1` **by name** and recreates it mounting _your_ library, so the main checkout's
  library silently disappears from under whoever was using it. This has already happened once. Use
  `bun run stack:up` / `stack:down`, which always pass `-p`, and check with:

  ```bash
  docker inspect mm-dev-toolbox-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
  # must still point at the main checkout's .local/library -> /library
  ```

- **Never `docker compose down` the `mm-dev` project**, never restart `mm-dev-*`, never stop someone
  else's dev server or worker. `bun run stack:down` from your worktree stops only `mm-<slug>`.
- **Never `bun run db:reset`, `db:migrate` or `mm` with an inherited `DATABASE_URL`.** Go through the
  package scripts; they resolve the checkout. `bun run stack:info` tells you which database you are
  about to touch, so read it before anything destructive. `scripts/db.ts` resolves the checkout
  itself and refuses a worktree pointed at anything but `mm_<slug>`; the hard-coded fallback that
  once wiped a shared database is gone. Do not reintroduce a default URL anywhere.
- Never delete the main checkout's `.local/`. Yours is `<worktree>/.local/`.
- **Never drop a database, remove a container, an image or a worktree by pattern** (`LIKE 'mm_%'`,
  `docker ps -q --filter name=mm-`, `psql -c "select datname ... where datname like"`). Other agents
  run their own isolated stacks at the same time with names from the same family. Delete only the
  exact names you created, as printed by `bun run stack:info`. That rule exists because a pattern
  delete once dropped `mm_web_e2e_<pid>` from under another agent's running Playwright suite.
- **Never terminate processes by name or command-line pattern; only by a PID you spawned yourself.**
  Several agents may run on one machine, each with its own dev server, and a filter like
  `CommandLine -like '*index.ts*'` matches all of them. This has killed sibling agents' processes
  twice, both times because a pattern match was faster than tracking a PID. It is not faster: list a
  process tree from a PID you started, verify it, and only then kill that tree.

  With Bun, from a handle you hold (`Bun.spawn`'s return value has `.pid`):

  ```ts
  const proc = Bun.spawn(["bun", "run", "worker/index.ts"], { ... });
  // ... later, to stop only this tree:
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(proc.pid), "/T", "/F"]);
  } else {
    proc.kill(9); // Bun.spawn already tracks and reaps the child; no pattern match involved.
  }
  ```

  With PowerShell, when the handle is gone (a previous run, a different shell) and only the PID is
  known, verify the tree belongs to you _before_ killing it, in two separate steps, never in one
  that both finds and kills:

  ```powershell
  # 1. Verify: what is this PID, and what did it spawn?
  Get-CimInstance Win32_Process -Filter "ProcessId = $target"
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $target"   # its children, same way

  # 2. Only then, kill that one tree by PID — never by -Filter "CommandLine -like …" or
  #    Stop-Process -Name, both of which match every similar-looking process on the machine.
  taskkill /PID $target /T /F
  ```

  Use `PORT=3100` and above, or a script's own dedicated port, for ad hoc dev servers, so a fixed
  port is never the thing two agents fight over.

### Cleaning up

```bash
bun run stack:down                              # from the worktree: only mm-<slug>
psql "<admin-url>" -c 'drop database mm_<slug>' # or leave it; it is small
cd ../<main> && git worktree remove ../mm-wt-<slug> --force
docker image rm mm-<slug>-toolbox               # the per-project toolbox image
```

## Toolbox

`services/toolbox/` is a stateless FastAPI service around yt-dlp, mutagen, fpcalc, rsgain, Pillow
and ytmusicapi. It has no database, no business logic and no memory between requests except one
thing: the single download slot.

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

- Tag keys are canonical (Vorbis) names. `packages/domain` owns the names and hands over a flat
  `[{key, value}]` list; the toolbox owns the _encoding_, meaning which ID3v2.4 frame, which MP4
  atom, `TIPL`/`TMCL`/`UFID`/`SYLT`, `METADATA_BLOCK_PICTURE`, `----:com.apple.iTunes:*`. A field the
  target format has no slot for is dropped rather than invented; `R128_*` is written on Opus only.
- Errors are `{code, message, hint, action}` from `errors.py`, on HTTP bodies and inside NDJSON
  `error` events alike. The codes and hints are the Console's error decoder.
- Fixtures mode (`MM_TOOLBOX_FIXTURES=1`) answers every endpoint from `src/toolbox/fixtures/data/`:
  `fixture://discovery` (15 videos for 14 tracks), `fixture://skinny-love`, `fixture://currents`,
  and `fixture://discovery?fp=mismatch` for a fingerprint disagreement. `#n` selects one entry.
  `/download` copies a bundled five-second Opus sample; `MM_TOOLBOX_FIXTURE_DELAY_MS` paces it,
  and `?slow=<ms>` (capped at 2 s a slice) paces one import only — that is how a browser test
  catches a track _while_ it is downloading without slowing every other spec down.
- Environment: `MM_TOOLBOX_TOKEN` (bearer, empty = off), `MM_TOOLBOX_FIXTURES`,
  `MM_YTDLP_AUTOUPDATE`, `MM_ACOUSTID_KEY`, `MM_LIBRARY_ROOT`, `MM_TOOLBOX_FIXTURE_DELAY_MS`.
- Tests: `uv run pytest` is offline and needs no binaries; the ones that do skip themselves.
  `pytest -m conformance` needs `docker compose up -d navidrome` and is the proof that what we write
  is what Navidrome reads.

## Generated files, never edited by hand

- `apps/web/src/routeTree.gen.ts` — gitignored, produced by `tsr generate` and the Vite plugin.
- `apps/web/drizzle/**` — migrations, produced by `bun run db:generate` and committed.
- `packages/contracts/toolbox/**` — produced by `bun run toolbox:openapi` and committed. Running it
  twice must leave the working tree clean.

## Security

- Secrets never enter this repository. `.env` and `.env.*` are gitignored except the two examples,
  which must stay free of real values. Every key is documented in `.env.example` and
  `.env.production.example`.
- Credentials read from settings are masked on output. `mm settings get` masks the four API keys;
  nothing ever prints a key in full.
- Do not paste an API key, a cookies file, a database URL or a session secret into a commit, a test
  fixture, a comment or a report.
- Public sign-up is off and there is exactly one account. Do not add a second authentication path.
- The toolbox publishes no port in production and is reachable only from the internal compose
  network. Keep it that way.

## Commits and pull requests

- Commits follow the Angular convention: `type(scope): subject`, with `feat`, `fix`, `chore`,
  `docs`, `test`, `refactor` and friends. The body explains the why when it is not obvious.
- One branch per task. Squashing is not required.
- `bun run check` must pass before you open a pull request, and `bun run e2e:all` before you merge
  anything that touches the import pipeline.
- Rebase on `main` before merging. Prefer `merge --ff-only`.
- Never use `git reset --hard` or `git checkout --` against a checkout you do not own.
