"""`POST /extract` — resolve a URL to entries, without downloading anything.

This is the `resolve` step of `docs/04-pipeline-et-matching.md`: yt-dlp is asked for the
metadata only, and the result feeds the matcher — durations, YouTube Music's own
`track`/`artist`/`album`/`release_year` tags, and the auto-generated description whose
"Provided to YouTube by" block v1 already proved to be a reliable signal.
"""

from __future__ import annotations

import structlog

from toolbox import fixtures
from toolbox.config import fixtures_enabled
from toolbox.errors import ErrorCode, ToolboxError, classify_ytdlp_error
from toolbox.models import ExtractRequest, ExtractResult
from toolbox.urls import UrlKind, is_fixture_url, parse_url
from toolbox.ytdlp import build_options, cookie_jar, extract_info, result_from_info

__all__ = ["extract", "flat_options"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.extract")


def flat_options(flat: bool) -> dict[str, object]:
    """The two options that turn a full extraction into a listing.

    ``extract_flat="in_playlist"`` rather than ``True``: a *video* URL asked for flatly must
    still come back as a video, and ``True`` would answer with a stub for it too.

    ``ignoreerrors`` is the other half, and it is the point of the mode. A watched playlist
    accumulates private and deleted videos forever; with the default (``False``) the first one
    aborts the whole extraction, so a source would stop reporting anything new the day one of
    its old entries went private. With it on, yt-dlp yields what it can and the unreachable
    entries arrive as placeholders that :func:`toolbox.ytdlp.is_unavailable` marks.
    """
    if not flat:
        return {}
    return {"extract_flat": "in_playlist", "ignoreerrors": True}


def extract(request: ExtractRequest) -> ExtractResult:
    """Resolve ``url`` into entries. Fixture URLs answer from disk in either mode."""
    if is_fixture_url(request.url):
        return fixtures.extract(request.url, flat=request.flat)
    if fixtures_enabled():
        raise ToolboxError(
            ErrorCode.FIXTURE_UNKNOWN,
            f"Fixtures mode refuses to reach the network for '{request.url}'.",
            details={"requested": request.url, "known": sorted(fixtures.KNOWN)},
        )

    parsed = parse_url(request.url)
    if parsed.kind is UrlKind.UNKNOWN:
        raise ToolboxError(
            ErrorCode.YTDLP_UNAVAILABLE,
            f"'{request.url}' is not a YouTube video or playlist URL.",
            status=422,
            details={"requested": request.url},
        )

    try:
        with cookie_jar(request) as jar:
            info = extract_info(
                request.url,
                build_options(request, skip_download=True, **jar, **flat_options(request.flat)),
                download=False,
            )
    except Exception as exc:
        raise classify_ytdlp_error(exc, url=request.url) from exc

    result = result_from_info(info)
    log.info(
        "extract.ok",
        kind=result.kind,
        entries=len(result.entries),
        unavailable=sum(1 for entry in result.entries if entry.unavailable),
        flat=request.flat,
        id=parsed.id,
    )
    return result
