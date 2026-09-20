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
    f"#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t{FUTURE + 100}\tLOGIN_INFO\tvalue\n"
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
    """A jar of preferences only: the sentence has to say which half is missing."""
    jar = f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tPREF\tvalue\n"
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.ok is False
    assert result.authenticated is False
    assert any("not a YouTube session" in problem for problem in result.problems), result.problems


def test_a_jar_yt_dlp_would_not_accept_names_the_half_that_is_missing():
    """What "signed in" means is yt-dlp's rule, and the verdict now says so with its own names.

    A jar with `SAPISID` and no `LOGIN_INFO` is the shape an httpOnly-skipping exporter leaves
    behind — 25 cookies, a plausible session cookie, and yt-dlp answering "The provided YouTube
    account cookies are no longer valid. They have likely been rotated in the browser as a
    security measure." Naming the missing cookie is the difference between redoing the export
    and redoing it the same way.
    """
    without_login_info = _jar([f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tSAPISID\tvalue"])
    result = maintenance.cookies_test(CookiesTestRequest(content=without_login_info))
    assert result.authenticated is False
    assert any(
        "LOGIN_INFO is missing" in problem and "httpOnly" in problem for problem in result.problems
    ), result.problems

    without_sapisid = _jar([f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tLOGIN_INFO\tvalue"])
    result = maintenance.cookies_test(CookiesTestRequest(content=without_sapisid))
    assert result.authenticated is False
    assert any(
        "no SAPISID cookie" in problem and "__Secure-3PAPISID" in problem
        for problem in result.problems
    ), result.problems

    both_halves = _jar(
        [
            f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tLOGIN_INFO\tvalue",
            f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\t__Secure-1PAPISID\tvalue",
        ]
    )
    result = maintenance.cookies_test(CookiesTestRequest(content=both_halves))
    assert result.authenticated is True, result.problems


def test_expired_cookies_are_counted():
    jar = f".youtube.com\tTRUE\t/\tTRUE\t{PAST}\tSAPISID\tvalue\n"
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.expired == 1
    assert result.ok is False


def _jar(lines: list[str]) -> str:
    """A Netscape jar from its cookie lines, so a case reads as the cookies it carries."""
    return "# Netscape HTTP Cookie File\n" + "".join(f"{line}\n" for line in lines)


def test_a_lapsed_preference_cookie_does_not_condemn_a_live_session():
    """The owner's own jar: 25 cookies, a live session cookie, three expired preferences.

    `ok` used to require `expired == 0` — no expired cookie of any kind — so this jar was called
    "not a usable session (25 cookie(s) · 1 domain(s) · a session cookie · 3 expired)" and the
    owner was told to export a new one. Nothing about `PREF`, `SOCS` or `VISITOR_INFO1_LIVE`
    ending says anything about being logged in; only a session cookie's lapse does.
    """
    lines = [
        f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tSAPISID\tvalue",
        f"#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tLOGIN_INFO\tvalue",
    ]
    for index in range(20):
        lines.append(f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tEXTRA{index}\tvalue")
    for name in ("PREF", "SOCS", "VISITOR_INFO1_LIVE"):
        lines.append(f".youtube.com\tTRUE\t/\tTRUE\t{PAST}\t{name}\tvalue")

    result = maintenance.cookies_test(CookiesTestRequest(content=_jar(lines)))

    assert result.cookies == 25
    assert result.expired == 3
    assert result.authenticated is True
    assert result.ok is True, result.problems
    assert result.problems == []


def test_a_lapsed_session_cookie_is_refused_and_named():
    jar = _jar(
        [
            f".youtube.com\tTRUE\t/\tTRUE\t{PAST}\tSAPISID\tvalue",
            f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tPREF\tvalue",
        ]
    )
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.ok is False
    assert any("SAPISID" in problem and "expired" in problem for problem in result.problems), (
        result.problems
    )


def test_a_jar_that_never_reaches_youtube_is_refused():
    """A session cookie under `.google.com` only: yt-dlp sends a cookie to the domain it matches.

    The verdict used to be "a usable session", and every extraction then failed with
    `Sign in to confirm you're not a bot` — which reads as a YouTube problem, not as the jar.
    """
    jar = _jar(
        [
            f".google.com\tTRUE\t/\tTRUE\t{FUTURE}\tSAPISID\tvalue",
            f".google.com\tTRUE\t/\tTRUE\t{FUTURE}\tLOGIN_INFO\tvalue",
        ]
    )
    result = maintenance.cookies_test(CookiesTestRequest(content=jar))
    assert result.authenticated is True, "the session cookie really is there"
    assert result.ok is False, "but yt-dlp will never send it to youtube.com"
    assert any("youtube.com" in problem for problem in result.problems), result.problems


def test_a_refused_jar_always_says_why():
    """The invariant `mm tools status` broke: `ok == False` with nothing naming the cause.

    Every path to a refusal — no jar, no session cookie, a lapsed session, a jar YouTube never
    sees, a jar that does not parse — has to leave at least one sentence behind. An empty
    `problems` beside `ok == False` is the defect, whatever the reason happens to be.
    """
    jars = {
        "empty": "# nothing here\n",
        "no session cookie": _jar([f".youtube.com\tTRUE\t/\tTRUE\t{FUTURE}\tPREF\tvalue"]),
        "lapsed session": _jar([f".youtube.com\tTRUE\t/\tTRUE\t{PAST}\tSAPISID\tvalue"]),
        "google only": _jar([f".google.com\tTRUE\t/\tTRUE\t{FUTURE}\tSAPISID\tvalue"]),
        "unparseable": "this line has no tabs\n",
    }
    for name, jar in jars.items():
        result = maintenance.cookies_test(CookiesTestRequest(content=jar))
        assert result.ok is False, name
        assert result.problems, f"{name}: refused without saying why"


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
