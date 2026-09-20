"""`POST /extract`: recorded fixtures, and the projection of a mocked yt-dlp info dict."""

from __future__ import annotations

from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

from toolbox import extract as extract_module
from toolbox.config import fixture_extract_delay_seconds
from toolbox.errors import ErrorCode, ToolboxError, spec_for
from toolbox.models import ExtractRequest
from toolbox.ytdlp import result_from_info

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


# ----------------------------------------------------------------------------------
# flat extraction and the watched-source fixture
# ----------------------------------------------------------------------------------


def test_a_listing_always_tolerates_a_dead_entry_and_flat_only_adds_the_stub_mode():
    from toolbox.extract import listing_options

    # `ignoreerrors` is on for **both**: it used to be flat mode's alone, which is why an
    # ordinary playlist still died on its first unreadable entry.
    assert listing_options(False) == {"ignoreerrors": True}
    assert listing_options(True) == {"ignoreerrors": True, "extract_flat": "in_playlist"}


def test_the_watched_fixture_grows_by_exactly_one_entry_between_snapshots(
    fixture_client: TestClient,
):
    """The whole point of the recording: yesterday, then today with one video more."""
    first = fixture_client.post(
        "/extract", json={"url": "fixture://watched?snapshot=1", "flat": True}
    ).json()
    second = fixture_client.post(
        "/extract", json={"url": "fixture://watched?snapshot=2", "flat": True}
    ).json()

    assert len(first["entries"]) == 3
    assert len(second["entries"]) == 4
    before = {entry["id"] for entry in first["entries"]}
    after = {entry["id"] for entry in second["entries"]}
    assert after - before == {"wsvCCCCCCCC"}
    assert before - after == set()


def test_a_flat_entry_carries_the_listing_fields_and_nothing_more(fixture_client: TestClient):
    entries = fixture_client.post(
        "/extract", json={"url": "fixture://watched?snapshot=2", "flat": True}
    ).json()["entries"]
    first = entries[0]
    assert first["id"] == "wsvAAAAAAAA"
    assert first["duration"] == 202.0
    assert first["webpage_url"] == "fixture://skinny-love"
    assert first["playlist_index"] == 1
    assert first["availability"] == "public"
    # A flat call does not fetch the video, so it cannot know any of these.
    assert first["description"] is None
    assert first["album"] is None
    assert first["thumbnails"] == []


def test_an_unreachable_entry_is_marked_rather_than_failing_the_scan(fixture_client: TestClient):
    entries = fixture_client.post(
        "/extract", json={"url": "fixture://watched?snapshot=1", "flat": True}
    ).json()["entries"]
    private = [entry for entry in entries if entry["unavailable"]]
    assert len(private) == 1
    assert private[0]["availability"] == "private"
    assert private[0]["duration"] is None
    # The reachable ones came back regardless — that is the property that matters.
    assert len([entry for entry in entries if not entry["unavailable"]]) == 2


def test_an_unknown_snapshot_is_a_fixture_error(fixture_client: TestClient):
    response = fixture_client.post(
        "/extract", json={"url": "fixture://watched?snapshot=9", "flat": True}
    )
    assert response.json()["code"] == ErrorCode.FIXTURE_UNKNOWN.value


def test_a_private_placeholder_is_recognised_without_an_availability_field():
    from toolbox.ytdlp import is_unavailable

    assert is_unavailable({"id": "abc", "title": "[Private video]"})
    assert is_unavailable({"id": "abc", "title": "Song", "availability": "subscriber_only"})
    assert is_unavailable({"id": "", "title": "Song"})
    assert not is_unavailable({"id": "abc", "title": "Song", "availability": "public"})


def test_a_flat_playlist_numbers_the_entries_it_could_read(monkeypatch: pytest.MonkeyPatch):
    """`ignoreerrors` hands back `None` for an entry it gave up on; it must not shift the rest."""
    result = result_from_info({"title": "Watched", "entries": [INFO_VIDEO, None, INFO_VIDEO]})
    assert [entry.index for entry in result.entries] == [0, 1]


# ----------------------------------------------------------------------------------
# a playlist that lost one entry — the defect of 2026-09-17
# ----------------------------------------------------------------------------------
#
# The owner's evidence: `GET /tools/url` on an `OLAK5uy_…` album answered `entries: 0` and
# "This video is not available", while `yt-dlp --flat-playlist --ignore-errors` listed all
# twenty titles. One dead entry cancelled the extraction of the other nineteen, and twenty
# playlists were filed as "vanished from YouTube" on the strength of it.
#
# These tests drive the **full** extraction — not the flat mode the tolerance used to be
# scoped to — through a fake `YoutubeDL`, so `extract()` runs whole: the logger really is
# wired in, `extract_info` really refuses an empty info dict, and the gap really comes out of
# `result_from_info`.


