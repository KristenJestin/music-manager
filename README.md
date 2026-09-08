# Music Manager

Music Manager imports music from YouTube and files it into a local library with as many correct
tags as it can get.

You paste a URL. The app searches MusicBrainz, ranks the candidate releases and shows you why the
top one won. You choose. It downloads the audio, writes the tags and moves the file into the
library. Navidrome, Feishin and Symfonium then read that library like any other.

It is self-hosted, has one account and runs under Docker in production.

## Why it works this way

Music Manager writes the standard superset of tags, the one MusicBrainz Picard documents, in
whatever slot the file format offers. It does not target one server's dialect. A field some player
starts reading next year is already in the file.

The database holds the metadata, with provenance per field. Files are a projection of it. That is
what makes offline re-tagging possible: change the tag schema, add a source, correct a spelling,
and the app rewrites the files from the raw responses it already cached. Nothing is downloaded
twice.

## Choosing the release

The app queries MusicBrainz, scores each candidate against the video title, the duration, the
track count and the channel, then puts the best one first with its reasons written out. You confirm
it or pick another. The video-to-track mapping is 1:1 and you can edit it. Anything ambiguous goes
to an Inbox with an answer already filled in, waiting for a click.

Each import is a job made of replayable steps. One download runs at a time.

## The library

Files land in a directory Navidrome scans. Downloads go to `.mm-work/` inside the same mount, so
the final move is a rename and the scanner ignores the staging area. The same files serve
Navidrome, Feishin and Symfonium, which read the library without any per-server tag profile.

After tagging, `mm verify` asks a real Navidrome what it sees and compares it to what was written.

## Interfaces

Everything the Console does is reachable over HTTP.

- REST API under `/api/v1`, with OpenAPI at `/api/openapi.json` and a browsable page at
  `/api/docs`. Tokens carry scopes.
- An MCP server at `/mcp` with twenty-one tools, enough for an agent to run an import from URL to
  filed album.
- A CLI: `bun run mm -- import <url>`, plus `jobs`, `job`, `retry`, `inbox`, `match`, `library`,
  `retag`, `scan`, `verify`, `discover`, `settings`.

## Discover

Three blocks propose what to import next: albums missing from the discography of artists you
already play, recommendations from ListenBrainz, and similar artists. Every proposal carries a
reason in plain words and a Not interested button that is remembered. Listening signals come from
Navidrome over Subsonic, and from ListenBrainz when you scrobble there.

## Quick start (development)

You need Bun 1.3 or later and a running Docker daemon. Node, Python, ffmpeg and yt-dlp are not
required on the host; they live in the toolbox image.

```bash
git clone https://github.com/KristenJestin/music-manager
cd music-manager
bun install

cp .env.example .env      # every key is documented in the file
bun run stack:up          # postgres, the toolbox, Navidrome
bun run dev               # http://localhost:3000
bun run worker            # second terminal
```

The first boot creates the single administrator account from `MM_ADMIN_EMAIL` and
`MM_ADMIN_PASSWORD`, or serves `/setup` once if you left them empty.

`bun run dev:portless` serves the app at `https://music-manager.localhost` instead, if
[portless](https://portless.sh/) is installed. `bun run stack:info` prints which database, ports
and library the current checkout resolves to.

To try it with no network at all, set `MM_FIXTURES=1` and `MM_TOOLBOX_FIXTURES=1`, bring the stack
back up, and import `fixture://currents`. Every external answer comes from a recording.

## Production

Production is four containers behind a reverse proxy, configured by one `.env`. The procedure is in
[`docs/deploy.md`](docs/deploy.md), which is written in French: first install, backups, updates,
logs and what to do when it breaks. Start from `.env.production.example`. Taking over a v1
installation is [`docs/migration-v1.md`](docs/migration-v1.md).

## Architecture

```
      browser        API client        MCP client        CLI
         └────────────────┴─────────────────┴─────────────┘
                                │
                     ┌──────────▼──────────┐
                     │ web                 │  TanStack Start on Bun
                     │ Console UI          │  /api/v1  /mcp  server functions
                     └──────────┬──────────┘
                                │
              ┌─────────────────┴─────────────────┐
              ▼                                   ▼
      ┌───────────────┐                   ┌───────────────┐
      │ postgres      │◄──────────────────│ worker        │  pg-boss
      │ metadata      │                   │ import steps  │  one download at a time
      │ jobs, cache   │                   └───────┬───────┘
      └───────────────┘                           │ HTTP
                                                  ▼
                                          ┌───────────────┐
                                          │ toolbox       │  FastAPI, stateless
                                          │ Python        │  yt-dlp, mutagen,
                                          └───────┬───────┘  fpcalc, rsgain, ffmpeg
                                                  │ writes
                                                  ▼
                                          ┌───────────────┐
                                          │ library       │──► Navidrome ──► Feishin,
                                          │ on disk       │                  Symfonium
                                          └───────────────┘
```

`packages/domain` owns the tag map, the metadata document and the matching, in plain TypeScript.
`packages/contracts` holds the shared zod schemas and the toolbox client generated from its
OpenAPI. The toolbox has no database and no business logic; it receives already-projected tag
pairs and runs the binaries.

## Commands

Everything runs from the repository root with Bun.

| Command               | What it does                                                   |
| --------------------- | -------------------------------------------------------------- |
| `bun run check`       | the gate: types, lint, format, vitest, ruff, pyright, pytest   |
| `bun run test`        | vitest and pytest only                                         |
| `bun run dev`         | the stack, then the web app                                    |
| `bun run worker`      | the job orchestrator                                           |
| `bun run mm -- <cmd>` | the CLI                                                        |
| `bun run stack:up`    | the containers this checkout owns (`stack:down`, `stack:info`) |
| `bun run db:migrate`  | apply pending migrations                                       |
| `bun run e2e:all`     | the four end-to-end suites, cheapest first                     |

The end-to-end suites are the offline vertical slice, the Console under Playwright, the v1
take-over, and a read-back against a real Navidrome container. Both `check` and `e2e:all` want the
toolbox up in fixtures mode first: `MM_TOOLBOX_FIXTURES=1 bun run stack:up`.

Contributor and agent instructions are in [`AGENTS.md`](AGENTS.md).

## Status

v0, and personal. It was written for one library and it is run by one person. There is no release,
no upgrade guarantee and no support. The database schema and the API change when they need to.
Issues and questions are fine; answers may be slow.

## License

License: TBD. No license file is in the repository yet, so default copyright applies. You can read
the code; there is no grant to use, modify or redistribute it.
