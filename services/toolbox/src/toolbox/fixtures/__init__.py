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
``fixture://discovery?slow=400``      same playlist, but `/download` paces its slices at 400
                                      ms instead of the installation default, so a browser
                                      test can observe a track *while* it is downloading
                                      (capped at 2 s a slice)
``fixture://discovery?extractslow=1500``
                                      same playlist, but `/extract` takes 1.5 s to answer, so a
                                      test has a window in which the orchestrator is still
                                      resolving (capped at 20 s)
``fixture://watched?snapshot=1``      a watched playlist as it was yesterday: three entries,
                                      one of them a ``[Private video]`` that cannot be
                                      fetched and must not fail the scan
``fixture://watched?snapshot=2``      the same playlist today, one video longer — which is
                                      how the watched-source diff is exercised offline
``fixture://<name>#<n>``              entry ``n`` of that fixture, for `/download`
===================================== ====================================================

``/extract`` with ``flat: true`` answers the listing only, here as in production: the
recordings are full extractions and :func:`_flatten` strips what a flat call genuinely does
not return, so a caller that reads a description out of one fails offline rather than in
front of YouTube.
"""

from __future__ import annotations

import base64
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any, Final, cast

from toolbox.config import fixture_extract_delay_seconds
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
KNOWN: Final[frozenset[str]] = frozenset({"discovery", "skinny-love", "currents", "watched"})

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


def _snapshot(result: ExtractResult, payload: dict[str, Any], ref: FixtureRef) -> ExtractResult:
    """Cut the listing down to the snapshot ``?snapshot=n`` asks for.

    A watched source is only interesting *over time*, and a recorded fixture has no time. So
    one recording holds the longest listing and the ``snapshots`` block says how many entries
    each earlier moment had: ``?snapshot=1`` is yesterday, ``?snapshot=2`` is today with one
    more video. An unknown or absent snapshot is the whole listing.
    """
    wanted = ref.params.get("snapshot")
    if wanted is None:
        return result
    sizes = cast(dict[str, Any], payload.get("snapshots") or {})
    size = sizes.get(str(wanted))
    if not isinstance(size, int):
        raise ToolboxError(
            ErrorCode.FIXTURE_UNKNOWN,
            f"Fixture '{ref.name}' has no snapshot '{wanted}'.",
            details={"requested": ref.canonical, "snapshots": sorted(sizes)},
        )
    return result.model_copy(update={"entries": result.entries[:size]})


def _flatten(result: ExtractResult) -> ExtractResult:
    """What `/extract?flat=true` answers: the listing, without the per-video payload.

    The recordings are full extractions, so flattening them here is what keeps the fixture
    honest — a caller that reads a description out of a flat answer would work offline and
    fail against the real thing, which is the one bug a fixture must not be able to hide.
    """
    return result.model_copy(
        update={
            "entries": [
                entry.model_copy(
                    update={
                        "description": None,
                        "thumbnails": [],
                        "track": None,
                        "artist": None,
                        "album": None,
                        "release_year": None,
                        "uploader": None,
                        "playlist_index": entry.playlist_index or entry.index + 1,
                    }
                )
                for entry in result.entries
            ]
        }
    )


def extract(url: str, *, flat: bool = False) -> ExtractResult:
    """The recorded `/extract` answer for a fixture URL."""
    # `?extractslow=<ms>`: the scenario switch for a source that takes its time. See
    # `config.fixture_extract_delay_seconds` for why an instant extraction hides a whole
    # class of bug. Zero, and a no-op, for every URL that does not ask.
    delay = fixture_extract_delay_seconds(url)
    if delay > 0:
        time.sleep(delay)
    ref = require_ref(url)
    payload = load(ref.name)
    result = _snapshot(ExtractResult.model_validate(payload["extract"]), payload, ref)
    if flat and ref.index is None:
        return _flatten(result)
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


def _derived_fingerprint(entry: dict[str, Any]) -> FingerprintResult:
    """A fingerprint that identifies *this* entry, derived from it deterministically.

    The recorded ``fingerprint`` block describes the first entry of a fixture. Returning it for
    every file of a fifteen-video playlist would make an orchestrator that compares the result
    with its mapping see thirteen disagreements on a run where nothing is wrong. So every other
    entry gets a fingerprint of its own: the same shape, the same kind of ids (a UUIDv5, as the
    rest of the recorded data uses), seeded by the video id so it never moves.
    """
    seed = str(entry["id"])
    digest = hashlib.sha256(f"mm-fixture-fingerprint:{seed}".encode()).digest()
    return FingerprintResult(
        fingerprint=base64.b64encode(digest * 4).decode("ascii"),
        duration=float(entry.get("duration") or 0.0),
        candidates=[
            FingerprintCandidate(
                recording_mbid=str(uuid.uuid5(uuid.NAMESPACE_URL, f"mm-fixture-recording:{seed}")),
                score=0.98,
                title=str(entry.get("track") or entry.get("title") or ""),
                artist=str(entry.get("artist") or entry.get("uploader") or ""),
            )
        ],
    )


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

    if mismatch and "fingerprint_mismatch" in payload:
        raw = cast(dict[str, Any], payload["fingerprint_mismatch"])
    elif ref is not None and ref.index:
        # Entry 0 keeps the recorded block; the rest are derived from the entry itself.
        return _derived_fingerprint(select_entry(ref.canonical + f"#{ref.index}"))
    else:
        raw = cast(dict[str, Any], payload["fingerprint"])

    return FingerprintResult(
        fingerprint=str(raw["fingerprint"]),
        duration=float(raw["duration"]),
        candidates=[
            FingerprintCandidate.model_validate(item)
            for item in cast(list[dict[str, Any]], raw["candidates"])
        ],
    )
