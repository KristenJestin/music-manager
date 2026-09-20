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
#
# The `[default]` extra is not decoration: it carries `yt-dlp-ejs`, the JavaScript challenge
# scripts YouTube now asks for. Plain `yt-dlp` ships neither them nor a runtime to run them, and
# says so itself — "YouTube extraction without a JS runtime has been deprecated, and some formats
# may be missing" — which is the shape of an import that half works. The second install is what
# puts the extra into the lockfile-only build too; when the first one runs, it is already there.
ARG YTDLP_UPDATE=1
RUN if [ "$YTDLP_UPDATE" = "1" ]; then uv pip install --no-cache --upgrade "yt-dlp[default]"; fi \
    && uv pip install --no-cache "yt-dlp[default]" \
    && python -c "import yt_dlp.version as v; print('yt-dlp', v.__version__)"

# The runtime those scripts run in. `--js-runtimes` defaults to `deno` and to nothing else, so
# installing the binary *is* the configuration, and it is one static file — this image does not
# grow a Node.js just to extract audio. Extracted with `python -m zipfile` rather than `unzip`:
# Python is already here, and one apt package less is one thing less to patch.
ARG DENO_VERSION=2.9.7
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) deno_arch=x86_64-unknown-linux-gnu ;; \
        arm64) deno_arch=aarch64-unknown-linux-gnu ;; \
        *) echo "no deno build for $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/deno.zip \
        "https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-${deno_arch}.zip"; \
    python -m zipfile -e /tmp/deno.zip /usr/local/bin; \
    chmod +x /usr/local/bin/deno; \
    rm -f /tmp/deno.zip; \
    deno --version

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
