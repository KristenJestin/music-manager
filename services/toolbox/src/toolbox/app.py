"""FastAPI application for the Music Manager toolbox.

Stateless by construction: no database, no business logic, no memory between requests except
the single download slot. Every route is a thin adapter over one module, so that the modules
stay testable without HTTP and this file stays readable as a table of contents.

The service is never exposed outside the Docker network; `MM_TOOLBOX_TOKEN` is a
belt-and-braces shared bearer token for development.
"""

from __future__ import annotations

import secrets
from typing import Final

import structlog
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.responses import JSONResponse, StreamingResponse

from toolbox import __version__, artwork, maintenance, tagging, ytmusic
from toolbox import extract as extract_module
from toolbox import fingerprint as fp_module
from toolbox import place as place_module
from toolbox import probe as probe_module
from toolbox import replaygain as rg_module
from toolbox.config import fixtures_enabled, toolbox_token
from toolbox.download import MEDIA_TYPE, ndjson_download
from toolbox.errors import ERROR_CATALOG, ErrorBody, ToolboxError
from toolbox.lock import DOWNLOAD_LOCK
from toolbox.models import (
    ArtworkRequest,
    ArtworkResult,
    CookiesTestRequest,
    CookiesTestResult,
    DownloadRequest,
    ErrorCatalog,
    ErrorCatalogEntry,
    ExtractRequest,
    ExtractResult,
    FingerprintRequest,
    FingerprintResult,
    Health,
    PlaceRequest,
    PlaceResult,
    ProbeRequest,
    ProbeResult,
    ReplayGainRequest,
    ReplayGainResult,
    SelfTestRequest,
    SelfTestResult,
    TagRequest,
    TagResult,
    ToolVersions,
    UpdateResult,
    YtMusicSearchRequest,
    YtMusicSearchResult,
)
from toolbox.versions import ffmpeg_version, fpcalc_version, rsgain_version, yt_dlp_version

__all__ = ["app", "fixtures_enabled", "health", "require_token", "toolbox_error_handler"]

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
PUBLIC_PATHS: Final[frozenset[str]] = frozenset({"/health", "/openapi.json", "/docs", "/redoc"})

#: Documented on every route, so the generated TypeScript client knows the shape of a failure.
ERROR_RESPONSES: Final[dict[int | str, dict[str, object]]] = {
    "4XX": {"model": ErrorBody, "description": "A catalogued toolbox error."},
    "5XX": {"model": ErrorBody, "description": "A catalogued toolbox error."},
}


