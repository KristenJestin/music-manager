"""Version parsing, against output recorded from the real toolbox image.

These strings are exactly what the binaries print inside `docker/toolbox.Dockerfile`.
rsgain in particular colourises its banner even through a pipe, which silently broke the
first implementation.
"""

from __future__ import annotations

from toolbox.versions import (
    FFMPEG_PATTERN,
    FPCALC_PATTERN,
    RSGAIN_PATTERN,
    extract_version,
)

FFMPEG_OUTPUT = (
    "ffmpeg version 7.1.5-0+deb13u1 Copyright (c) 2000-2026 the FFmpeg developers\n"
    "built with gcc 14 (Debian 14.2.0-19)\n"
)
FPCALC_OUTPUT = "fpcalc version 1.5.1 (FFmpeg Lavc61.19.100 Lavf61.7.100 SwR5.3.100)\n"
RSGAIN_OUTPUT = "\x1b[1;32mrsgain\x1b[0m 3.6 - using:\n  \x1b[1mlibebur128\x1b[0m 1.2.6\n"


def test_ffmpeg_version_is_parsed():
    assert extract_version(FFMPEG_OUTPUT, FFMPEG_PATTERN) == "7.1.5-0+deb13u1"


def test_fpcalc_version_is_parsed():
    assert extract_version(FPCALC_OUTPUT, FPCALC_PATTERN) == "1.5.1"


def test_rsgain_version_is_parsed_through_ansi_colour():
    assert extract_version(RSGAIN_OUTPUT, RSGAIN_PATTERN) == "3.6"


def test_missing_version_yields_none():
    assert extract_version("command not found\n", RSGAIN_PATTERN) is None
