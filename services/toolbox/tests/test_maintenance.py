"""`/ytdlp/update`, `/ytdlp/selftest`, `/cookies/test`, and the LRC parser they lean on."""

from __future__ import annotations

import datetime as dt
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from toolbox import maintenance
from toolbox.lyrics import LrcLine, parse_lrc, plain_text
from toolbox.models import CookiesTestRequest, SelfTestRequest
from toolbox.ytmusic import build_query, candidate_from_result

FUTURE = int((dt.datetime.now(tz=dt.UTC) + dt.timedelta(days=30)).timestamp())
PAST = int((dt.datetime.now(tz=dt.UTC) - dt.timedelta(days=1)).timestamp())

SESSION_JAR = (
    "# Netscape HTTP Cookie File\n"
    f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tSAPISID\tvalue\n"
    f"#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t{FUTURE + 100}\t__Secure-3PSID\tvalue\n"
    ".google.com\tTRUE\t/\tTRUE\t0\tSESSION_ONLY\tvalue\n"
)


# --------------------------------------------------------------------------------------
# Cookies
# --------------------------------------------------------------------------------------


def test_a_session_jar_is_usable():
    result = maintenance.cookies_test(CookiesTestRequest(content=SESSION_JAR))
    assert result.ok is True
    assert result.cookies == 3
    assert result.authenticated is True
    assert result.domains == [".google.com", ".youtube.com"]
    assert result.expires_at is not None
    assert result.expired == 0
    assert result.problems == []


def test_a_jar_without_a_session_cookie_is_not_usable():
    jar = f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tPREF\tvalue\n"
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.ok is False
    assert result.authenticated is False
    assert any("session cookie" in problem for problem in result.problems)


def test_expired_cookies_are_counted():
    jar = f".youtube.com\tTRUE\t/\tTRUE\t{PAST}\tSAPISID\tvalue\n"
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.expired == 1
    assert result.ok is False


def test_malformed_lines_are_reported_not_swallowed():
    jar = "this line has no tabs\n" + SESSION_JAR
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert any("7 tab-separated fields" in problem for problem in result.problems)
    assert result.cookies == 3


def test_an_empty_jar_says_so():
    result = maintenance.cookies_test(CookiesTestRequest(content="# nothing here\n"))
    assert result.ok is False
    assert "no cookies found" in result.problems


def test_cookies_can_be_read_from_a_file(client: TestClient, tmp_path: Path):
    path = tmp_path / "cookies.txt"
    path.write_text(SESSION_JAR, encoding="utf-8")
    response = client.post("/cookies/test", json={"path": str(path)})
    assert response.json()["ok"] is True


def test_cookies_needs_a_path_or_content(client: TestClient):
    assert client.post("/cookies/test", json={}).status_code == 422


# --------------------------------------------------------------------------------------
# Self-test and update
# --------------------------------------------------------------------------------------


def test_the_selftest_skips_the_network_by_default(offline: None):
    result = maintenance.selftest(SelfTestRequest())
    names = [check.name for check in result.checks]
    assert names == ["yt-dlp", "ffmpeg", "fpcalc", "rsgain", "extract"]
    extract = next(check for check in result.checks if check.name == "extract")
    assert extract.ok is True
    assert "skipped" in extract.detail
    assert next(check for check in result.checks if check.name == "yt-dlp").ok is True


def test_the_selftest_reports_a_download_failure_without_raising(
    offline: None, monkeypatch: pytest.MonkeyPatch
):
    from yt_dlp.utils import DownloadError

    def boom(*_: object, **__: object) -> dict[str, Any]:
        raise DownloadError("ERROR: [youtube] x: Video unavailable")

    monkeypatch.setattr(maintenance, "extract_info", boom)
    result = maintenance.selftest(SelfTestRequest(network=True, url="https://youtu.be/x"))
    extract = next(check for check in result.checks if check.name == "extract")
    assert extract.ok is False
    assert "YTDLP_UNAVAILABLE" in extract.detail
    assert result.ok is False


def test_fixtures_mode_never_updates_yt_dlp(fixture_client: TestClient):
    payload = fixture_client.post("/ytdlp/update").json()
    assert payload["method"] == "skipped"
    assert payload["changed"] is False
    assert payload["ok"] is True


