# syntax=docker/dockerfile:1
#
# Music Manager toolbox. Build context is the repository root:
#   docker build -f docker/toolbox.Dockerfile .
#
# This image is the only place the media binaries exist. `GET /health` reports the version
# of each one, and a null there means this Dockerfile is broken.

FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"

# ffmpeg: transcoding and probing. libchromaprint-tools: fpcalc, for AcoustID fingerprints.
# rsgain: ReplayGain 2.0. rsgain is not packaged in every Debian suite, so fall back to the
# upstream release .deb (https://github.com/complexlogic/rsgain/releases).
ARG RSGAIN_VERSION=3.8
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        ffmpeg \
        libchromaprint-tools; \
    if ! apt-get install -y --no-install-recommends rsgain; then \
        curl -fsSL -o /tmp/rsgain.deb \
            "https://github.com/complexlogic/rsgain/releases/download/v${RSGAIN_VERSION}/rsgain_${RSGAIN_VERSION}_amd64.deb"; \
        apt-get install -y --no-install-recommends /tmp/rsgain.deb; \
        rm -f /tmp/rsgain.deb; \
    fi; \
    rm -rf /var/lib/apt/lists/*; \
    ffmpeg -version | head -n 1; \
    fpcalc -version; \
    rsgain --version | head -n 1

# uv is pinned so the image is reproducible.
COPY --from=ghcr.io/astral-sh/uv:0.12.10 /uv /usr/local/bin/uv

COPY docker/toolbox-entrypoint.sh /usr/local/bin/toolbox-entrypoint.sh
RUN chmod +x /usr/local/bin/toolbox-entrypoint.sh

WORKDIR /app

# Dependencies first: this layer only changes when the lockfile changes.
COPY services/toolbox/pyproject.toml services/toolbox/uv.lock services/toolbox/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/toolbox/src ./src
RUN uv sync --frozen --no-dev

# yt-dlp is the one dependency that goes stale in days rather than months, so the image is
# built with the newest release rather than the locked one. Pass --build-arg YTDLP_UPDATE=0
# for a build that depends on nothing but the lockfile.
ARG YTDLP_UPDATE=1
RUN if [ "$YTDLP_UPDATE" = "1" ]; then uv pip install --no-cache --upgrade yt-dlp; fi \
    && python -c "import yt_dlp.version as v; print('yt-dlp', v.__version__)"

# The service writes to /library (the placed files) and to /cache (TMPDIR: cookie jars,
# artwork crops, rsgain/ffmpeg scratch space, and `uv`'s own temp files during
# MM_YTDLP_AUTOUPDATE=1). Both must exist and be owned by the service user *before* compose
# mounts a volume over them — an empty named volume inherits the ownership of the directory it
# is mounted over, but only if that directory already exists in the image. Without this,
# `/cache` is created by the Docker daemon as root:root at container start, and every write to
# it (the yt-dlp auto-update, a pasted cookies.txt, a fingerprint scan) fails with
# `PermissionError` instead of running as toolbox — silently, in the auto-update's case, since
# that step is deliberately best-effort and swallows its own failure.
RUN useradd --create-home --uid 10001 toolbox \
    && mkdir -p /library /cache \
    && chown -R toolbox:toolbox /library /cache /app /opt/venv

# Same provenance labels as `web.Dockerfile`, and for the same reason: `GET /health` states the
# contract hash this image implements, and when it disagrees with the app's, the only useful
# next question is which commit each of the two was built from.
ARG MM_GIT_SHA=unknown
ARG MM_BUILT_AT=unknown
LABEL org.opencontainers.image.title="music-manager-toolbox" \
      org.opencontainers.image.description="Music Manager — yt-dlp, mutagen, fpcalc, rsgain" \
      org.opencontainers.image.revision="${MM_GIT_SHA}" \
      org.opencontainers.image.created="${MM_BUILT_AT}"

USER toolbox
ENV UV_CACHE_DIR=/tmp/uv-cache
VOLUME ["/library", "/cache"]
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8100/health', timeout=3)"

ENTRYPOINT ["/usr/local/bin/toolbox-entrypoint.sh"]
CMD ["uvicorn", "toolbox.app:app", "--host", "0.0.0.0", "--port", "8100"]
