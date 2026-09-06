"""One test per error code, and the guarantee that every code carries a hint and an action.

The yt-dlp codes are raised from real `yt_dlp.utils` exception objects carrying the message
YouTube actually produces, because that message is the only signal the classifier has.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from yt_dlp.utils import DownloadError, ExtractorError

from toolbox.errors import (
    ERROR_CATALOG,
    ErrorCode,
    ToolboxError,
    classify_message,
    classify_ytdlp_error,
    spec_for,
)
from toolbox.lock import DOWNLOAD_LOCK
from toolbox.models import Tag, TagRequest
from toolbox.subprocesses import require_tool
from toolbox.tagging import write_tags

# The real messages, copied from what yt-dlp prints, one per catalogued yt-dlp failure.
YTDLP_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.YTDLP_BOT_CHECK: (
        "ERROR: [youtube] eZKgoOjJmrp: Sign in to confirm you're not a bot. "
        "Use --cookies-from-browser or --cookies for the authentication."
    ),
    ErrorCode.YTDLP_403: "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    ErrorCode.YTDLP_FORMAT: "ERROR: [youtube] eZKgoOjJmrp: Requested format is not available",
    ErrorCode.YTDLP_NSIG: (
        "WARNING: [youtube] eZKgoOjJmrp: nsig extraction failed: Some formats may be missing"
    ),
    ErrorCode.YTDLP_UNAVAILABLE: "ERROR: [youtube] eZKgoOjJmrp: Video unavailable",
    ErrorCode.YTDLP_AGE: (
        "ERROR: [youtube] eZKgoOjJmrp: Sign in to confirm your age. "
        "This video may be inappropriate for some users."
    ),
    ErrorCode.YTDLP_PRIVATE: "ERROR: [youtube] eZKgoOjJmrp: Private video. Sign in if you've "
    "been granted access to this video",
    ErrorCode.FFMPEG_MISSING: (
        "ERROR: You have requested merging of multiple formats but ffmpeg is not installed"
    ),
}


def test_every_code_has_a_catalog_entry():
    assert {spec.code for spec in ERROR_CATALOG} == set(ErrorCode)


def test_every_code_carries_a_hint():
    for spec in ERROR_CATALOG:
        assert spec.hint, f"{spec.code} has no hint"


@pytest.mark.parametrize(("code", "message"), sorted(YTDLP_MESSAGES.items()))
def test_a_ytdlp_exception_is_classified(code: ErrorCode, message: str):
    error = classify_ytdlp_error(DownloadError(message))
    assert error.code is code
    assert error.hint == spec_for(code).hint
    assert error.action == spec_for(code).action
    # The prefix yt-dlp adds is stripped, the cause is not.
    assert not error.message.startswith("ERROR:")


def test_an_extractor_error_is_classified_the_same_way():
    error = classify_ytdlp_error(ExtractorError("Video unavailable", video_id="eZKgoOjJmrp"))
    assert error.code is ErrorCode.YTDLP_UNAVAILABLE
    assert error.details["exception"] == "ExtractorError"


def test_an_unrecognised_message_stays_unknown():
    error = classify_ytdlp_error(DownloadError("ERROR: the internet fell over"))
    assert error.code is ErrorCode.UNKNOWN
    assert error.message == "the internet fell over"


def test_classification_is_case_insensitive():
    assert classify_message("VIDEO UNAVAILABLE") is ErrorCode.YTDLP_UNAVAILABLE


def test_the_full_sentence_form_is_classified_too():
    """What a dead watch?v= id actually returns, and what used to fall through to UNKNOWN."""
    assert classify_message("This video is unavailable") is ErrorCode.YTDLP_UNAVAILABLE


def test_locked_when_a_second_download_starts(fixture_client: TestClient, tmp_path: Path):
    body = {"url": "fixture://discovery#0", "dest_dir": str(tmp_path), "id": "held"}
    DOWNLOAD_LOCK.acquire()
    try:
        response = fixture_client.post("/download", json=body)
    finally:
        DOWNLOAD_LOCK.release()
    assert response.status_code == 409
    assert response.json()["code"] == ErrorCode.LOCKED.value
    assert response.json()["action"] == "Wait for the current download"


def test_fixture_unknown_for_an_unrecorded_url(fixture_client: TestClient):
    response = fixture_client.post("/extract", json={"url": "fixture://nope"})
    assert response.status_code == 404
    assert response.json()["code"] == ErrorCode.FIXTURE_UNKNOWN.value
    assert "discovery" in response.json()["details"]["known"]


def test_place_conflict_without_a_policy(client: TestClient, tmp_path: Path):
    src = tmp_path / "src.opus"
    dest = tmp_path / "dest.opus"
    src.write_bytes(b"a")
    dest.write_bytes(b"b")
    response = client.post("/place", json={"src": str(src), "dest": str(dest)})
    assert response.status_code == 409
    assert response.json()["code"] == ErrorCode.PLACE_CONFLICT.value


def test_tag_write_failed_on_an_unsupported_container(tmp_path: Path):
    path = tmp_path / "track.wav"
    path.write_bytes(b"RIFF")
    with pytest.raises(ToolboxError) as raised:
        write_tags(TagRequest(path=str(path), tags=[Tag(key="TITLE", value="x")]))
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED
    assert raised.value.status == 422


def test_ffmpeg_missing_when_a_binary_is_absent():
    with pytest.raises(ToolboxError) as raised:
        require_tool("definitely-not-a-real-binary")
    assert raised.value.code is ErrorCode.FFMPEG_MISSING
    assert raised.value.details["tool"] == "definitely-not-a-real-binary"


def test_the_wire_body_is_the_four_fields_the_ui_shows():
    body = ToolboxError(ErrorCode.YTDLP_BOT_CHECK).body().model_dump()
    assert set(body) == {"code", "message", "hint", "action", "details"}
    assert body["action"] == "Configure cookies"
