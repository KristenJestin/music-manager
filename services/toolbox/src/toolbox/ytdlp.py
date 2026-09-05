"""The yt-dlp adapter — the whole reason this service is written in Python.

`docs/02-lecons-v1.md` names the v1 failure precisely: yt-dlp driven as a subprocess with
concatenated arguments, the output path *guessed from stdout*, and no update path. Here
yt-dlp is a library: options are a dict, the resulting file path comes out of the info dict,
progress arrives through hooks, and failures are exception objects that
:func:`toolbox.errors.classify_ytdlp_error` turns into catalogued codes.

yt-dlp ships no type information, so this module is the only place that touches it; every
value crossing its boundary is narrowed here.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, cast

from yt_dlp import YoutubeDL  # pyright: ignore[reportMissingTypeStubs]

from toolbox.models import ExtractEntry, ExtractResult, Thumbnail, YtdlpOptions

__all__ = [
    "build_options",
    "downloaded_path",
    "entry_from_info",
    "extract_info",
    "needs_audio_extraction",
    "result_from_info",
    "yt_dlp_version",
]

InfoDict = dict[str, Any]
ProgressHook = Callable[[dict[str, Any]], None]

#: Options every call shares. `quiet`/`no_warnings` keep stdout clean — we never read it.
_BASE: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "noplaylist": False,
    "ignoreerrors": False,
    "extract_flat": False,
    "retries": 3,
    "socket_timeout": 30,
    # `--continue` is always on: a toolbox restart must resume the `.part`, never restart it.
    "continuedl": True,
}


def yt_dlp_version() -> str | None:
    """The running yt-dlp version, read from the module rather than a binary."""
    try:
        from yt_dlp.version import __version__  # pyright: ignore[reportMissingTypeStubs]
    except ImportError:  # pragma: no cover - yt-dlp is a hard dependency
        return None
    return str(__version__)


def build_options(options: YtdlpOptions, **overrides: Any) -> dict[str, Any]:
    """Assemble the yt-dlp option dict. ``extra_args`` is merged last, on purpose."""
    built: dict[str, Any] = {**_BASE, **overrides}
    if options.cookies:
        built["cookiefile"] = options.cookies
    if options.player_client:
        built["extractor_args"] = {"youtube": {"player_client": [options.player_client]}}
    built.update(options.extra_args)
    return built


def extract_info(url: str, options: Mapping[str, Any], *, download: bool = False) -> InfoDict:
    """Run yt-dlp and hand back its info dict. Exceptions are left to the caller."""
    # yt-dlp types its option dict as a private TypedDict; ours is assembled at runtime.
    with YoutubeDL(cast(Any, dict(options))) as ydl:
        info = ydl.extract_info(url, download=download)
        if not info:
            raise ValueError("Video unavailable: yt-dlp returned no information.")
        return cast(InfoDict, ydl.sanitize_info(cast(Any, info)))


def needs_audio_extraction(info: Mapping[str, Any]) -> bool:
    """True when the selected format is not already a pure audio container.

    The spec forbids re-encoding: with ``bestaudio`` yt-dlp normally hands back a webm/opus
    or m4a stream that only needs to be renamed. ``FFmpegExtractAudio`` is added only when
    the selection fell back to something carrying video.
    """
    vcodec = info.get("vcodec")
    if isinstance(vcodec, str) and vcodec not in {"none", ""}:
        return True
    requested = info.get("requested_formats")
    if isinstance(requested, list):
        for item in cast("list[Any]", requested):
            if not isinstance(item, dict):
                continue
            selected = cast("dict[str, Any]", item)
            if str(selected.get("vcodec", "none")) not in {"none", ""}:
                return True
    return False


def _thumbnails(info: Mapping[str, Any]) -> list[Thumbnail]:
    raw = info.get("thumbnails")
    if not isinstance(raw, list):
        return []
    out: list[Thumbnail] = []
    for item in cast(list[Any], raw):
        if not isinstance(item, dict):
            continue
        entry = cast(dict[str, Any], item)
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        out.append(
            Thumbnail(
                url=url,
                width=_as_int(entry.get("width")),
                height=_as_int(entry.get("height")),
            )
        )
    return out


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def entry_from_info(info: Mapping[str, Any], index: int) -> ExtractEntry:
    """Project one yt-dlp entry onto the contract, keeping YouTube Music's own tags."""
    return ExtractEntry(
        id=str(info.get("id") or ""),
        title=str(info.get("title") or ""),
        duration=_as_float(info.get("duration")),
        uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
        index=index,
        track=_as_str(info.get("track")),
        artist=_as_str(info.get("artist")),
        album=_as_str(info.get("album")),
        release_year=_as_int(info.get("release_year")),
        description=_as_str(info.get("description")),
        thumbnails=_thumbnails(info),
        webpage_url=_as_str(info.get("webpage_url")),
    )


def result_from_info(info: Mapping[str, Any]) -> ExtractResult:
    """Turn a video or playlist info dict into an :class:`ExtractResult`."""
    entries_raw = info.get("entries")
    if isinstance(entries_raw, list):
        entries: list[ExtractEntry] = []
        for index, item in enumerate(cast(list[Any], entries_raw)):
            if isinstance(item, dict):
                entries.append(entry_from_info(cast(dict[str, Any], item), index))
        return ExtractResult(
            kind="playlist",
            title=_as_str(info.get("title")),
            uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
            id=_as_str(info.get("id")),
            entries=entries,
        )
    return ExtractResult(
        kind="video",
        title=_as_str(info.get("title")),
        uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
        id=_as_str(info.get("id")),
        entries=[entry_from_info(info, 0)],
    )


def downloaded_path(info: Mapping[str, Any]) -> Path | None:
    """The file yt-dlp actually wrote, taken from the info dict — never from stdout."""
    requested = info.get("requested_downloads")
    if isinstance(requested, list) and requested:
        first = cast(list[Any], requested)[0]
        if isinstance(first, dict):
            for key in ("filepath", "_filename", "filename"):
                value = cast(dict[str, Any], first).get(key)
                if isinstance(value, str) and value:
                    return Path(value)
    for key in ("filepath", "_filename"):
        value = info.get(key)
        if isinstance(value, str) and value:
            return Path(value)
    return None
