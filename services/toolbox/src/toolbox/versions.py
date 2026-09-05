"""Version probes for the media tools the toolbox depends on.

Every probe returns ``None`` instead of raising when the tool is absent: on a developer
machine none of the binaries exist (they live in the Docker image), and `/health` is the
check that proves the *image* is complete.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from collections.abc import Sequence

__all__ = [
    "extract_version",
    "ffmpeg_version",
    "fpcalc_version",
    "rsgain_version",
    "yt_dlp_version",
]

_TIMEOUT_SECONDS = 5

#: rsgain colourises its banner even when stdout is a pipe, so strip SGR sequences before
#: matching. Without this, `rsgain --version` prints "rsgain\x1b[0m 3.6" and no pattern
#: anchored on "rsgain " can ever match.
_ANSI_SGR = re.compile(r"\x1b\[[0-9;]*m")


def extract_version(output: str, pattern: str) -> str | None:
    """Pull the first capture group of ``pattern`` out of a tool's (de-coloured) output."""
    match = re.search(pattern, _ANSI_SGR.sub("", output))
    return match.group(1).strip() if match else None


def _probe(executable: str, args: Sequence[str], pattern: str) -> str | None:
    """Run ``executable`` and pull a version out of its output, or return ``None``."""
    path = shutil.which(executable)
    if path is None:
        return None
    try:
        completed = subprocess.run(
            [path, *args],
            capture_output=True,
            text=True,
            timeout=_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return extract_version(f"{completed.stdout}\n{completed.stderr}", pattern)


def yt_dlp_version() -> str | None:
    """yt-dlp is used as a library, so read the module rather than a binary."""
    try:
        from yt_dlp.version import __version__
    except ImportError:
        return None
    return str(__version__)


#: Patterns are module constants so the tests can assert them against real recorded output.
FFMPEG_PATTERN = r"ffmpeg version (\S+)"
FPCALC_PATTERN = r"fpcalc version (\S+)"
RSGAIN_PATTERN = r"rsgain (\S+)"


def ffmpeg_version() -> str | None:
    return _probe("ffmpeg", ["-version"], FFMPEG_PATTERN)


def fpcalc_version() -> str | None:
    return _probe("fpcalc", ["-version"], FPCALC_PATTERN)


def rsgain_version() -> str | None:
    return _probe("rsgain", ["--version"], RSGAIN_PATTERN)
