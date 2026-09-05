"""`POST /ytmusic/search` — find the album playlist behind an artist/album pair.

YouTube Music album playlists (`OLAK5uy_…`) are what the Discover page queues: they are
auto-generated, one video per track, with `- Topic` uploaders and the machine-written
descriptions the matcher parses. A search that finds one is worth far more than a guess at
a plain YouTube search URL.

ytmusicapi is used unauthenticated: public search needs no credentials.
"""

from __future__ import annotations

from typing import Any, Final, Literal, cast

import structlog

from toolbox import fixtures
from toolbox.config import fixtures_enabled
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import Thumbnail, YtMusicCandidate, YtMusicSearchRequest, YtMusicSearchResult

__all__ = ["build_query", "candidate_from_result", "search"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.ytmusic")

_ALBUM_URL: Final[str] = "https://music.youtube.com/playlist?list="
_VIDEO_URL: Final[str] = "https://music.youtube.com/watch?v="


def build_query(request: YtMusicSearchRequest) -> str:
    """`artist album title`, in that order, empty parts dropped."""
    return " ".join(
        part.strip() for part in (request.artist, request.album, request.title) if part
    ).strip()


def _text(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _artists(raw: Any) -> str | None:
    if not isinstance(raw, list) or not raw:
        return None
    names: list[str] = []
    for item in cast("list[Any]", raw):
        if not isinstance(item, dict):
            continue
        name = cast("dict[str, Any]", item).get("name")
        if isinstance(name, str) and name.strip():
            names.append(name.strip())
    return ", ".join(names) or None


def _thumbnails(raw: Any) -> list[Thumbnail]:
    if not isinstance(raw, list):
        return []
    out: list[Thumbnail] = []
    for item in cast(list[Any], raw):
        if not isinstance(item, dict):
            continue
        entry = cast(dict[str, Any], item)
        url = entry.get("url")
        if isinstance(url, str):
            width = entry.get("width")
            height = entry.get("height")
            out.append(
                Thumbnail(
                    url=url,
                    width=int(width) if isinstance(width, int) else None,
                    height=int(height) if isinstance(height, int) else None,
                )
            )
    return out


def candidate_from_result(result: dict[str, Any]) -> YtMusicCandidate | None:
    """Project one ytmusicapi search result. Returns ``None`` for kinds we do not queue."""
    kind = str(result.get("resultType") or "")
    title = _text(result.get("title"))
    if not title:
        return None

    year_raw = result.get("year")
    year = int(year_raw) if isinstance(year_raw, (int, str)) and str(year_raw).isdigit() else None
    duration_raw = result.get("duration_seconds")
    duration = float(duration_raw) if isinstance(duration_raw, (int, float)) else None

    album_raw = result.get("album")
    album = (
        _text(cast(dict[str, Any], album_raw).get("name"))
        if isinstance(album_raw, dict)
        else _text(album_raw)
    )

    playlist_id = _text(result.get("playlistId")) or _text(result.get("audioPlaylistId"))
    video_id = _text(result.get("videoId"))
    browse_id = _text(result.get("browseId"))

    if kind in {"album", "playlist"}:
        url = f"{_ALBUM_URL}{playlist_id}" if playlist_id else None
        return YtMusicCandidate(
            kind="album",
            title=title,
            artist=_artists(result.get("artists")),
            album=title,
            year=year,
            playlist_id=playlist_id,
            browse_id=browse_id,
            url=url,
            thumbnails=_thumbnails(result.get("thumbnails")),
        )
    if kind in {"song", "video"}:
        return YtMusicCandidate(
            kind="song" if kind == "song" else "video",
            title=title,
            artist=_artists(result.get("artists")),
            album=album,
            year=year,
            duration=duration,
            video_id=video_id,
            url=f"{_VIDEO_URL}{video_id}" if video_id else None,
            thumbnails=_thumbnails(result.get("thumbnails")),
        )
    return None


def search(request: YtMusicSearchRequest) -> YtMusicSearchResult:
    """Search YouTube Music for an album playlist, falling back to songs."""
    query = build_query(request)
    if fixtures_enabled():
        return YtMusicSearchResult(
            query=query,
            candidates=fixtures.ytmusic(request.artist, request.album, request.title)[
                : request.limit
            ],
        )

    try:
        from ytmusicapi import YTMusic
    except ImportError as exc:  # pragma: no cover - ytmusicapi is a hard dependency
        raise ToolboxError(ErrorCode.UNKNOWN, f"ytmusicapi is unavailable: {exc}") from exc

    filters: list[Literal["albums", "songs"]] = (
        ["albums", "songs"] if request.album else ["songs", "albums"]
    )
    candidates: list[YtMusicCandidate] = []
    try:
        client = YTMusic()
        for search_filter in filters:
            raw = client.search(query, filter=search_filter, limit=request.limit)
            for item in cast(list[Any], raw):
                if not isinstance(item, dict):
                    continue
                candidate = candidate_from_result(cast(dict[str, Any], item))
                if candidate is not None:
                    candidates.append(candidate)
            if len(candidates) >= request.limit:
                break
    except Exception as exc:
        log.warning("ytmusic.failed", error=str(exc))
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"YouTube Music search failed: {exc}", status=502
        ) from exc

    return YtMusicSearchResult(query=query, candidates=candidates[: request.limit])
