"""`POST /probe` — what ffprobe sees in a file, tags included.

The point is the *tags*: `docs/03-metadonnees.md` §7 compares the metadata document with
what is actually in the file, so this endpoint returns **every** tag ffprobe reports, at
container and stream level, rather than a curated subset. Keys are upper-cased, because
Vorbis is case-insensitive and ID3/MP4 report their own casing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import ProbeResult, ProbeStream
from toolbox.subprocesses import run_tool

__all__ = ["probe"]

_ARGS = ("-v", "quiet", "-print_format", "json", "-show_format", "-show_streams")


def _as_int(value: Any) -> int | None:
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def _as_float(value: Any) -> float | None:
    try:
        return float(str(value))
    except (TypeError, ValueError):
        return None


def _tags(source: dict[str, Any], into: dict[str, str]) -> None:
    raw = source.get("tags")
    if isinstance(raw, dict):
        for key, value in cast(dict[str, Any], raw).items():
            into[str(key).upper()] = str(value)


def probe(path_str: str) -> ProbeResult:
    """Run ffprobe on ``path`` and project its JSON onto the contract."""
    path = Path(path_str)
    if not path.is_file():
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"No such file: {path}", status=404, details={"path": str(path)}
        )

    completed = run_tool("ffprobe", [*_ARGS, str(path)], timeout=60)
    try:
        payload = cast(dict[str, Any], json.loads(completed.stdout or "{}"))
    except ValueError as exc:  # pragma: no cover - ffprobe always emits valid JSON
        raise ToolboxError(ErrorCode.UNKNOWN, f"ffprobe returned invalid JSON: {exc}") from exc

    container = cast(dict[str, Any], payload.get("format") or {})
    raw_streams = cast(list[Any], payload.get("streams") or [])

    tags: dict[str, str] = {}
    _tags(container, tags)

    streams: list[ProbeStream] = []
    audio: dict[str, Any] | None = None
    has_picture = False
    for item in raw_streams:
        if not isinstance(item, dict):
            continue
        stream = cast(dict[str, Any], item)
        kind = str(stream.get("codec_type") or "")
        if kind == "video":
            # An embedded cover is reported as a video stream carrying its own `title`
            # ("Back cover"). Merging those would overwrite the track's real tags.
            has_picture = True
        else:
            _tags(stream, tags)
        if kind == "audio" and audio is None:
            audio = stream
        streams.append(
            ProbeStream(
                index=_as_int(stream.get("index")) or 0,
                codec_name=str(stream.get("codec_name")) if stream.get("codec_name") else None,
                codec_type=kind or None,
                sample_rate=_as_int(stream.get("sample_rate")),
                channels=_as_int(stream.get("channels")),
                bit_rate=_as_int(stream.get("bit_rate")),
            )
        )

    # An Opus file carries its cover in METADATA_BLOCK_PICTURE, which ffprobe reports as a
    # tag rather than as a video stream.
    has_picture = has_picture or "METADATA_BLOCK_PICTURE" in tags

    return ProbeResult(
        path=str(path),
        format_name=str(container.get("format_name")) if container.get("format_name") else None,
        codec=str(audio.get("codec_name")) if audio and audio.get("codec_name") else None,
        duration=_as_float(container.get("duration")),
        bit_rate=_as_int(container.get("bit_rate")),
        sample_rate=_as_int(audio.get("sample_rate")) if audio else None,
        channels=_as_int(audio.get("channels")) if audio else None,
        size=path.stat().st_size,
        streams=streams,
        tags=tags,
        has_picture=has_picture,
    )
