# toolbox

Stateless Python service that owns the media tools the TypeScript side does not do well:
`yt-dlp` (as a library), `mutagen`, `fpcalc`/AcoustID, `rsgain`, `ytmusicapi`.

It has **no database and no business logic**. It executes operations and returns structured
results; the orchestrator in `apps/web` persists everything. See `../../../docs/06-stack.md`.

P00 ships only `GET /health`. The real endpoints arrive in P02.

## Run it

Normally you do not run this by hand — `docker compose -f ../../docker-compose.dev.yml up -d`
builds and starts it on <http://localhost:8100>.

Locally, for lint and tests only (the media binaries live in the Docker image):

```bash
uv sync
uv run ruff check .
uv run pyright
uv run pytest
uv run uvicorn toolbox.app:app --port 8100   # /health will report null versions off-image
```

## Environment

| Variable              | Effect                                                                             |
| --------------------- | ---------------------------------------------------------------------------------- |
| `MM_TOOLBOX_TOKEN`    | when set, every endpoint except `/health` requires `Authorization: Bearer <token>` |
| `MM_TOOLBOX_FIXTURES` | `1` puts the service in offline fixtures mode (no network egress)                  |
