"""URL parsing: the port of v1's `YoutubeHelpers`, plus the fixture scheme."""

from __future__ import annotations

import pytest

from toolbox.urls import UrlKind, is_fixture_url, is_youtube_url, parse_fixture, parse_url

WATCH = "https://www.youtube.com/watch?v=eZKgoOjJmrp"


@pytest.mark.parametrize(
    ("url", "kind", "identifier"),
    [
        (WATCH, UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("https://youtu.be/eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("https://youtu.be/eZKgoOjJmrp?t=42", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("http://m.youtube.com/watch?v=eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("https://music.youtube.com/watch?v=eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("www.youtube.com/watch?v=eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("https://www.youtube.com/embed/eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        ("https://www.youtube.com/shorts/eZKgoOjJmrp", UrlKind.VIDEO, "eZKgoOjJmrp"),
        (
            "https://music.youtube.com/playlist?list=OLAK5uy_abc-DEF_123",
            UrlKind.PLAYLIST,
            "OLAK5uy_abc-DEF_123",
        ),
        ("fixture://discovery", UrlKind.FIXTURE, "discovery"),
    ],
)
def test_recognised_shapes(url: str, kind: UrlKind, identifier: str):
    parsed = parse_url(url)
    assert (parsed.kind, parsed.id) == (kind, identifier)
    assert parsed.ok


@pytest.mark.parametrize(
    "url", ["", "   ", "https://example.com/watch?v=abc", "https://vimeo.com/12345", "not a url"]
)
def test_unrecognised_shapes(url: str):
    parsed = parse_url(url)
    assert parsed.kind is UrlKind.UNKNOWN
    assert not parsed.ok


def test_a_watch_url_carrying_a_list_is_a_playlist():
    """v1's ordering, kept on purpose: the user pasted a playlist, they mean the album."""
    parsed = parse_url(f"{WATCH}&list=OLAK5uy_discovery")
    assert parsed.kind is UrlKind.PLAYLIST
    assert parsed.id == "OLAK5uy_discovery"


def test_is_youtube_url_matches_the_v1_predicate():
    assert is_youtube_url(WATCH)
    assert is_youtube_url("youtu.be/eZKgoOjJmrp")
    assert not is_youtube_url("https://notyoutube.com/watch?v=x")


def test_fixture_reference_carries_params_and_index():
    ref = parse_fixture("fixture://discovery?fp=mismatch#3")
    assert ref is not None
    assert (ref.name, ref.params, ref.index) == ("discovery", {"fp": "mismatch"}, 3)
    assert ref.canonical == "fixture://discovery?fp=mismatch"


def test_a_bare_fixture_reference_has_no_index():
    ref = parse_fixture("fixture://skinny-love")
    assert ref is not None
    assert ref.index is None
    assert ref.canonical == "fixture://skinny-love"


def test_is_fixture_url():
    assert is_fixture_url("fixture://currents")
    assert not is_fixture_url(WATCH)
