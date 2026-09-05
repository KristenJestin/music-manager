"""`POST /download`: the NDJSON stream, the single slot, and the mocked yt-dlp path."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from httpx2 import Client
from yt_dlp.utils import DownloadError

from toolbox import download as download_module
from toolbox.errors import ErrorCode
from toolbox.lock import DOWNLOAD_LOCK


def events(client: TestClient, body: dict[str, Any]) -> list[dict[str, Any]]:
    with client.stream("POST", "/download", json=body) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("application/x-ndjson")
        return [json.loads(line) for line in response.iter_lines() if line.strip()]


# --------------------------------------------------------------------------------------
# Fixtures mode
# --------------------------------------------------------------------------------------


def test_a_fixture_download_streams_progress_then_done(fixture_client: TestClient, tmp_path: Path):
    stream = events(
        fixture_client,
        {"url": "fixture://discovery#0", "dest_dir": str(tmp_path), "id": "trk1"},
    )
    kinds = [event["event"] for event in stream]
    assert kinds[0] == "progress"
    assert "postprocess" in kinds
    assert kinds[-1] == "done"

    done = stream[-1]
    written = Path(done["path"])
    assert written.name == "trk1.opus"
    assert written.is_file()
    assert done["size"] == written.stat().st_size
    assert done["codec"] == "opus"

    progress = [event for event in stream if event["event"] == "progress"]
    assert progress[-1]["downloaded"] == progress[-1]["total"]
    assert all(event["total"] == done["size"] for event in progress)


def test_no_part_file_survives_a_fixture_download(fixture_client: TestClient, tmp_path: Path):
    events(fixture_client, {"url": "fixture://currents#2", "dest_dir": str(tmp_path), "id": "c"})
    assert not list(tmp_path.glob("*.part"))


def test_the_fixture_download_records_which_scenario_produced_the_file(
    fixture_client: TestClient, tmp_path: Path
):
    """`?fp=mismatch` has to survive as far as /fingerprint, offline."""
    body = {"url": "fixture://discovery?fp=mismatch#0", "dest_dir": str(tmp_path), "id": "m"}
    path = events(fixture_client, body)[-1]["path"]
    result = fixture_client.post("/fingerprint", json={"path": path}).json()
    assert result["candidates"][0]["title"] == "Aerodynamic"

    plain = {"url": "fixture://discovery#0", "dest_dir": str(tmp_path), "id": "p"}
    plain_path = events(fixture_client, plain)[-1]["path"]
    agreed = fixture_client.post("/fingerprint", json={"path": plain_path}).json()
    assert agreed["candidates"][0]["title"] == "One More Time"


def test_an_unknown_fixture_ends_the_stream_with_an_error_event(
    fixture_client: TestClient, tmp_path: Path
):
    stream = events(fixture_client, {"url": "fixture://nope", "dest_dir": str(tmp_path), "id": "x"})
    assert stream[-1]["event"] == "error"
    assert stream[-1]["code"] == ErrorCode.FIXTURE_UNKNOWN.value
    assert stream[-1]["hint"]


# --------------------------------------------------------------------------------------
# The single download slot
# --------------------------------------------------------------------------------------


def test_a_second_concurrent_download_is_refused(
    fixtures_mode: None,
    live_server: str,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """Two simultaneous POST /download: the second gets 409 LOCKED, not a queued 200.

    Driven against a real uvicorn over real HTTP, because `TestClient` serialises requests
    and could never show two of them overlapping. The fixture download is slowed to a
    quarter-second per slice so the second request provably arrives mid-stream.
    """
    monkeypatch.setenv("MM_TOOLBOX_FIXTURE_DELAY_MS", "250")

    with Client(base_url=live_server, timeout=60) as http:
        body = {"url": "fixture://discovery#0", "dest_dir": str(tmp_path), "id": "slow"}
        with http.stream("POST", "/download", json=body) as streaming:
            assert streaming.status_code == 200
            lines = streaming.iter_lines()
            assert json.loads(next(lines))["event"] == "progress"
            assert DOWNLOAD_LOCK.held is True

            second = http.post(
                "/download",
                json={"url": "fixture://discovery#1", "dest_dir": str(tmp_path), "id": "second"},
            )
            assert second.status_code == 409
            assert second.json()["code"] == ErrorCode.LOCKED.value
            assert second.json()["hint"] == "The toolbox downloads one file at a time, on purpose."
            assert not (tmp_path / "second.opus").exists()

            rest = [json.loads(line) for line in lines if line.strip()]

        assert rest[-1]["event"] == "done"
        assert DOWNLOAD_LOCK.held is False
        assert (tmp_path / "slow.opus").is_file()

        # The slot is free again, so the download that was refused now goes through.
        monkeypatch.setenv("MM_TOOLBOX_FIXTURE_DELAY_MS", "0")
        again = http.post(
            "/download",
            json={"url": "fixture://discovery#1", "dest_dir": str(tmp_path), "id": "second"},
        )
        assert again.status_code == 200
        assert json.loads(again.text.splitlines()[-1])["event"] == "done"


def test_the_slot_is_released_after_a_download(fixture_client: TestClient, tmp_path: Path):
    events(fixture_client, {"url": "fixture://discovery#0", "dest_dir": str(tmp_path), "id": "a"})
    assert DOWNLOAD_LOCK.held is False
    assert fixture_client.get("/health").json()["downloading"] is False


def test_health_reports_the_slot_while_it_is_taken(fixture_client: TestClient):
    DOWNLOAD_LOCK.acquire()
    try:
        assert fixture_client.get("/health").json()["downloading"] is True
    finally:
        DOWNLOAD_LOCK.release()


# --------------------------------------------------------------------------------------
# The real path, with yt-dlp mocked
# --------------------------------------------------------------------------------------


def test_the_real_path_reports_progress_and_the_file_from_the_info_dict(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The written path comes out of the info dict — never out of stdout (the v1 bug)."""
    target = tmp_path / "trk.opus"

    def fake_extract_info(
        _url: str, options: Mapping[str, Any], *, download: bool = False
    ) -> dict[str, Any]:
        if not download:
            return {"vcodec": "none", "acodec": "opus"}
        for hook in options["progress_hooks"]:
            hook(
                {
                    "status": "downloading",
                    "downloaded_bytes": 512,
                    "total_bytes": 1024,
                    "speed": 128.0,
                    "eta": 4,
                }
            )
        for hook in options["postprocessor_hooks"]:
            hook({"status": "started", "postprocessor": "FFmpegMetadata"})
        target.write_bytes(b"x" * 1024)
        return {
            "requested_downloads": [{"filepath": str(target)}],
            "format_id": "251",
            "acodec": "opus",
        }

    monkeypatch.setattr(download_module, "extract_info", fake_extract_info)
    stream = events(
        client,
        {"url": "https://youtu.be/eZKgoOjJmrp", "dest_dir": str(tmp_path), "id": "trk"},
    )

    progress = [event for event in stream if event["event"] == "progress"]
    assert progress[0] == {
        "event": "progress",
        "downloaded": 512.0,
        "total": 1024.0,
        "speed": 128.0,
        "eta": 4.0,
    }
    assert {"event": "postprocess", "step": "FFmpegMetadata"} in stream
    assert stream[-1]["path"] == str(target)
    assert stream[-1]["format_id"] == "251"
    assert stream[-1]["size"] == 1024


