"""`POST /fingerprint` — Chromaprint via `fpcalc`, then AcoustID if a key is given.

The fingerprint is computed locally and is always returned; the AcoustID lookup is the only
network call, and it is skipped when no key is available. In fixtures mode the whole thing
is a recording, including the deliberate ``?fp=mismatch`` disagreement that feeds the
`fingerprint_mismatch` Inbox item.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final, cast

import httpx2 as httpx
import structlog

from toolbox import fixtures
from toolbox.config import acoustid_key, fixtures_enabled
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import FingerprintCandidate, FingerprintRequest, FingerprintResult
from toolbox.subprocesses import run_tool

__all__ = ["ACOUSTID_URL", "fingerprint"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.fingerprint")

ACOUSTID_URL: Final[str] = "https://api.acoustid.org/v2/lookup"
_TIMEOUT: Final[float] = 15.0


def _fpcalc(path: Path) -> tuple[str, float]:
    completed = run_tool("fpcalc", ["-json", str(path)], timeout=120)
    payload = cast(dict[str, Any], json.loads(completed.stdout or "{}"))
    value = payload.get("fingerprint")
    duration = payload.get("duration")
    if not isinstance(value, str) or not value:
        raise ToolboxError(
            ErrorCode.UNKNOWN, "fpcalc produced no fingerprint.", details={"path": str(path)}
        )
    return value, float(duration) if isinstance(duration, (int, float)) else 0.0


def _lookup(key: str, value: str, duration: float) -> list[FingerprintCandidate]:
    """Ask AcoustID which recordings this fingerprint belongs to."""
    params = {
        "client": key,
        "duration": str(round(duration)),
        "fingerprint": value,
        "meta": "recordings",
        "format": "json",
    }
    with httpx.Client(timeout=_TIMEOUT) as client:
        response = client.post(ACOUSTID_URL, data=params)
        response.raise_for_status()
        payload = cast(dict[str, Any], response.json())

    candidates: list[FingerprintCandidate] = []
    for item in cast(list[Any], payload.get("results") or []):
        if not isinstance(item, dict):
            continue
        result = cast(dict[str, Any], item)
        score = float(result.get("score") or 0.0)
        for rec in cast(list[Any], result.get("recordings") or []):
            if not isinstance(rec, dict):
                continue
            recording = cast(dict[str, Any], rec)
            mbid = recording.get("id")
            if not isinstance(mbid, str):
                continue
            artists = cast(list[Any], recording.get("artists") or [])
            artist = None
            if artists and isinstance(artists[0], dict):
                name = cast(dict[str, Any], artists[0]).get("name")
                artist = str(name) if name else None
            candidates.append(
                FingerprintCandidate(
                    recording_mbid=mbid,
                    score=score,
                    title=str(recording["title"]) if recording.get("title") else None,
                    artist=artist,
                )
            )
    candidates.sort(key=lambda candidate: candidate.score, reverse=True)
    return candidates


def fingerprint(request: FingerprintRequest) -> FingerprintResult:
    """Fingerprint one file, and resolve it against AcoustID when a key is available."""
    path = Path(request.path)
    if fixtures_enabled():
        return fixtures.fingerprint_for(path)

    if not path.is_file():
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"No such file: {path}", status=404, details={"path": str(path)}
        )

    value, duration = _fpcalc(path)
    key = (request.acoustid_key or acoustid_key()).strip()
    if not key:
        return FingerprintResult(fingerprint=value, duration=duration, candidates=None)

    try:
        candidates = _lookup(key, value, duration)
    except httpx.HTTPError as exc:
        log.warning("acoustid.failed", error=str(exc))
        raise ToolboxError(ErrorCode.UNKNOWN, f"AcoustID lookup failed: {exc}", status=502) from exc
    return FingerprintResult(fingerprint=value, duration=duration, candidates=candidates)