class _FakeYoutubeDL:
    """Enough of yt-dlp to run :func:`toolbox.ytdlp.extract_info` for real.

    ``_PLAN`` is what this instance will do: the messages it reports through the logger it was
    handed — which is how `ignoreerrors` behaves, an error on stderr instead of an exception —
    and the info dict it then returns, ``None`` for "nothing came back at all".
    """

    _PLAN: tuple[list[str], dict[str, Any] | None] = ([], None)

    def __init__(self, params: dict[str, Any]) -> None:
        self.params = params

    def __enter__(self) -> _FakeYoutubeDL:
        return self

    def __exit__(self, *_: object) -> bool:
        return False

    def extract_info(self, _url: str, download: bool = False) -> dict[str, Any] | None:
        assert download is False
        messages, info = self._PLAN
        logger = self.params.get("logger")
        assert logger is not None, "`extract` must hand yt-dlp a logger, or a gap has no reason"
        for message in messages:
            logger.error(message)
        return info

    def sanitize_info(self, info: dict[str, Any]) -> dict[str, Any]:
        return info


def _plan(
    monkeypatch: pytest.MonkeyPatch,
    messages: list[str],
    info: dict[str, Any] | None,
) -> None:
    """Make the next `extract()` call run against a yt-dlp that behaves like this."""
    from toolbox import ytdlp as ytdlp_module

    planned = type("_Planned", (_FakeYoutubeDL,), {"_PLAN": (messages, info)})
    monkeypatch.setattr(ytdlp_module, "YoutubeDL", planned)


def _playlist_of(size: int, dead: int) -> dict[str, Any]:
    """A ``size``-entry album info dict with entry ``dead`` (one-based) handed back as `None`."""
    entries: list[dict[str, Any] | None] = []
    for position in range(1, size + 1):
        if position == dead:
            entries.append(None)
            continue
        entries.append({**INFO_VIDEO, "id": f"vid{position:08d}", "playlist_index": position})
    return {
        "_type": "playlist",
        "id": "OLAK5uy_mZJMy9aqF3ew9kNoyIXX704dLo5x9Rse4",
        "title": "Album - Discovery",
        "playlist_count": size,
        "entries": entries,
    }


PLAYLIST_URL = "https://music.youtube.com/playlist?list=OLAK5uy_mZJMy9aqF3ew9kNoyIXX704dLo5x9Rse4"


def test_one_dead_entry_leaves_nineteen_and_is_reported_as_a_gap(monkeypatch: pytest.MonkeyPatch):
    """The whole defect, in one assertion pair: nineteen entries, one reported hole."""
    _plan(
        monkeypatch,
        ["ERROR: [youtube] vid00000007: Private video. Sign in if you have been granted access"],
        _playlist_of(20, dead=7),
    )
    result = extract_module.extract(ExtractRequest(url=PLAYLIST_URL))

    assert result.kind == "playlist"
    assert len(result.entries) == 19
    # Our own numbering closes over the hole; nothing downstream sees a missing position.
    assert [entry.index for entry in result.entries] == list(range(19))
    assert len(result.unreadable) == 1
    gap = result.unreadable[0]
    assert gap.position == 7
    assert gap.id == "vid00000007"
    assert gap.reason is not None and gap.reason.startswith("Private video")
    assert gap.code is ErrorCode.YTDLP_PRIVATE
    # "19 of 20 entries; 1 could not be read" is readable off the result, with no second call.
    assert len(result.entries) + len(result.unreadable) == 20


def test_a_gap_keeps_its_position_when_yt_dlp_renumbered_the_listing(
    monkeypatch: pytest.MonkeyPatch,
):
    """`requested_entries` is the only place a hole's real position survives, so it is read."""
    info = _playlist_of(5, dead=2)
    info["requested_entries"] = [2, 3, 4, 5, 6]
    _plan(monkeypatch, ["ERROR: [youtube] vid00000002: Video unavailable"], info)
    result = extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert [gap.position for gap in result.unreadable] == [3]
    assert result.unreadable[0].code is ErrorCode.YTDLP_UNAVAILABLE


