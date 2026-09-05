"""Fixtures mode: the whole toolbox, fully offline.

``MM_TOOLBOX_FIXTURES=1`` makes every endpoint answer from the recordings in `data/` instead
of the network. It is not a test-only convenience: `docs/08-plan-de-dev.md` makes it what the
offline end-to-end run and the demo are built on, so it has to cover extraction,
fingerprinting, YouTube Music search, artwork *and* download.

Recognised URLs:

===================================== ====================================================
``fixture://discovery``               Daft Punk — Discovery, 15 videos for 14 tracks (the
                                      extra one is an alternate upload, so `extra_videos`
                                      is reachable without the network)
``fixture://skinny-love``             a single video
``fixture://currents``                Tame Impala — Currents, 13 videos
``fixture://discovery?fp=mismatch``   same playlist, but `/fingerprint` answers with a
                                      *different* recording, which is what drives the
                                      `fingerprint_mismatch` Inbox item
``fixture://<name>#<n>``              entry ``n`` of that fixture, for `/download`
===================================== ====================================================
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final, cast

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import (
    ExtractResult,
    FingerprintCandidate,
    FingerprintResult,
    YtMusicCandidate,
)
from toolbox.urls import FixtureRef, parse_fixture

__all__ = [
    "DATA_DIR",
    "KNOWN",
    "album",
    "extract",
    "fingerprint_for",
    "load",
    "record_download",
    "require_ref",
    "sample_opus",
    "select_entry",
    "ytmusic",
]

DATA_DIR: Final[Path] = Path(__file__).parent / "data"

#: Every recorded fixture. Anything else is a :attr:`ErrorCode.FIXTURE_UNKNOWN`.
KNOWN: Final[frozenset[str]] = frozenset({"discovery", "skinny-love", "currents"})

#: Name of the per-directory note `/download` leaves so `/fingerprint` knows which scenario
#: a file came from. A dotfile, so Navidrome and the library scanner ignore it.
LEDGER: Final[str] = ".mm-fixtures.json"


def sample_opus() -> Path:
    """The bundled five-second Opus sample every fixture download copies.

    Generated inside the toolbox image with
    ``ffmpeg -f lavfi -i sine=frequency=440:sample_rate=48000:duration=5 -c:a libopus``.
    """
    return DATA_DIR / "sample.opus"


def load(name: str) -> dict[str, Any]:
    """Read one recording, or raise :attr:`ErrorCode.FIXTURE_UNKNOWN`."""
    key = name.strip().casefold()
    path = DATA_DIR / f"{key}.json"
    if key not in KNOWN or not path.is_file():
        raise ToolboxError(
            ErrorCode.FIXTURE_UNKNOWN,
            f"No fixture named '{name}'. Known fixtures: {', '.join(sorted(KNOWN))}.",
            details={"requested": name, "known": sorted(KNOWN)},
        )
    return cast(dict[str, Any], json.loads(path.read_text(encoding="utf-8")))


def require_ref(url: str) -> FixtureRef:
    """Parse a ``fixture://`` URL, or explain why it is not one."""
    ref = parse_fixture(url)
    if ref is None:
        raise ToolboxError(
            ErrorCode.FIXTURE_UNKNOWN,
            f"Fixtures mode only answers fixture:// URLs, got '{url}'.",
            details={"requested": url, "known": sorted(KNOWN)},
        )
    return ref


def extract(url: str) -> ExtractResult:
    """The recorded `/extract` answer for a fixture URL."""
    ref = require_ref(url)
    payload = load(ref.name)
    result = ExtractResult.model_validate(payload["extract"])
    if ref.index is not None:
        entries = [entry for entry in result.entries if entry.index == ref.index]
        if not entries:
            raise ToolboxError(
                ErrorCode.FIXTURE_UNKNOWN,
                f"Fixture '{ref.name}' has no entry #{ref.index}.",
                details={"requested": url, "entries": len(result.entries)},
            )
        return ExtractResult(
            kind="video",
            title=entries[0].title,
            uploader=entries[0].uploader,
            id=entries[0].id,
            entries=entries,
        )
    return result


def select_entry(url: str) -> dict[str, Any]:
    """The single entry a `/download` fixture URL points at (defaults to the first)."""
    ref = require_ref(url)
    payload = load(ref.name)
    entries = cast(list[dict[str, Any]], payload["extract"]["entries"])
    index = ref.index or 0
    for entry in entries:
        if int(entry["index"]) == index:
            return entry
    raise ToolboxError(
        ErrorCode.FIXTURE_UNKNOWN,
        f"Fixture '{ref.name}' has no entry #{index}.",
        details={"requested": url, "entries": len(entries)},
    )


def album(name: str) -> dict[str, Any]:
    """The album facts behind a fixture: artist, title, year, label, MBIDs."""
    return cast(dict[str, Any], load(name)["album"])


def ytmusic(artist: str, albumtitle: str | None, title: str | None) -> list[YtMusicCandidate]:
    """Recorded YouTube Music candidates, matched on artist / album / title, loosely."""
    needles = [value.casefold() for value in (artist, albumtitle, title) if value]
    out: list[YtMusicCandidate] = []
    for name in sorted(KNOWN):
        payload = load(name)
        for raw in cast(list[dict[str, Any]], payload["ytmusic"]):
            haystack = " ".join(
                str(raw.get(key) or "") for key in ("title", "artist", "album")
            ).casefold()
            if all(needle in haystack for needle in needles):
                out.append(YtMusicCandidate.model_validate(raw))
    return out


def record_download(path: Path, url: str) -> None:
    """Note which fixture URL produced ``path``, so `/fingerprint` can stay consistent."""
    ref = parse_fixture(url)
    if ref is None:
        return
    ledger = path.parent / LEDGER
    entries: dict[str, str] = {}
    if ledger.is_file():
        try:
            entries = cast(dict[str, str], json.loads(ledger.read_text(encoding="utf-8")))
        except (OSError, ValueError):  # pragma: no cover - a corrupt note is not fatal
            entries = {}
    entries[path.name] = url
    ledger.write_text(json.dumps(entries, indent=2) + "\n", encoding="utf-8")


def _recorded_url(path: Path) -> str | None:
    ledger = path.parent / LEDGER
    if not ledger.is_file():
        return None
    try:
        entries = cast(dict[str, str], json.loads(ledger.read_text(encoding="utf-8")))
    except (OSError, ValueError):  # pragma: no cover
        return None
    return entries.get(path.name)


def fingerprint_for(path: Path) -> FingerprintResult:
    """The recorded fingerprint of a downloaded fixture file.

    ``?fp=mismatch`` in the URL that produced the file swaps in a *different* recording, so
    the fingerprint disagrees with the chosen mapping and the Inbox path can be exercised
    with no network and no real audio analysis.
    """
    url = _recorded_url(path)
    ref = parse_fixture(url) if url else None
    name = ref.name if ref else "discovery"
    payload = load(name)
    mismatch = bool(ref and ref.params.get("fp") == "mismatch")
    key = "fingerprint"
    if mismatch and "fingerprint_mismatch" in payload:
        key = "fingerprint_mismatch"
    raw = cast(dict[str, Any], payload[key])
    return FingerprintResult(
        fingerprint=str(raw["fingerprint"]),
        duration=float(raw["duration"]),
        candidates=[
            FingerprintCandidate.model_validate(item)
            for item in cast(list[dict[str, Any]], raw["candidates"])
        ],
    )
