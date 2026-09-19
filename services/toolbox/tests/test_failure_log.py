"""What a failure says in `docker logs` (`docs/deploy.md` § 7).

The complaint was an import that produced nothing and a `docker logs` that said nothing either:
yt-dlp had named every refusal on the way past, the toolbox held the sentences in memory, and
the line that reached the log was the summary. These tests pin that the whole thing reaches the
log — at `error`, the level the operator greps for — and that the cookie jar's *values* never do.
"""

from __future__ import annotations

import json
import logging
import queue
from pathlib import Path
from typing import Any

import pytest
import structlog
from fastapi.testclient import TestClient

import toolbox.download as download_module
from toolbox import extract as extract_module
from toolbox.config import LOG_LEVELS, log_level, log_level_number
from toolbox.download import _Worker  # pyright: ignore[reportPrivateUsage]
from toolbox.errors import ErrorCode, ToolboxError, describe_failure
from toolbox.models import DownloadRequest, YtdlpOptions
from toolbox.ytdlp import ExtractionLog, cookie_secrets, cookie_shape, jar_secret_values

REFUSAL = "Sign in to confirm you're not a bot."
JAR = (
    "# Netscape HTTP Cookie File\n"
    ".youtube.com\tTRUE\t/\tFALSE\t9999999999\tSAPISID\tSECRET-VALUE\n"
    ".youtube.com\tTRUE\t/\tFALSE\t9999999999\t__Secure-3PSID\tOTHER-VALUE\n"
)
GAPS = {
    "url": "https://www.youtube.com/playlist?list=OLAK5uy",
    "unreadable": [{"position": index, "reason": REFUSAL} for index in range(15)],
}


class _Recorder:
    """Where `ExtractionLog` writes, so its gating can be read without structlog in the way."""

    def __init__(self) -> None:
        self.lines: list[tuple[str, str]] = []

    def _keep(self, level: str, kwargs: dict[str, Any]) -> None:
        self.lines.append((level, str(kwargs["line"])))

    def debug(self, event: str, **kwargs: Any) -> None:
        self._keep("debug", kwargs)

    def info(self, event: str, **kwargs: Any) -> None:
        self._keep("info", kwargs)

    def warning(self, event: str, **kwargs: Any) -> None:
        self._keep("warning", kwargs)

    def error(self, event: str, **kwargs: Any) -> None:
        self._keep("error", kwargs)


def test_yt_dlp_chatter_is_only_forwarded_when_it_is_asked_for() -> None:
    quiet_recorder = _Recorder()
    quiet = ExtractionLog(quiet_recorder)
    quiet.debug("Loaded 1914 extractors")
    quiet.error("ERROR: [youtube] abc: Video unavailable")
    assert quiet_recorder.lines == [("error", "ERROR: [youtube] abc: Video unavailable")]

    loud_recorder = _Recorder()
    loud = ExtractionLog(loud_recorder, verbose=True)
    loud.debug("Loaded 1914 extractors")
    loud.info("Downloading 1 format(s)")
    assert [level for level, _ in loud_recorder.lines] == ["debug", "info"]


def test_the_level_vocabulary_is_the_one_the_web_reads(monkeypatch: pytest.MonkeyPatch) -> None:
    assert set(LOG_LEVELS) == {"debug", "info", "warn", "error", "silent"}
    monkeypatch.setenv("MM_LOG_LEVEL", "DEBUG")
    assert (log_level(), log_level_number()) == ("debug", logging.DEBUG)
    monkeypatch.setenv("MM_LOG_LEVEL", "silent")
    assert log_level_number() > logging.CRITICAL
    monkeypatch.setenv("MM_LOG_LEVEL", "LOUD")
    assert (log_level(), log_level_number()) == ("info", logging.INFO)
    monkeypatch.delenv("MM_LOG_LEVEL")
    assert log_level_number() == logging.INFO


def test_the_gap_reasons_are_one_counted_sentence_not_fifteen_lines() -> None:
    error = ToolboxError(ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE, details=dict(GAPS))
    assert describe_failure(error)["reasons"] == [f"{REFUSAL} (15\u00d7)"]


