# syntax=docker/dockerfile:1
#
# The production image for `web` **and** `worker` (`docs/phases/P10-production.md` § Images).
#
# One image, two commands. `docs/06-stack.md` fixes the concurrency at one orchestrator, and an
# orchestrator that is a different build from the server it shares a database with is a class of
# bug that costs an evening to find: they parse the same rows with the same Drizzle schema and
# the same zod contracts, so they must be the same commit. The entrypoint takes a role.
#
# Build context is the repository root:
#   docker build -f docker/web.Dockerfile -t music-manager-web .
#
# --- why the runtime stage ships source as well as `.output` -----------------
#
# `bun run build` produces a fully bundled Nitro server (`apps/web/.output`, ~10 MB, no
# `node_modules` needed). That is what serves HTTP, and it is why the first byte of a page comes
# back in tens of milliseconds instead of the seconds `vite dev` takes on a cold route.
#
# The **worker** cannot be bundled the same way. It is not a Nitro entry, and bundling it with
# `bun build` fails on the virtual modules `@tanstack/react-start/server` imports
# (`#tanstack-router-entry`, `tanstack-start-manifest:v`) — reachable from the worker's graph
# through `server/auth/session.ts`. Marking them external does produce a working 2.4 MB bundle,
# but a second problem is fatal: the fixtures and cassettes that `MM_FIXTURES=1` reads are
# located with `new URL(".", import.meta.url)` relative to the *source file*
# (`server/services/sources/fixtures.ts`, `services/matching.cassettes.ts`,
# `integrations/seed-fixtures.ts`), and a bundle moves every one of those files. Fixtures mode is
# what `scripts/smoke.sh` and the offline demo run on, so it has to keep working in the image.
#
# So the worker and the migration runner execute from source under Bun — which is what they do
# in development, so there is no third behaviour to reason about — and that is the only reason
# `node_modules` is in the final image. It is installed with `--production`, so Vite, Playwright,
# drizzle-kit, vitest and the rest of the toolchain stay in the build stages.

ARG BUN_IMAGE=oven/bun:1.3-slim

# -----------------------------------------------------------------------------
# 1. dependencies — this layer only changes when the lockfile does
# -----------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile

# -----------------------------------------------------------------------------
# 2. build — `vite build` with the Nitro `bun` preset
# -----------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps/web apps/web
# `routeTree.gen.ts` is gitignored and regenerated here by the TanStack router plugin, so the
# image never depends on a generated file someone forgot to refresh.
RUN bun run --cwd apps/web build \
    && test -f apps/web/.output/server/index.mjs

# -----------------------------------------------------------------------------
# 3. runtime
# -----------------------------------------------------------------------------
FROM ${BUN_IMAGE} AS runtime

# curl is the healthcheck and the one tool an operator reaches for inside the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The same uid/gid as the toolbox image (`docker/toolbox.Dockerfile`), on purpose: the two
# containers write to the *same* library volume, and a file one of them creates has to be
# writable by the other. Docker seeds a fresh named volume with the ownership of the directory
# it shadows, so `/library` is owned by this user before anything mounts over it.
RUN groupadd --gid 10001 mm \
    && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin mm \
    && mkdir -p /library \
    && chown mm:mm /library

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    MM_LIBRARY_ROOT=/library \
    MM_TOOLBOX_LIBRARY_ROOT=/library

# The runtime dependencies, installed here rather than copied from a stage of their own: Bun
# hard-links `node_modules/.bun/<pkg>` into each `node_modules/<name>`, and `COPY --from=` does
# not preserve hard links. (Measured: it made no difference to the final size on this tree, but
# it is one stage fewer and it cannot get worse.)
#
# `--production` is worth less here than it looks: it removes the toolchain, but the layer is
# still ~420 MB because `nitro`, `lucide-react` and `@base-ui/react` are *runtime* dependencies
# of `apps/web` as declared — even though the only thing that needs them is the build, since the
# server they produce is already bundled into `.output`. Moving them would change the lockfile
# and is carried as debt rather than done in passing (see the P10 report).
COPY --chown=mm:mm package.json bun.lock ./
COPY --chown=mm:mm apps/web/package.json apps/web/package.json
COPY --chown=mm:mm packages/domain/package.json packages/domain/package.json
COPY --chown=mm:mm packages/contracts/package.json packages/contracts/package.json
RUN bun install --frozen-lockfile --production && chown -R mm:mm /app

# Everything the worker and the migration runner resolve at runtime.
#
# `apps/web/tsconfig.json` is **not optional here, and it is not for type checking.** The app's
# `#/…` alias is resolved by Bun from `compilerOptions.paths`, not from the package.json
# `imports` map: Node forbids an import specifier that starts with `#/`, so `"#/*": "./src/*"`
# in package.json is inert and only the tsconfig entry does the work. Leaving the file out
# produced a container that started, applied no migrations and died in a restart loop on
# `Cannot find module '#/server/env.ts'` — a message that reads like a missing dependency and
# is a missing 200-byte config.
COPY --chown=mm:mm tsconfig.base.json tsconfig.json ./
COPY --chown=mm:mm apps/web/tsconfig.json apps/web/tsconfig.json
COPY --chown=mm:mm packages packages
COPY --chown=mm:mm apps/web/src apps/web/src
COPY --chown=mm:mm apps/web/bin apps/web/bin
COPY --chown=mm:mm apps/web/drizzle apps/web/drizzle
COPY --chown=mm:mm apps/web/test/cassettes apps/web/test/cassettes

# The bundled server. Last, because it is what changes on every commit.
COPY --from=build --chown=mm:mm /app/apps/web/.output apps/web/.output

COPY docker/web-entrypoint.sh /usr/local/bin/web-entrypoint.sh
RUN chmod +x /usr/local/bin/web-entrypoint.sh

# `docker compose exec` bypasses the ENTRYPOINT — it runs the command it is given, directly —
# so the entrypoint's `mm` role is unreachable from `exec`, which is the one place an operator
# would type it. A two-line wrapper on PATH makes `docker compose exec web mm jobs` work.
RUN printf '#!/bin/sh\nexec bun /app/apps/web/bin/mm.ts "$@"\n' > /usr/local/bin/mm \
    && chmod +x /usr/local/bin/mm

# Which commit is this? The question is not idle: the toolbox states the API contract it
# implements in `GET /health` (`contract_hash`), `get_status` compares it with the one this
# image was generated against, and a mismatch means *these two images are not from the same
# commit*. When that happens the first thing an operator needs is the two revisions.
#   docker build --build-arg MM_GIT_SHA="$(git rev-parse HEAD)" …
ARG MM_GIT_SHA=unknown
ARG MM_BUILT_AT=unknown
LABEL org.opencontainers.image.title="music-manager-web" \
      org.opencontainers.image.description="Music Manager — Console, API and worker" \
      org.opencontainers.image.source="https://github.com/" \
      org.opencontainers.image.revision="${MM_GIT_SHA}" \
      org.opencontainers.image.created="${MM_BUILT_AT}"
ENV MM_GIT_SHA=${MM_GIT_SHA}

USER mm
EXPOSE 3000

# `/health` is the one route with no session (`server/auth/session.ts`), which is what makes it
# usable as a healthcheck without baking a credential into the image.
HEALTHCHECK --interval=10s --timeout=5s --start-period=40s --retries=6 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/web-entrypoint.sh"]
CMD ["web"]
