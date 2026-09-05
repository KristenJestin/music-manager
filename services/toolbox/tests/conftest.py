"""Shared test fixtures. No network, ever — see CLAUDE.md.

The media binaries live in the Docker image, so the tests that genuinely need `ffprobe`,
`fpcalc` or `rsgain` skip themselves when the binary is absent instead of failing: a bare
`pytest` on a developer machine must stay green, and the same suite proves more when it runs
inside the toolbox image.
"""

from __future__ import annotations

import base64
import shutil
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from toolbox.app import app
from toolbox.fixtures import sample_opus

TESTS_DIR = Path(__file__).parent
DATA_DIR = TESTS_DIR / "data"
GOLDEN_DIR = TESTS_DIR / "golden"

#: P01 publishes the authoritative projection; until it lands, this suite carries its own.
DOMAIN_GOLDEN_DIR = TESTS_DIR.parents[2] / "packages" / "domain" / "golden" / "discovery"

#: A 1x1 JPEG. Small enough to inline, real enough for Pillow and mutagen to accept.
TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffff"
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc20011"
    "08000100010101110000ffc40014000100000000000000000000000000000009ffda0008010100000000"
    "01"
)


def requires(tool: str) -> pytest.MarkDecorator:
    """Skip a test when a media binary is missing (i.e. outside the toolbox image)."""
    return pytest.mark.skipif(
        shutil.which(tool) is None, reason=f"{tool} lives in the toolbox image"
    )


@pytest.fixture
def fixtures_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MM_TOOLBOX_FIXTURES", "1")


@pytest.fixture
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MM_TOOLBOX_FIXTURES", raising=False)
    monkeypatch.delenv("MM_TOOLBOX_TOKEN", raising=False)


@pytest.fixture
def client(offline: None) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def fixture_client(fixtures_mode: None) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def live_server() -> Iterator[str]:
    """A real uvicorn on an ephemeral port, sharing this process's modules and environment.

    Needed for exactly one thing: proving that two *simultaneous* `POST /download` requests
    behave as specified. `TestClient` and the in-process ASGI transport both serialise or
    buffer, so neither can show the second request arriving while the first still holds the
    slot.
    """
    yield from _serve()


def _serve() -> Iterator[str]:
    import uvicorn

    config = uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="toolbox-test-server", daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        if time.monotonic() > deadline:  # pragma: no cover - only on a wedged machine
            raise RuntimeError("the test server did not start")
        time.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}"
    finally:
        server.should_exit = True
        thread.join(timeout=15)


def _copy(source: Path, tmp_path: Path) -> Path:
    target = tmp_path / source.name
    shutil.copy2(source, target)
    return target


@pytest.fixture
def opus_file(tmp_path: Path) -> Path:
    """A writable copy of the bundled five-second Opus sample."""
    return _copy(sample_opus(), tmp_path)


@pytest.fixture
def mp3_file(tmp_path: Path) -> Path:
    return _copy(DATA_DIR / "sample.mp3", tmp_path)


@pytest.fixture
def m4a_file(tmp_path: Path) -> Path:
    return _copy(DATA_DIR / "sample.m4a", tmp_path)


@pytest.fixture
def tiny_jpeg_base64() -> str:
    return base64.b64encode(TINY_JPEG).decode("ascii")


#: A picture line in a golden file is a *descriptor*, not base64: `<front image/jpeg> <url>`.
#: A golden file is meant to be read by a human, so the tests substitute real bytes for it.
PICTURE_KEYS = frozenset({"METADATA_BLOCK_PICTURE", "covr"})
PICTURE_TYPES = {"front": 3, "back": 4, "booklet": 5, "medium": 6}


def domain_golden(kind: str) -> Path | None:
    """P01's projection for one format, or ``None`` while P01 has not published it."""
    path = DOMAIN_GOLDEN_DIR / f"01-one-more-time.{kind}.txt"
    return path if path.is_file() else None


def _golden_lines(path: Path) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        # Golden files escape newlines so that a multi-line LRC stays on one line.
        pairs.append((key.strip(), value.replace("\\n", "\n")))
    return pairs


def golden_path(kind: str = "vorbis") -> Path:
    """P01's golden file when it exists, otherwise this suite's own copy."""
    return domain_golden(kind) or (GOLDEN_DIR / f"one-more-time.{kind}.txt")


def golden_pairs(kind: str = "vorbis") -> list[tuple[str, str]]:
    """Every ``(key, value)`` of a golden projection, pictures excluded."""
    return [
        (key.upper() if kind == "vorbis" else key, value)
        for key, value in _golden_lines(golden_path(kind))
        if key.split(":")[0] not in PICTURE_KEYS and not key.startswith("APIC")
    ]


def golden_pictures() -> list[tuple[int, str]]:
    """``(picture type, mime)`` for each picture the golden projection describes."""
    pictures: list[tuple[int, str]] = []
    for key, value in _golden_lines(golden_path()):
        if key not in PICTURE_KEYS:
            continue
        descriptor = value.partition(">")[0].lstrip("<").split()
        kind = descriptor[0] if descriptor else "front"
        mime = descriptor[1] if len(descriptor) > 1 else "image/jpeg"
        pictures.append((PICTURE_TYPES.get(kind, 3), mime))
    return pictures


def golden_expected(kind: str = "vorbis") -> dict[str, list[str]]:
    """The golden projection as the readback the toolbox must produce."""
    expected: dict[str, list[str]] = {}
    for key, value in golden_pairs(kind):
        expected.setdefault(key, []).append(value)
    return expected


def golden_lrc() -> str:
    """The synchronised lyrics: the golden LYRICS value, or the standalone `.lrc`."""
    for key, value in golden_pairs():
        if key == "LYRICS":
            return value
    return (GOLDEN_DIR / "one-more-time.lrc").read_text(encoding="utf-8")