def require_token(request: Request) -> None:
    """Optional bearer authentication.

    When ``MM_TOOLBOX_TOKEN`` is unset or empty the check is skipped entirely, which is the
    default for local development. Only `apps/web` ever talks to this service.
    """
    expected = toolbox_token()
    if not expected or request.url.path in PUBLIC_PATHS:
        return
    scheme, _, presented = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(presented.strip(), expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


app = FastAPI(
    title="Music Manager toolbox",
    version=__version__,
    summary="Stateless media operations: yt-dlp, mutagen, fpcalc/AcoustID, rsgain.",
    dependencies=[Depends(require_token)],
)


@app.exception_handler(ToolboxError)
async def toolbox_error_handler(_: Request, error: ToolboxError) -> JSONResponse:
    """Every failure leaves as `{code, message, hint, action}` — the UI's error decoder."""
    log.warning("request.failed", code=error.code.value, message=error.message)
    return JSONResponse(status_code=error.status, content=error.body().model_dump(mode="json"))


# --------------------------------------------------------------------------------------
# Meta
# --------------------------------------------------------------------------------------


@app.get("/health", operation_id="health", tags=["meta"])
def health() -> Health:
    """Report liveness, the download slot, and which media tools this image actually carries."""
    versions = ToolVersions(
        **{
            "yt-dlp": yt_dlp_version(),
            "ffmpeg": ffmpeg_version(),
            "fpcalc": fpcalc_version(),
            "rsgain": rsgain_version(),
        }
    )
    return Health(
        ok=True, fixtures=fixtures_enabled(), downloading=DOWNLOAD_LOCK.held, versions=versions
    )


@app.get("/errors", operation_id="errorCatalog", tags=["meta"])
def error_catalog() -> ErrorCatalog:
    """The failure taxonomy, so the Console's decoder and the toolbox cannot drift apart.

    `docs/07-ui.md` gives Tools an "error decoder" table: what a yt-dlp message means and
    which button fixes it. Duplicating that table in TypeScript would guarantee it goes stale
    the first time a pattern is added here, so it is served from the one place that owns it.
    """
    return ErrorCatalog(
        entries=[
            ErrorCatalogEntry(
                code=spec.code.value,
                message=spec.message,
                hint=spec.hint,
                action=spec.action,
                status=spec.status,
                patterns=list(spec.patterns),
            )
            for spec in ERROR_CATALOG
        ]
    )


# --------------------------------------------------------------------------------------
# Resolve and download
# --------------------------------------------------------------------------------------


@app.post("/extract", operation_id="extract", tags=["download"], responses=ERROR_RESPONSES)
def extract(request: ExtractRequest) -> ExtractResult:
    """Resolve a URL to its entries without downloading anything."""
    return extract_module.extract(request)


@app.post(
    "/download",
    operation_id="download",
    tags=["download"],
    responses={
        200: {
            "content": {MEDIA_TYPE: {}},
            "description": "NDJSON stream of progress / postprocess / done / error events.",
        },
        **ERROR_RESPONSES,
    },
)
def download(request: DownloadRequest) -> StreamingResponse:
    """Download one file, streaming NDJSON events. A second concurrent call gets 409 LOCKED."""
    stream = ndjson_download(request)
    return StreamingResponse(
        stream,
        media_type=MEDIA_TYPE,
        headers={"cache-control": "no-store", "x-accel-buffering": "no"},
    )


# --------------------------------------------------------------------------------------
# Files
# --------------------------------------------------------------------------------------


@app.post("/probe", operation_id="probe", tags=["files"], responses=ERROR_RESPONSES)
def probe(request: ProbeRequest) -> ProbeResult:
    """Everything ffprobe knows about a file, including every tag present."""
    return probe_module.probe(request.path)


@app.post("/fingerprint", operation_id="fingerprint", tags=["files"], responses=ERROR_RESPONSES)
def fingerprint(request: FingerprintRequest) -> FingerprintResult:
    """Chromaprint fingerprint, plus AcoustID candidates when a key is available."""
    return fp_module.fingerprint(request)


@app.post("/tag", operation_id="tag", tags=["files"], responses=ERROR_RESPONSES)
def tag(request: TagRequest) -> TagResult:
    """Write already-projected key/value pairs, pictures and lyrics, then read them back."""
    return tagging.write_tags(request)


@app.post("/replaygain", operation_id="replaygain", tags=["files"], responses=ERROR_RESPONSES)
def replaygain(request: ReplayGainRequest) -> ReplayGainResult:
    """Scan with rsgain and write REPLAYGAIN_* (and R128_* on Opus)."""
    return rg_module.replaygain(request)


@app.post("/place", operation_id="place", tags=["files"], responses=ERROR_RESPONSES)
def place(request: PlaceRequest) -> PlaceResult:
    """Move a file into the library, atomically, creating the folders it needs."""
    return place_module.place(request)


@app.post(
    "/artwork/prepare",
    operation_id="prepareArtwork",
    tags=["files"],
    responses=ERROR_RESPONSES,
)
def prepare_artwork(request: ArtworkRequest) -> ArtworkResult:
    """Crop to square, resize and re-encode a cover as JPEG."""
    return artwork.prepare(request)


# --------------------------------------------------------------------------------------
# Sources and maintenance
# --------------------------------------------------------------------------------------


@app.post(
    "/ytmusic/search",
    operation_id="searchYtMusic",
    tags=["sources"],
    responses=ERROR_RESPONSES,
)
def search_ytmusic(request: YtMusicSearchRequest) -> YtMusicSearchResult:
    """Find the YouTube Music album playlist (`OLAK5uy_…`) or video behind a release."""
    return ytmusic.search(request)


@app.post(
    "/ytdlp/update", operation_id="updateYtDlp", tags=["maintenance"], responses=ERROR_RESPONSES
)
def update_ytdlp() -> UpdateResult:
    """Upgrade yt-dlp in place and report what changed."""
    return maintenance.update_ytdlp()


@app.post(
    "/ytdlp/selftest",
    operation_id="selftestYtDlp",
    tags=["maintenance"],
    responses=ERROR_RESPONSES,
)
def selftest_ytdlp(request: SelfTestRequest | None = None) -> SelfTestResult:
    """Prove the downloader works: module, binaries, and optionally a real extraction."""
    return maintenance.selftest(request or SelfTestRequest())


@app.post(
    "/cookies/test",
    operation_id="testCookies",
    tags=["maintenance"],
    responses=ERROR_RESPONSES,
)
def test_cookies(request: CookiesTestRequest) -> CookiesTestResult:
    """Parse a cookies.txt offline and report whether it is a usable YouTube session."""
    return maintenance.cookies_test(request)
