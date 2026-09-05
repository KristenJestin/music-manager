"""Runtime configuration, read from the environment on every call.

Nothing is cached in a module-level singleton: the tests flip ``MM_TOOLBOX_FIXTURES`` with
`monkeypatch` between assertions, and a stateless service has no reason to memoise four
environment lookups.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Final

__all__ = [
    "DEFAULT_LIBRARY_ROOT",
    "acoustid_key",
    "autoupdate_enabled",
    "env_flag",
    "fixtures_enabled",
    "library_root",
    "toolbox_token",
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


def toolbox_token() -> str:
    """The shared bearer token, or an empty string when authentication is off."""
    return os.environ.get("MM_TOOLBOX_TOKEN", "").strip()


def acoustid_key() -> str:
    """Fallback AcoustID key when the caller does not pass one."""
    return os.environ.get("MM_ACOUSTID_KEY", "").strip()


def library_root() -> Path:
    """Root of the music library bind mount."""
    return Path(os.environ.get("MM_LIBRARY_ROOT", DEFAULT_LIBRARY_ROOT))