def test_a_failing_updater_is_reported_not_raised(offline: None, monkeypatch: pytest.MonkeyPatch):
    def fake_run(*_: object, **__: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess([], 1, stdout="", stderr="no network")

    monkeypatch.setattr(maintenance.subprocess, "run", fake_run)
    result = maintenance.update_ytdlp()
    assert result.ok is False
    assert "no network" in result.output


def test_a_successful_update_reports_the_new_version(
    offline: None, monkeypatch: pytest.MonkeyPatch
):
    def fake_run(*_: object, **__: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess([], 0, stdout="ok", stderr="")

    def fake_version() -> str:
        return "2099.01.01"

    monkeypatch.setattr(maintenance.subprocess, "run", fake_run)
    monkeypatch.setattr(maintenance, "_version_on_disk", fake_version)
    result = maintenance.update_ytdlp()
    assert result.ok is True
    assert result.current == "2099.01.01"
    assert result.changed is True


# --------------------------------------------------------------------------------------
# LRC
# --------------------------------------------------------------------------------------


def test_lrc_parsing_keeps_timestamps_in_milliseconds():
    assert parse_lrc("[00:12.00]One more time\n[01:02.50]Again") == [
        LrcLine(12000, "One more time"),
        LrcLine(62500, "Again"),
    ]


def test_lrc_metadata_lines_are_dropped():
    assert parse_lrc("[ar:Daft Punk]\n[ti:One More Time]\n[00:01.00]Go") == [LrcLine(1000, "Go")]


def test_a_line_with_several_timestamps_repeats():
    assert parse_lrc("[00:10.00][00:20.00]Chorus") == [
        LrcLine(10000, "Chorus"),
        LrcLine(20000, "Chorus"),
    ]


def test_lines_come_back_in_time_order():
    assert [line.at_ms for line in parse_lrc("[00:20.00]b\n[00:10.00]a")] == [10000, 20000]


def test_plain_text_strips_the_timestamps():
    assert plain_text("[00:12.00]One more time\n[00:15.50]Celebrate") == (
        "One more time\nCelebrate"
    )


def test_plain_text_passes_unsynced_lyrics_through():
    assert plain_text("Just words\nno timestamps") == "Just words\nno timestamps"


# --------------------------------------------------------------------------------------
# YouTube Music
# --------------------------------------------------------------------------------------


def test_the_query_is_artist_album_title():
    from toolbox.models import YtMusicSearchRequest

    assert build_query(YtMusicSearchRequest(artist="Daft Punk", album="Discovery")) == (
        "Daft Punk Discovery"
    )


def test_an_album_result_keeps_the_olak_playlist():
    candidate = candidate_from_result(
        {
            "resultType": "album",
            "title": "Discovery",
            "year": "2001",
            "artists": [{"name": "Daft Punk", "id": "UC123"}],
            "playlistId": "OLAK5uy_abc",
            "browseId": "MPREb_abc",
            "thumbnails": [{"url": "https://i.ytimg.com/x.jpg", "width": 60, "height": 60}],
        }
    )
    assert candidate is not None
    assert candidate.kind == "album"
    assert candidate.playlist_id == "OLAK5uy_abc"
    assert candidate.url == "https://music.youtube.com/playlist?list=OLAK5uy_abc"
    assert candidate.artist == "Daft Punk"
    assert candidate.year == 2001


def test_a_song_result_keeps_the_video_id():
    candidate = candidate_from_result(
        {
            "resultType": "song",
            "title": "Skinny Love",
            "videoId": "abc123",
            "artists": [{"name": "Bon Iver"}],
            "album": {"name": "For Emma, Forever Ago"},
            "duration_seconds": 238,
        }
    )
    assert candidate is not None
    assert candidate.kind == "song"
    assert candidate.video_id == "abc123"
    assert candidate.album == "For Emma, Forever Ago"
    assert candidate.duration == 238.0


def test_a_kind_we_do_not_queue_is_dropped():
    assert candidate_from_result({"resultType": "artist", "title": "Daft Punk"}) is None


def test_the_ytmusic_fixture_finds_the_album(fixture_client: TestClient):
    payload = fixture_client.post(
        "/ytmusic/search", json={"artist": "Tame Impala", "album": "Currents"}
    ).json()
    assert payload["query"] == "Tame Impala Currents"
    assert payload["candidates"][0]["playlist_id"].startswith("OLAK5uy_")
    assert payload["candidates"][0]["track_count"] == 13
