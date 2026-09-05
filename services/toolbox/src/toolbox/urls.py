"""URL parsing, ported from v1's ``YoutubeHelpers.ParseUrl``.

Two things live here: the YouTube URL shapes the app has to recognise before it queues
anything, and the ``fixture://`` scheme that makes the whole service work offline.

The v1 ordering is kept deliberately: a ``watch?v=…&list=…`` URL is a **playlist**, because
that is what the user pasted and what they expect to import. v1's shapes are extended with
``/embed/``, ``/shorts/`` and ``/v/``, which it did not handle.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Final
from urllib.parse import parse_qsl, urlsplit

__all__ = ["FixtureRef", "UrlKind", "YouTubeUrl", "is_fixture_url", "parse_fixture", "parse_url"]


class UrlKind(StrEnum):
    """What a submitted URL points at."""

    VIDEO = "video"
    PLAYLIST = "playlist"
    FIXTURE = "fixture"
    UNKNOWN = "unknown"


#: YouTube ids are 11 characters for videos and up to 34 for playlists, same alphabet.
_ID = r"[A-Za-z0-9_-]+"

_PLAYLIST = re.compile(rf"[?&]list=({_ID})")
_SHORT = re.compile(rf"youtu\.be/({_ID})")
_WATCH = re.compile(rf"[?&]v=({_ID})")
_PATH_FORMS = re.compile(rf"youtube\.com/(?:embed|shorts|v|live)/({_ID})")

_HOST: Final[re.Pattern[str]] = re.compile(
    r"^(?:https?://)?(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)(?:/|$)", re.IGNORECASE
)

_FIXTURE_SCHEME: Final[str] = "fixture"


@dataclass(frozen=True, slots=True)
class YouTubeUrl:
    """The outcome of parsing a submitted URL."""

    kind: UrlKind
    id: str

    @property
    def ok(self) -> bool:
        return self.kind is not UrlKind.UNKNOWN and bool(self.id)


@dataclass(frozen=True, slots=True)
class FixtureRef:
    """A ``fixture://name?params#index`` reference.

    ``index`` selects one entry of a recorded playlist (``fixture://discovery#3``), and the
    query string carries scenario switches — ``?fp=mismatch`` makes ``/fingerprint`` disagree
    with the chosen recording so the Inbox path can be exercised offline.
    """

    name: str
    params: dict[str, str] = field(default_factory=dict[str, str])
    index: int | None = None

    @property
    def canonical(self) -> str:
        """The URL without its entry fragment — the key the recordings are stored under."""
        query = "&".join(f"{k}={v}" for k, v in sorted(self.params.items()))
        return f"{_FIXTURE_SCHEME}://{self.name}" + (f"?{query}" if query else "")


def is_fixture_url(url: str) -> bool:
    """True for anything addressed to the recorded-fixture backend."""
    return url.strip().casefold().startswith(f"{_FIXTURE_SCHEME}://")


def parse_fixture(url: str) -> FixtureRef | None:
    """Parse ``fixture://discovery?fp=mismatch#3``, or return ``None``."""
    if not is_fixture_url(url):
        return None
    split = urlsplit(url.strip())
    # `fixture://discovery` puts the name in netloc; `fixture:///discovery` in path.
    name = (split.netloc or split.path.lstrip("/")).strip().casefold()
    if not name:
        return None
    index: int | None = None
    if split.fragment.strip().isdigit():
        index = int(split.fragment)
    return FixtureRef(name=name, params=dict(parse_qsl(split.query)), index=index)


def is_youtube_url(url: str) -> bool:
    """Port of ``YoutubeHelpers.IsValidYouTubeUrl``."""
    return bool(_HOST.search(url.strip()))


def parse_url(url: str) -> YouTubeUrl:
    """Port of ``YoutubeHelpers.ParseUrl``, plus the ``fixture://`` scheme.

    Returns :attr:`UrlKind.UNKNOWN` rather than raising: deciding what to do with an
    unrecognised URL is the orchestrator's call, not the toolbox's.
    """
    candidate = url.strip()
    if not candidate:
        return YouTubeUrl(UrlKind.UNKNOWN, "")

    fixture = parse_fixture(candidate)
    if fixture is not None:
        return YouTubeUrl(UrlKind.FIXTURE, fixture.name)

    if not is_youtube_url(candidate):
        return YouTubeUrl(UrlKind.UNKNOWN, "")

    for pattern, kind in (
        (_PLAYLIST, UrlKind.PLAYLIST),
        (_SHORT, UrlKind.VIDEO),
        (_WATCH, UrlKind.VIDEO),
        (_PATH_FORMS, UrlKind.VIDEO),
    ):
        match = pattern.search(candidate)
        if match:
            return YouTubeUrl(kind, match.group(1))

    return YouTubeUrl(UrlKind.UNKNOWN, "")
