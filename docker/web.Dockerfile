# syntax=docker/dockerfile:1
#
# Placeholder. The real production image (web + worker, Nitro `bun` preset output,
# migrations at startup) is built in P10 — see ../../docs/phases/P10-production.md.
# It exists now only so `docker-compose.prod.yml` has something to point at.
#
# Build context is the repository root:
#   docker build -f docker/web.Dockerfile .

FROM oven/bun:1.3-slim AS build
WORKDIR /app

COPY package.json bun.lock tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/domain/package.json ./packages/domain/
COPY packages/contracts/package.json ./packages/contracts/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run --cwd apps/web build

FROM oven/bun:1.3-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.output ./.output
USER bun
EXPOSE 3000
CMD ["bun", ".output/server/index.mjs"]
