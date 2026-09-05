"""FastAPI application for the Music Manager toolbox.

P00 exposes a single endpoint, ``GET /health``, whose job is to prove that the Docker image
really contains every media binary the later phases need. The extract / download / tag /
fingerprint / replaygain endpoints arrive in P02.
"""

from __future__ import annotations

import os
import secrets

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, ConfigDict, Field

from toolbox import __version__
from toolbox.versions import ffmpeg_version, fpcalc_version, rsgain_version, yt_dlp_version

__all__ = ["app", "fixtures_enabled", "health", "require_token"]

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.JSONRenderer(),
    ],
)
log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox")

#: Paths that stay reachable without a bearer token. `/health` is a liveness probe: the
#: Docker healthcheck and the orchestrator's readiness poll cannot carry credentials.
PUBLIC_PATHS: frozenset[str] = frozenset({"/health", "/openapi.json", "/docs", "/redoc"})


def fixtures_enabled() -> bool:
    """True when the service must run fully offline against recorded fixtures."""
    return os.environ.get("MM_TOOLBOX_FIXTURES", "").strip() in {"1", "true", "yes"}


def require_token(request: Request) -> None:
    """Optional bearer authentication.

    When ``MM_TOOLBOX_TOKEN`` is unset or empty the check is skipped entirely, which is the
    default for local development. Only `apps/web` ever talks to this service.
    """
    expected = os.environ.get("MM_TOOLBOX_TOKEN", "").strip()
    if not expected or request.url.path in PUBLIC_PATHS:
        return
    scheme, _, presented = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(presented.strip(), expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


class ToolVersions(BaseModel):
    """Version of each external tool, or ``None`` when it is missing from the image."""

    model_config = ConfigDict(populate_by_name=True)

    yt_dlp: str | None = Field(alias="yt-dlp")
    ffmpeg: str | None
    fpcalc: str | None
    rsgain: str | None


class Health(BaseModel):
    """Payload of ``GET /health``. Mirrored in `packages/contracts`."""

    ok: bool
    fixtures: bool
    versions: ToolVersions


app = FastAPI(
    title="Music Manager toolbox",
    version=__version__,
    summary="Stateless media operations: yt-dlp, mutagen, fpcalc/AcoustID, rsgain.",
    dependencies=[Depends(require_token)],
)


@app.get("/health", operation_id="health", tags=["meta"])
def health() -> Health:
    """Report liveness and which media tools this image actually carries."""
    versions = ToolVersions(
        **{
            "yt-dlp": yt_dlp_version(),
            "ffmpeg": ffmpeg_version(),
            "fpcalc": fpcalc_version(),
            "rsgain": rsgain_version(),
        }
    )
    return Health(ok=True, fixtures=fixtures_enabled(), versions=versions)