def test_a_gap_yt_dlp_said_nothing_about_still_counts(monkeypatch: pytest.MonkeyPatch):
    """No sentence and no id is still a hole, and still `PLAYLIST_ENTRY_UNAVAILABLE`."""
    _plan(monkeypatch, [], _playlist_of(20, dead=7))
    result = extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert len(result.entries) == 19
    assert [(gap.id, gap.reason) for gap in result.unreadable] == [(None, None)]
    assert result.unreadable[0].code is ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE


def test_entries_the_source_counted_and_never_handed_over_are_counted_too(
    monkeypatch: pytest.MonkeyPatch,
):
    """`playlist_count` says twenty; eighteen arrived and none of them was a `None`."""
    info = _playlist_of(18, dead=0)
    info["playlist_count"] = 20
    _plan(monkeypatch, [], info)
    result = extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert len(result.entries) == 18
    assert len(result.unreadable) == 2


def test_a_single_dead_video_is_still_an_error(monkeypatch: pytest.MonkeyPatch):
    """`ignoreerrors` must not turn one dead video into an empty success."""
    _plan(
        monkeypatch,
        ["ERROR: [youtube] eZKgoOjJmrp: Video unavailable. This video is no longer available"],
        None,
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url="https://youtu.be/eZKgoOjJmrp"))
    assert raised.value.code is ErrorCode.YTDLP_UNAVAILABLE
    # The sentence is yt-dlp's own, not our "yt-dlp returned no information".
    assert raised.value.message.startswith("Video unavailable")


