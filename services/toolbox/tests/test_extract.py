"""`POST /extract`: recorded fixtures, and the projection of a mocked yt-dlp info dict."""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

from toolbox import extract as extract_module
from toolbox.errors import ErrorCode
from toolbox.models import ExtractRequest
from toolbox.ytdlp import needs_audio_extraction, result_from_info

INFO_VIDEO: dict[str, Any] = {
    "id": "eZKgoOjJmrp",
    "title": "One More Time",
    "duration": 320.0,
    "uploader": "Daft Punk - Topic",
    "track": "One More Time",
    "artist": "Daft Punk",
    "album": "Discovery",
    "release_year": 2001,
    "description": "Provided to YouTube by Parlophone\n\nOne More Time · Daft Punk",
    "webpage_url": "https://www.youtube.com/watch?v=eZKgoOjJmrp",
    "thumbnails": [{"url": "https://i.ytimg.com/vi/x/hq.jpg", "width": 480, "height": 360}],
    "vcodec": "none",
    "acodec": "opus",
}


def test_the_discovery_fixture_has_fifteen_entries(fixture_client: TestClient):
    """Fourteen tracks plus one alternate upload, so `extra_videos` is reachable offline."""
    payload = fixture_client.post("/extract", json={"url": "fixture://discovery"}).json()
    assert payload["kind"] == "playlist"
    assert len(payload["entries"]) == 15
    assert payload["entries"][0]["title"] == "One More Time"
    assert payload["entries"][14]["title"] == "One More Time (Radio Edit)"


def test_fixture_entries_carry_the_signals_the_matcher_needs(fixture_client: TestClient):
    entry = fixture_client.post("/extract", json={"url": "fixture://discovery"}).json()["entries"][
        0
    ]
    assert entry["duration"] == 320.0
    assert (entry["track"], entry["artist"], entry["album"]) == (
        "One More Time",
        "Daft Punk",
        "Discovery",
    )
    assert entry["release_year"] == 2001
    assert "Provided to YouTube by" in entry["description"]
    assert "Released on: 2001-03-12" in entry["description"]
    assert entry["thumbnails"]


def test_a_single_video_fixture_is_a_video(fixture_client: TestClient):
    payload = fixture_client.post("/extract", json={"url": "fixture://skinny-love"}).json()
    assert payload["kind"] == "video"
    assert len(payload["entries"]) == 1


def test_currents_fixture(fixture_client: TestClient):
    payload = fixture_client.post("/extract", json={"url": "fixture://currents"}).json()
    assert len(payload["entries"]) == 13


def test_a_fragment_selects_one_entry(fixture_client: TestClient):
    payload = fixture_client.post("/extract", json={"url": "fixture://discovery#4"}).json()
    assert payload["kind"] == "video"
    assert payload["entries"][0]["title"] == "Crescendolls"


def test_an_out_of_range_fragment_is_a_fixture_error(fixture_client: TestClient):
    response = fixture_client.post("/extract", json={"url": "fixture://discovery#99"})
    assert response.status_code == 404
    assert response.json()["code"] == ErrorCode.FIXTURE_UNKNOWN.value


def test_fixtures_mode_refuses_to_reach_the_network(fixture_client: TestClient):
    response = fixture_client.post(
        "/extract", json={"url": "https://www.youtube.com/watch?v=eZKgoOjJmrp"}
    )
    assert response.status_code == 404
    assert response.json()["code"] == ErrorCode.FIXTURE_UNKNOWN.value


def test_a_non_youtube_url_is_rejected_without_calling_yt_dlp(client: TestClient):
    response = client.post("/extract", json={"url": "https://example.com/song.mp3"})
    assert response.status_code == 422
    assert response.json()["code"] == ErrorCode.YTDLP_UNAVAILABLE.value


def test_a_mocked_info_dict_is_projected(monkeypatch: pytest.MonkeyPatch):
    def fake(*_: object, **__: object) -> dict[str, Any]:
        return INFO_VIDEO

    monkeypatch.setattr(extract_module, "extract_info", fake)
    result = extract_module.extract(
        ExtractRequest(url="https://www.youtube.com/watch?v=eZKgoOjJmrp")
    )
    assert result.kind == "video"
    entry = result.entries[0]
    assert (entry.id, entry.title, entry.duration) == ("eZKgoOjJmrp", "One More Time", 320.0)
    assert entry.thumbnails[0].width == 480


def test_a_playlist_info_dict_numbers_its_entries():
    result = result_from_info({"title": "Discovery", "entries": [INFO_VIDEO, INFO_VIDEO]})
    assert result.kind == "playlist"
    assert [entry.index for entry in result.entries] == [0, 1]


def test_a_yt_dlp_failure_becomes_a_catalogued_error(monkeypatch: pytest.MonkeyPatch):
    from yt_dlp.utils import DownloadError

    def boom(*_: object, **__: object) -> dict[str, Any]:
        raise DownloadError("ERROR: [youtube] x: Video unavailable")

    monkeypatch.setattr(extract_module, "extract_info", boom)
    from toolbox.errors import ToolboxError

    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url="https://youtu.be/eZKgoOjJmrp"))
    assert raised.value.code is ErrorCode.YTDLP_UNAVAILABLE


@pytest.mark.parametrize(
    ("info", "expected"),
    [
        ({"vcodec": "none", "acodec": "opus"}, False),
        ({"vcodec": "vp9"}, True),
        ({"requested_formats": [{"vcodec": "none"}, {"vcodec": "avc1"}]}, True),
        ({"requested_formats": [{"vcodec": "none"}]}, False),
        ({}, False),
    ],
)
def test_audio_extraction_is_only_added_when_the_container_carries_video(
    info: dict[str, Any], expected: bool
):
    assert needs_audio_extraction(info) is expected
