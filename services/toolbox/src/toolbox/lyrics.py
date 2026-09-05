"""LRC handling: parse synchronised lyrics, and flatten them to plain text.

The toolbox never fetches lyrics (that is LRCLIB, on the TypeScript side); it only writes
what it is given, into ``SYLT`` for ID3 and into the sidecar `.lrc` file that Navidrome,
Jellyfin and Symfonium read.
"""

from __future__ import annotations

import re
from typing import Final

__all__ = ["LrcLine", "parse_lrc", "plain_text"]

#: `[mm:ss.xx]` or `[mm:ss:xx]`, repeated when one line carries several timestamps.
_STAMP: Final[re.Pattern[str]] = re.compile(r"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
#: `[ar:…]`, `[ti:…]`, `[length:…]` — metadata lines, not lyrics.
_META: Final[re.Pattern[str]] = re.compile(r"^\[[a-z]+:[^\]]*\]$", re.IGNORECASE)


class LrcLine:
    """One synchronised line: milliseconds from the start of the track, and its text."""

    __slots__ = ("at_ms", "text")

    def __init__(self, at_ms: int, text: str) -> None:
        self.at_ms = at_ms
        self.text = text

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, LrcLine):
            return NotImplemented
        return self.at_ms == other.at_ms and self.text == other.text

    def __repr__(self) -> str:
        return f"LrcLine({self.at_ms}, {self.text!r})"


def _to_ms(minutes: str, seconds: str, fraction: str | None) -> int:
    hundredths = 0
    if fraction:
        # `.5` means 500 ms, `.50` means 500 ms, `.500` means 500 ms.
        hundredths = int(fraction.ljust(3, "0")[:3])
    return int(minutes) * 60_000 + int(seconds) * 1000 + hundredths


def parse_lrc(lrc: str) -> list[LrcLine]:
    """Parse an LRC document into time-ordered lines, dropping metadata and empty stamps."""
    lines: list[LrcLine] = []
    for raw in lrc.splitlines():
        candidate = raw.strip()
        if not candidate or _META.match(candidate):
            continue
        stamps = list(_STAMP.finditer(candidate))
        if not stamps:
            continue
        text = candidate[stamps[-1].end() :].strip()
        for stamp in stamps:
            lines.append(_line_from(stamp, text))
    lines.sort(key=lambda line: line.at_ms)
    return lines


def _line_from(stamp: re.Match[str], text: str) -> LrcLine:
    return LrcLine(_to_ms(stamp.group(1), stamp.group(2), stamp.group(3)), text)


def plain_text(lrc: str) -> str:
    """The same lyrics without timestamps, for ``USLT`` / ``LYRICS`` / ``©lyr``."""
    parsed = parse_lrc(lrc)
    if parsed:
        return "\n".join(line.text for line in parsed)
    # Not an LRC document at all: it is already plain text.
    return lrc.strip()