def test_a_failed_request_logs_what_the_console_only_summarises(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from yt_dlp.utils import DownloadError

    def boom(*_: object, **__: object) -> dict[str, Any]:
        raise DownloadError(f"ERROR: [youtube] dQw4w9WgXcQ: {REFUSAL}")

    monkeypatch.setattr(extract_module, "extract_info", boom)
    with structlog.testing.capture_logs() as captured:
        response = client.post(
            "/extract",
            json={"url": "https://youtu.be/dQw4w9WgXcQ", "cookies_content": JAR},
        )

    assert response.status_code == 403
    events = [entry for entry in captured if entry.get("event") == "request.failed"]
    assert len(events) == 1, f"expected one failure line, got {captured!r}"
    failure = events[0]
    assert failure["log_level"] == "error"
    assert failure["code"] == "YTDLP_BOT_CHECK"
    assert REFUSAL in failure["message"]
    assert failure["action"] == "Configure cookies"
    # Which jar this attempt carried, without a byte of its content.
    assert failure["details"]["cookies"] == {"mode": "inline", "cookies": 2, "bytes": len(JAR)}
    assert "DownloadError" in failure["cause"]
    assert "SECRET-VALUE" not in json.dumps(captured)


def test_a_download_failure_says_which_jar_and_what_yt_dlp_said(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from yt_dlp.utils import DownloadError

    def boom(_url: str, options: dict[str, Any], **_: object) -> dict[str, Any]:
        # yt-dlp reports through the `logger` option it was given: this is the line that used to
        # die inside the process, and the reason the worker now hands over a logger at all.
        options["logger"].error("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable")
        raise DownloadError("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable")

    monkeypatch.setattr(download_module, "extract_info", boom)
    worker = _Worker(
        DownloadRequest(url="https://youtu.be/x", dest_dir=str(tmp_path), id="trk"),
        queue.Queue(),
    )
    with structlog.testing.capture_logs() as captured:
        worker.run()

    spoken = [entry["line"] for entry in captured if entry.get("event") == "ytdlp"]
    assert spoken == ["ERROR: [youtube] dQw4w9WgXcQ: Video unavailable"]

    events = [entry for entry in captured if entry.get("event") == "download.failed"]
    assert len(events) == 1, f"expected one download failure line, got {captured!r}"
    assert events[0]["log_level"] == "error"
    assert events[0]["code"] == "YTDLP_UNAVAILABLE"
    assert events[0]["details"]["cookies"] == {"mode": "none"}
    assert events[0]["details"]["ytdlp"] == ["[youtube] dQw4w9WgXcQ: Video unavailable"]


def test_the_jar_values_are_stripped_out_of_every_forwarded_line() -> None:
    assert jar_secret_values(JAR) == ["SECRET-VALUE", "OTHER-VALUE"]
    recorder = _Recorder()
    errors = ExtractionLog(recorder, verbose=True)
    errors.add_secrets(cookie_secrets(YtdlpOptions(cookies_content=JAR)))
    errors.debug("urllib request headers: {'Cookie': 'SAPISID=SECRET-VALUE; a=OTHER-VALUE'}")
    errors.error(f"ERROR: [youtube] abc: {REFUSAL} SAPISID=SECRET-VALUE")

    printed = json.dumps(recorder.lines)
    assert "SECRET-VALUE" not in printed
    assert "OTHER-VALUE" not in printed
    assert "<redacted>" in printed


def test_the_shape_of_a_jar_is_readable_without_its_content(tmp_path: Path) -> None:
    inline = cookie_shape(YtdlpOptions(cookies_content=JAR))
    assert inline == {"mode": "inline", "cookies": 2, "bytes": len(JAR)}
    assert cookie_shape(YtdlpOptions()) == {"mode": "none"}

    on_disk = tmp_path / "cookies.txt"
    on_disk.write_text(JAR, encoding="utf-8")
    shape = cookie_shape(YtdlpOptions(cookies=str(on_disk)))
    assert shape == {
        "mode": "path",
        "path": str(on_disk),
        "exists": True,
        "cookies": 2,
        "bytes": len(JAR),
    }

    absent = tmp_path / "absent.txt"
    assert cookie_shape(YtdlpOptions(cookies=str(absent))) == {
        "mode": "path",
        "path": str(absent),
        "exists": False,
    }
    assert "SECRET-VALUE" not in json.dumps([inline, shape])