def test_a_yt_dlp_failure_becomes_an_error_event(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    def boom(*_: object, **__: object) -> dict[str, Any]:
        raise DownloadError("ERROR: [youtube] eZKgoOjJmrp: Sign in to confirm you're not a bot")

    monkeypatch.setattr(download_module, "extract_info", boom)
    stream = events(client, {"url": "https://youtu.be/x", "dest_dir": str(tmp_path), "id": "trk"})
    assert stream == [
        {
            "event": "error",
            "code": ErrorCode.YTDLP_BOT_CHECK.value,
            "message": "Sign in to confirm you're not a bot",
            "hint": "YouTube challenges anonymous or datacenter IPs.",
            "action": "Configure cookies",
        }
    ]
    assert DOWNLOAD_LOCK.held is False


def test_continue_is_always_on_and_the_output_template_uses_the_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
):
    captured: dict[str, Any] = {}

    def capture(_url: str, options: Mapping[str, Any], *, download: bool = False) -> Any:
        captured.update(options)
        if download:
            raise DownloadError("ERROR: stop here")
        return {"vcodec": "none"}

    monkeypatch.setattr(download_module, "extract_info", capture)
    from toolbox.models import DownloadRequest

    worker = download_module._Worker(  # pyright: ignore[reportPrivateUsage]
        DownloadRequest(url="https://youtu.be/x", dest_dir=str(tmp_path), id="trk"),
        __import__("queue").Queue(),
    )
    worker.run()
    assert captured["continuedl"] is True
    assert captured["outtmpl"].endswith("trk.%(ext)s")
    assert captured["format"] == "bestaudio"
