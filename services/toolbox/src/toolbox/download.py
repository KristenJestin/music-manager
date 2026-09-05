"""`POST /download` — one file at a time, streamed as NDJSON.

Four event shapes, one JSON object per line:

* ``{"event":"progress","downloaded":…,"total":…,"speed":…,"eta":…}``
* ``{"event":"postprocess","step":"FFmpegExtractAudio"}``
* ``{"event":"done","path":…,"format_id":…,"codec":…,"size":…}``
* ``{"event":"error","code":…,"message":…,"hint":…,"action":…}``

yt-dlp runs in a worker thread and pushes into a queue; the async generator drains it. The
final path is read out of the info dict — the v1 bug was reading it out of stdout.
"""

from __future__ import annotations

import asyncio
import json
import queue
import shutil
import threading
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, Final

import structlog

from toolbox import fixtures
from toolbox.config import fixture_delay_seconds, fixtures_enabled
from toolbox.errors import ToolboxError, classify_ytdlp_error
from toolbox.lock import DOWNLOAD_LOCK
from toolbox.models import DownloadRequest
from toolbox.ytdlp import build_options, downloaded_path, extract_info, needs_audio_extraction

__all__ = ["MEDIA_TYPE", "ndjson_download"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.download")

MEDIA_TYPE: Final[str] = "application/x-ndjson"

#: yt-dlp calls the progress hook hundreds of times a second; the UI needs about four.
_THROTTLE_SECONDS: Final[float] = 0.25
#: Size of the slices the fixture download copies, so that progress is visible offline.
_FIXTURE_CHUNK: Final[int] = 16 * 1024

_SENTINEL: Final[object] = object()


def _line(payload: dict[str, Any]) -> bytes:
    return (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def _error_line(error: ToolboxError) -> bytes:
    return _line(
        {
            "event": "error",
            "code": error.code.value,
            "message": error.message,
            "hint": error.hint,
            "action": error.action,
        }
    )


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    return float(value) if isinstance(value, (int, float)) else None


# --------------------------------------------------------------------------------------
# The real thing
# --------------------------------------------------------------------------------------


class _Worker:
    """Runs yt-dlp on a thread and posts events into ``out``."""

    def __init__(self, request: DownloadRequest, out: queue.Queue[Any]) -> None:
        self.request = request
        self.out = out
        self._last_emit = 0.0

    def _progress(self, status: dict[str, Any]) -> None:
        state = status.get("status")
        if state == "finished":
            self._last_emit = 0.0
            return
        if state != "downloading":
            return
        now = time.monotonic()
        if now - self._last_emit < _THROTTLE_SECONDS:
            return
        self._last_emit = now
        total = _number(status.get("total_bytes")) or _number(status.get("total_bytes_estimate"))
        self.out.put(
            {
                "event": "progress",
                "downloaded": _number(status.get("downloaded_bytes")) or 0.0,
                "total": total,
                "speed": _number(status.get("speed")),
                "eta": _number(status.get("eta")),
            }
        )

    def _postprocess(self, status: dict[str, Any]) -> None:
        if status.get("status") != "started":
            return
        self.out.put({"event": "postprocess", "step": str(status.get("postprocessor") or "")})

    def run(self) -> None:
        try:
            dest = Path(self.request.dest_dir)
            dest.mkdir(parents=True, exist_ok=True)
            options = build_options(
                self.request,
                format=self.request.format,
                outtmpl=str(dest / f"{self.request.id}.%(ext)s"),
                progress_hooks=[self._progress],
                postprocessor_hooks=[self._postprocess],
                overwrites=False,
            )
            # No re-encoding: `bestaudio` normally yields a pure audio container that only
            # has to be renamed. FFmpegExtractAudio is added only when the selection fell
            # back to something carrying video.
            preflight = extract_info(self.request.url, options, download=False)
            if needs_audio_extraction(preflight):
                options["postprocessors"] = [
                    {"key": "FFmpegExtractAudio", "preferredcodec": "best", "preferredquality": "0"}
                ]
            info = extract_info(self.request.url, options, download=True)
            self._finish(info)
        except BaseException as exc:
            error = (
                exc
                if isinstance(exc, ToolboxError)
                else classify_ytdlp_error(exc, url=self.request.url)
            )
            log.warning("download.failed", code=error.code.value, message=error.message)
            self.out.put(
                {
                    "event": "error",
                    "code": error.code.value,
                    "message": error.message,
                    "hint": error.hint,
                    "action": error.action,
                }
            )
        finally:
            self.out.put(_SENTINEL)

    def _finish(self, info: dict[str, Any]) -> None:
        path = downloaded_path(info)
        if path is None or not path.is_file():
            raise ValueError("yt-dlp reported no output file for this download.")
        self.out.put(
            {
                "event": "done",
                "path": str(path),
                "format_id": str(info.get("format_id") or ""),
                "codec": str(info.get("acodec") or info.get("ext") or ""),
                "size": path.stat().st_size,
            }
        )


async def _real_events(request: DownloadRequest) -> AsyncIterator[bytes]:
    out: queue.Queue[Any] = queue.Queue()
    worker = _Worker(request, out)
    thread = threading.Thread(target=worker.run, name="toolbox-download", daemon=True)
    thread.start()
    while True:
        item = await asyncio.to_thread(out.get)
        if item is _SENTINEL:
            break
        yield _line(item)


# --------------------------------------------------------------------------------------
# Fixtures mode
# --------------------------------------------------------------------------------------


async def _fixture_events(request: DownloadRequest) -> AsyncIterator[bytes]:
    """Copy the bundled sample in slices, emitting the same events as the real path."""
    entry = fixtures.select_entry(request.url)
    source = fixtures.sample_opus()
    dest_dir = Path(request.dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = dest_dir / f"{request.id}.opus"
    total = source.stat().st_size

    delay = fixture_delay_seconds()
    copied = 0
    partial = target.with_suffix(".opus.part")
    with source.open("rb") as reader, partial.open("wb") as writer:
        while True:
            chunk = reader.read(_FIXTURE_CHUNK)
            if not chunk:
                break
            writer.write(chunk)
            copied += len(chunk)
            yield _line(
                {
                    "event": "progress",
                    "downloaded": float(copied),
                    "total": float(total),
                    "speed": float(_FIXTURE_CHUNK) / delay if delay else None,
                    "eta": float(total - copied) / max(float(_FIXTURE_CHUNK), 1.0),
                }
            )
            await asyncio.sleep(delay)

    yield _line({"event": "postprocess", "step": "FixtureCopy"})
    shutil.move(str(partial), str(target))
    fixtures.record_download(target, request.url)
    log.info("download.fixture", id=request.id, path=str(target), entry=entry["id"])
    yield _line(
        {
            "event": "done",
            "path": str(target),
            "format_id": "251-fixture",
            "codec": "opus",
            "size": target.stat().st_size,
        }
    )


# --------------------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------------------


def ndjson_download(request: DownloadRequest) -> AsyncIterator[bytes]:
    """Take the download slot *now*, then stream events until the file is on disk.

    The slot is taken synchronously so that a second caller gets a real ``409 LOCKED``
    response rather than an error buried inside a ``200`` stream.
    """
    DOWNLOAD_LOCK.acquire()

    async def generate() -> AsyncIterator[bytes]:
        try:
            source = _fixture_events(request) if fixtures_enabled() else _real_events(request)
            async for chunk in source:
                yield chunk
        except ToolboxError as error:
            yield _error_line(error)
        finally:
            DOWNLOAD_LOCK.release()

    return generate()
