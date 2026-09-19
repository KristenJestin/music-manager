"""Runtime configuration, read from the environment on every call.

Nothing is cached in a module-level singleton: the tests flip ``MM_TOOLBOX_FIXTURES`` with
`monkeypatch` between assertions, and a stateless service has no reason to memoise four
environment lookups.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Final

from toolbox.urls import parse_fixture

__all__ = [
    "DEFAULT_LIBRARY_ROOT",
    "FIXTURE_SLOW_MAX_MS",
    "acoustid_key",
    "autoupdate_enabled",
    "env_flag",
    "fixture_delay_seconds",
    "fixture_delay_seconds_for",
    "fixtures_enabled",
    "library_root",
    "log_level",
    "log_level_number",
    "toolbox_token",
    "ytdlp_verbose",
]

_TRUE: Final[frozenset[str]] = frozenset({"1", "true", "yes", "on"})

#: The bind mount shared with Navidrome inside the image. Overridden in tests.
DEFAULT_LIBRARY_ROOT: Final[str] = "/library"


def env_flag(name: str, *, default: bool = False) -> bool:
    """Read a boolean environment variable the same way everywhere."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().casefold() in _TRUE


def fixtures_enabled() -> bool:
    """True when the service must run fully offline against recorded fixtures."""
    return env_flag("MM_TOOLBOX_FIXTURES")


def autoupdate_enabled() -> bool:
    """True when the container should refresh yt-dlp at start-up."""
    return env_flag("MM_YTDLP_AUTOUPDATE")


#: `MM_LOG_LEVEL`'s vocabulary — the same five words `apps/web` accepts for the same variable
#: (`#/server/http/log.ts`). One variable set on three containers has to mean one thing, and
#: `docker-compose.prod.yml` already passes it to this one while nothing here read it.
LOG_LEVELS: Final[dict[str, int]] = {
    "debug": logging.DEBUG,
    "info": logging.INFO,
    "warn": logging.WARNING,
    "error": logging.ERROR,
    #: Above CRITICAL: nothing this process can emit gets through.
    "silent": logging.CRITICAL + 1,
}


def log_level() -> str:
    """`MM_LOG_LEVEL`, or `info` — nonsense included, exactly as `apps/web` treats it."""
    raw = os.environ.get("MM_LOG_LEVEL", "").strip().casefold()
    return raw if raw in LOG_LEVELS else "info"


def log_level_number() -> int:
    """The stdlib level behind `log_level()`, for `structlog`'s filtering wrapper."""
    return LOG_LEVELS[log_level()]


def ytdlp_verbose() -> bool:
    """True when yt-dlp's own debug stream must reach the logs (`MM_YTDLP_VERBOSE=1`).

    Off by default: it is thousands of lines per download and it carries request headers. The
    logger that forwards it redacts the jar's values first (`toolbox.ytdlp.ExtractionLog`), so
    turning this on cannot put a YouTube session in `docker logs`.
    """
    return env_flag("MM_YTDLP_VERBOSE")


def fixture_delay_seconds() -> float:
    """How long a fixture download pauses between slices, in seconds.

    Twenty milliseconds by default, which makes the offline run feel like a download without
    slowing the tests down. `MM_TOOLBOX_FIXTURE_DELAY_MS` raises it for a demo, or for the
    test that needs a download to still be running when a second request arrives.
    """
    raw = os.environ.get("MM_TOOLBOX_FIXTURE_DELAY_MS", "").strip()
    try:
        return max(float(raw), 0.0) / 1000.0 if raw else 0.02
    except ValueError:
        return 0.02


def toolbox_token() -> str:
    """The shared bearer token, or an empty string when authentication is off."""
    return os.environ.get("MM_TOOLBOX_TOKEN", "").strip()


def acoustid_key() -> str:
    """Fallback AcoustID key when the caller does not pass one."""
    return os.environ.get("MM_ACOUSTID_KEY", "").strip()


def library_root() -> Path:
    """Root of the music library bind mount."""
    return Path(os.environ.get("MM_LIBRARY_ROOT", DEFAULT_LIBRARY_ROOT))


#: Upper bound on ``?slow=<ms>``. A scenario switch may make a download observable; it may not
#: make one take a minute, because the single download slot is held for its whole length.
FIXTURE_SLOW_MAX_MS: Final[float] = 2_000.0


#: Upper bound on ``?extractslow=<ms>``. Long enough to hold a browser's first paint open,
#: short enough that a test using it is still a test.
FIXTURE_EXTRACT_SLOW_MAX_MS: Final[float] = 20_000.0


def fixture_extract_delay_seconds(url: str) -> float:
    """How long ``/extract`` pretends to take for one URL — ``?extractslow=<ms>``, else none.

    The sibling of ``?slow=``, for the other slow thing a source can be. A recorded extraction
    is instant, and instant is the one speed at which a whole class of bug is invisible: the
    `resolve` of a real playlist takes the owner a minute, and for that minute the wizard's URL
    still says ``?url=`` rather than ``?importId=``. Anything that re-enters that loader —
    a poll, a second tab, an impatient Enter — is a second creation, and a test whose extraction
    returns in eight milliseconds never has a window to re-enter.

    Zero, and therefore free, for every URL that does not ask.
    """
    ref = parse_fixture(url)
    raw = (ref.params.get("extractslow") if ref is not None else None) or ""
    if raw.strip() == "":
        return 0.0
    try:
        return min(max(float(raw), 0.0), FIXTURE_EXTRACT_SLOW_MAX_MS) / 1000.0
    except ValueError:
        return 0.0


def fixture_delay_seconds_for(url: str) -> float:
    """The per-slice delay for one URL — the installation default, or its ``?slow=<ms>``.

    A scenario switch, exactly like ``?fp=mismatch``: a recorded URL that carries the condition
    it is meant to exercise. Here the condition is **duration**. The offline end-to-end run
    paces its downloads at ten milliseconds so a suite is minutes rather than hours, and at
    that speed a whole track is three slices and thirty milliseconds — a perfectly good
    download and an impossible thing to observe from a browser. A test that has to catch the
    Console *while* a track is downloading (owner review 5, G2) asks for
    ``fixture://discovery?slow=400`` and gets a window it can see, without slowing down every
    other spec beside it.
    """
    ref = parse_fixture(url)
    raw = (ref.params.get("slow") if ref is not None else None) or ""
    if raw.strip() == "":
        return fixture_delay_seconds()
    try:
        return min(max(float(raw), 0.0), FIXTURE_SLOW_MAX_MS) / 1000.0
    except ValueError:
        return fixture_delay_seconds()