def test_a_private_playlist_is_its_own_code(monkeypatch: pytest.MonkeyPatch):
    """Case two of three: the playlist is there, and we are not allowed to list it."""
    _plan(
        monkeypatch,
        ["ERROR: [youtube:tab] OLAK5uy_x: This playlist is private, use --cookies"],
        None,
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert raised.value.code is ErrorCode.PLAYLIST_PRIVATE
    assert raised.value.status == 403


def test_a_deleted_playlist_is_its_own_code(monkeypatch: pytest.MonkeyPatch):
    """Case one of three, and the one that used to read "This video is not available"."""
    _plan(
        monkeypatch,
        ["ERROR: [youtube:tab] OLAK5uy_x: YouTube said: The playlist does not exist."],
        None,
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert raised.value.code is ErrorCode.PLAYLIST_UNAVAILABLE
    assert raised.value.status == 404


def test_a_playlist_url_that_answered_with_a_video_error_is_not_blamed_on_a_video(
    monkeypatch: pytest.MonkeyPatch,
):
    """The promotion rule: nothing came back from a *playlist*, so the playlist is the subject."""
    _plan(monkeypatch, ["ERROR: [youtube] abc: Video unavailable"], None)
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert raised.value.code is ErrorCode.PLAYLIST_UNAVAILABLE


def test_a_playlist_of_nothing_but_gaps_says_so(monkeypatch: pytest.MonkeyPatch):
    """Case three, in the only shape where it is fatal: every entry of it was unreadable."""
    _plan(
        monkeypatch,
        ["ERROR: [youtube] vid00000001: Private video", "ERROR: [youtube] vid00000002: Private"],
        {"id": "OLAK5uy_x", "title": "Album - Gone", "entries": [None, None]},
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert raised.value.code is ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE
    assert len(cast("list[object]", raised.value.details["unreadable"])) == 2


def test_a_listing_every_entry_refused_the_same_way_quotes_that_refusal(
    monkeypatch: pytest.MonkeyPatch,
):
    """Fifteen tracks, one sentence of YouTube's own, nothing readable.

    The catalog's hint — "the playlist is fine; one of the videos inside it is gone, private or
    blocked" — describes a *few* lost entries, and the button it offers is "Import what came
    back". With every entry refused in the same words and nothing back at all, both are wrong:
    the sentence is YouTube's answer for the whole listing, and it points at the session or the
    player. Quoting it is the one thing that lets the owner act.
    """
    refusal = "The page needs to be reloaded."
    _plan(
        monkeypatch,
        [f"ERROR: [youtube] vid0000000{index}: {refusal}" for index in range(1, 4)],
        {"id": "OLAK5uy_ltPA", "title": "Album", "entries": [None, None, None]},
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))

    error = raised.value
    assert error.code is ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE
    assert refusal in error.hint, error.hint
    assert "every entry answered the same thing" in error.hint
    assert "one of the videos" not in error.hint
    assert error.action == "Retry the listing", "nothing came back to be imported"
    assert error.message == "None of the 3 entries of this playlist could be read."


def test_a_listing_lost_for_different_reasons_keeps_the_catalog_hint(
    monkeypatch: pytest.MonkeyPatch,
):
    """Two entries gone for two different reasons is a playlist problem, not a session one."""
    _plan(
        monkeypatch,
        [
            "ERROR: [youtube] vid00000001: Private video",
            "ERROR: [youtube] vid00000002: Video unavailable",
        ],
        {"id": "OLAK5uy_x", "title": "Album - Gone", "entries": [None, None]},
    )
    with pytest.raises(ToolboxError) as raised:
        extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    error = raised.value
    assert error.hint == spec_for(ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE).hint
    assert error.action == "Retry the listing"


def test_an_empty_playlist_is_not_a_failure(monkeypatch: pytest.MonkeyPatch):
    """Zero entries and zero gaps is a playlist with nothing in it, which is not an error."""
    _plan(monkeypatch, [], {"id": "OLAK5uy_x", "title": "Album - Empty", "entries": []})
    result = extract_module.extract(ExtractRequest(url=PLAYLIST_URL))
    assert result.entries == []
    assert result.unreadable == []


# ----------------------------------------------------------------------------------
# the same thing, offline: `fixture://<name>?gap=<n>`
# ----------------------------------------------------------------------------------


def test_the_gap_fixture_drops_one_entry_and_reports_it(fixture_client: TestClient):
    payload = fixture_client.post("/extract", json={"url": "fixture://discovery?gap=14"}).json()
    assert len(payload["entries"]) == 14
    assert [entry["index"] for entry in payload["entries"]] == list(range(14))
    assert len(payload["unreadable"]) == 1
    gap = payload["unreadable"][0]
    assert gap["position"] == 15
    assert gap["code"] == ErrorCode.YTDLP_PRIVATE.value
    assert gap["reason"].startswith("Private video")


def test_the_gap_fixture_renumbers_what_download_is_addressed_by(fixture_client: TestClient):
    """`#n` follows the listing the caller was handed, not the recording's own numbering."""
    without = fixture_client.post("/extract", json={"url": "fixture://discovery"}).json()
    with_gap = fixture_client.post("/extract", json={"url": "fixture://discovery?gap=0"}).json()
    assert with_gap["entries"][0]["title"] == without["entries"][1]["title"]
    one = fixture_client.post("/extract", json={"url": "fixture://discovery?gap=0#0"}).json()
    assert one["kind"] == "video"
    assert one["entries"][0]["title"] == without["entries"][1]["title"]


def test_a_gap_a_fixture_cannot_have_is_an_error(fixture_client: TestClient):
    response = fixture_client.post("/extract", json={"url": "fixture://discovery?gap=99"})
    assert response.status_code == 404
    assert response.json()["code"] == ErrorCode.FIXTURE_UNKNOWN.value


def test_an_ordinary_fixture_reports_no_gap(fixture_client: TestClient):
    payload = fixture_client.post("/extract", json={"url": "fixture://discovery"}).json()
    assert payload["unreadable"] == []


def test_extractslow_holds_one_extraction_open_without_touching_the_others():
    """`?extractslow=<ms>` is the sibling of `?slow=`, for the other slow thing a source is.

    A recorded extraction is instant, and instant is the one speed at which a whole class of
    bug is invisible: while `resolve` runs, the wizard's address bar still says `?url=` rather
    than `?importId=`, and anything that re-enters that loader in the meantime — a poll, a
    second tab, an impatient Enter — is a second creation. A test whose extraction returns in
    eight milliseconds never has a window to re-enter, so it proves nothing either way.
    """
    assert fixture_extract_delay_seconds("fixture://discovery?extractslow=1500") == pytest.approx(
        1.5
    )
    # Capped, for the same reason `?slow=` is: a switch may open a window, not a career.
    assert fixture_extract_delay_seconds("fixture://discovery?extractslow=999999") == pytest.approx(
        20.0
    )
    # Absence and nonsense both cost nothing: every other fixture URL is unaffected.
    assert fixture_extract_delay_seconds("fixture://discovery") == 0.0
    assert fixture_extract_delay_seconds("fixture://discovery?extractslow=abc") == 0.0
    assert fixture_extract_delay_seconds("https://youtube.com/watch?v=x") == 0.0


def test_a_slow_extraction_still_answers_the_same_recording(fixture_client: TestClient):
    """The delay is a delay and nothing else: the entries are the ones `discovery` holds."""
    plain = fixture_client.post("/extract", json={"url": "fixture://discovery"}).json()
    slow = fixture_client.post(
        "/extract", json={"url": "fixture://discovery?extractslow=50"}
    ).json()
    assert len(slow["entries"]) == len(plain["entries"])
    assert [entry["id"] for entry in slow["entries"]] == [entry["id"] for entry in plain["entries"]]
