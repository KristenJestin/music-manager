"""Running the media binaries.

The binaries (`ffmpeg`, `ffprobe`, `fpcalc`, `rsgain`) exist only inside the toolbox image.
On a developer machine they are absent, and the honest answer is a catalogued
:attr:`ErrorCode.FFMPEG_MISSING` rather than a stack trace — the same code the Console
already knows how to render.

Note the deliberate limitation: the taxonomy has one "a media binary is missing" code, so
`fpcalc` and `rsgain` reuse it, naming the actual tool in ``message`` and ``details``.
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Sequence
from typing import Final

from toolbox.errors import ErrorCode, ToolboxError

__all__ = ["DEFAULT_TIMEOUT", "require_tool", "run_tool"]

DEFAULT_TIMEOUT: Final[float] = 300.0


def require_tool(name: str) -> str:
    """Absolute path of a media binary, or :attr:`ErrorCode.FFMPEG_MISSING`."""
    path = shutil.which(name)
    if path is None:
        raise ToolboxError(
            ErrorCode.FFMPEG_MISSING,
            f"{name} is not available; it lives in the toolbox image.",
            details={"tool": name},
        )
    return path


def run_tool(
    name: str,
    args: Sequence[str],
    *,
    timeout: float = DEFAULT_TIMEOUT,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a media binary and return its completed process.

    Output is captured, never streamed: nothing in this service parses a tool's stdout to
    find a file path (that was the v1 mistake); stdout is only read where the tool's *data*
    is its output, as with `fpcalc -json` and `rsgain -O`.
    """
    executable = require_tool(name)
    try:
        completed = subprocess.run(
            [executable, *args],
            capture_output=True,
            text=True,
            # These tools speak UTF-8 whatever the host locale claims. Without this, a
            # Windows console codepage turns a `℗` in a tag into a decoding crash.
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolboxError(
            ErrorCode.UNKNOWN,
            f"{name} timed out after {timeout:.0f}s.",
            details={"tool": name},
        ) from exc
    except OSError as exc:
        raise ToolboxError(
            ErrorCode.FFMPEG_MISSING, f"{name} could not be started: {exc}", details={"tool": name}
        ) from exc
    if check and completed.returncode != 0:
        raise ToolboxError(
            ErrorCode.UNKNOWN,
            f"{name} exited with {completed.returncode}: {completed.stderr.strip()[:400]}",
            details={"tool": name, "returncode": completed.returncode},
        )
    return completed
