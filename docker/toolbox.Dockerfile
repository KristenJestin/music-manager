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

WORKDIR /app

# Dependencies first: this layer only changes when the lockfile changes.
COPY services/toolbox/pyproject.toml services/toolbox/uv.lock services/toolbox/README.md ./
RUN uv sync --frozen --no-dev --no-install-project

COPY services/toolbox/src ./src
RUN uv sync --frozen --no-dev

# The service is stateless; /library is the only thing it writes to.
RUN useradd --create-home --uid 10001 toolbox \
    && mkdir -p /library \
    && chown -R toolbox:toolbox /library /app

USER toolbox
VOLUME ["/library"]
EXPOSE 8100

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
    CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8100/health', timeout=3)"

CMD ["uvicorn", "toolbox.app:app", "--host", "0.0.0.0", "--port", "8100"]
