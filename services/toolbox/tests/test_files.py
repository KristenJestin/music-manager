"""`/probe`, `/fingerprint` and `/artwork/prepare`.

The two that shell out are unit tested with the subprocess mocked, and also run for real
when the binary exists (i.e. inside the toolbox image).
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from tests.conftest import requires
from toolbox import fingerprint as fp_module
from toolbox import probe as probe_module
from toolbox.artwork import prepare
from toolbox.errors import ErrorCode
from toolbox.models import ArtworkRequest, FingerprintRequest, Tag, TagRequest
from toolbox.tagging import write_tags

FFPROBE_JSON = {
    "format": {
        "format_name": "ogg",
        "duration": "5.000000",
        "bit_rate": "121504",
        "tags": {"TITLE": "One More Time", "artist": "Daft Punk", "MUSICBRAINZ_TRACKID": "abc"},
    },
    "streams": [
        {
            "index": 0,
            "codec_name": "opus",
            "codec_type": "audio",
            "sample_rate": "48000",
            "channels": 2,
            "tags": {"language": "eng"},
        }
    ],
}


# --------------------------------------------------------------------------------------
# /probe
# --------------------------------------------------------------------------------------


def test_probe_returns_every_tag_it_finds(opus_file: Path, monkeypatch: pytest.MonkeyPatch):
    def fake_run_tool(_name: str, _args: Any, **__: Any) -> Any:
        class Completed:
            stdout = json.dumps(FFPROBE_JSON)

        return Completed()

    monkeypatch.setattr(probe_module, "run_tool", fake_run_tool)
    result = probe_module.probe(str(opus_file))
    assert result.codec == "opus"
    assert result.duration == 5.0
    assert result.sample_rate == 48000
    assert result.channels == 2
    assert result.size == opus_file.stat().st_size
    # Container and stream tags, all of them, upper-cased.
    assert result.tags["TITLE"] == "One More Time"
    assert result.tags["ARTIST"] == "Daft Punk"
    assert result.tags["MUSICBRAINZ_TRACKID"] == "abc"
    assert result.tags["LANGUAGE"] == "eng"


def test_probe_of_a_missing_file_is_a_404(client: TestClient, tmp_path: Path):
    response = client.post("/probe", json={"path": str(tmp_path / "nope.opus")})
    assert response.status_code == 404


@requires("ffprobe")
def test_a_real_probe_sees_the_tags_that_were_written(opus_file: Path):
    write_tags(
        TagRequest(
            path=str(opus_file),
            tags=[Tag(key="TITLE", value="One More Time"), Tag(key="ARTIST", value="Daft Punk")],
            clear=True,
        )
    )
    result = probe_module.probe(str(opus_file))
    assert result.codec == "opus"
    assert result.tags["TITLE"] == "One More Time"
    assert result.tags["ARTIST"] == "Daft Punk"
    assert 4.5 < (result.duration or 0) < 5.5


# --------------------------------------------------------------------------------------
# /fingerprint
# --------------------------------------------------------------------------------------


def test_fingerprint_without_a_key_returns_no_candidates(
    opus_file: Path, monkeypatch: pytest.MonkeyPatch, offline: None
):
    def fake_run_tool(_name: str, _args: Any, **__: Any) -> Any:
        class Completed:
            stdout = json.dumps({"duration": 5.0, "fingerprint": "AQADtEmi"})

        return Completed()

    monkeypatch.setattr(fp_module, "run_tool", fake_run_tool)
    monkeypatch.delenv("MM_ACOUSTID_KEY", raising=False)
    result = fp_module.fingerprint(FingerprintRequest(path=str(opus_file)))
    assert result.fingerprint == "AQADtEmi"
    assert result.duration == 5.0
    assert result.candidates is None


def test_the_fixture_fingerprint_is_recorded(fixture_client: TestClient, opus_file: Path):
    payload = fixture_client.post("/fingerprint", json={"path": str(opus_file)}).json()
    assert payload["candidates"][0]["recording_mbid"]
    assert payload["candidates"][0]["score"] > 0.9


@requires("fpcalc")
def test_a_real_fingerprint(opus_file: Path, offline: None):
    result = fp_module.fingerprint(FingerprintRequest(path=str(opus_file)))
    assert len(result.fingerprint) > 20
    assert 4.5 < result.duration < 5.5


# --------------------------------------------------------------------------------------
# /artwork/prepare
# --------------------------------------------------------------------------------------


def _png(width: int, height: int) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (12, 34, 56)).save(buffer, format="PNG")
    return buffer.getvalue()


def test_artwork_crops_a_wide_image_to_a_square(tmp_path: Path, offline: None):
    source = tmp_path / "thumb.png"
    source.write_bytes(_png(1280, 720))
    result = prepare(ArtworkRequest(path=str(source), size=500, square=True))
    assert (result.width, result.height) == (500, 500)
    assert result.mime == "image/jpeg"
    assert result.source == "path"
    decoded = Image.open(io.BytesIO(base64.b64decode(result.data_base64)))
    assert decoded.format == "JPEG"


def test_artwork_does_not_upscale(tmp_path: Path, offline: None):
    source = tmp_path / "small.png"
    source.write_bytes(_png(200, 200))
    result = prepare(ArtworkRequest(path=str(source), size=1200))
    assert (result.width, result.height) == (200, 200)


def test_artwork_can_keep_the_original_aspect(tmp_path: Path, offline: None):
    source = tmp_path / "wide.png"
    source.write_bytes(_png(1000, 500))
    result = prepare(ArtworkRequest(path=str(source), size=400, square=False))
    assert (result.width, result.height) == (400, 200)


def test_fixtures_mode_generates_a_cover_instead_of_fetching(fixture_client: TestClient):
    response = fixture_client.post(
        "/artwork/prepare", json={"url": "https://coverartarchive.org/x/front", "size": 256}
    )
    payload = response.json()
    assert payload["source"] == "fixture"
    assert (payload["width"], payload["height"]) == (256, 256)
    # Deterministic: the same URL always produces the same cover.
    again = fixture_client.post(
        "/artwork/prepare", json={"url": "https://coverartarchive.org/x/front", "size": 256}
    ).json()
    assert again["data_base64"] == payload["data_base64"]


def test_artwork_needs_a_url_or_a_path(client: TestClient):
    response = client.post("/artwork/prepare", json={"size": 300})
    assert response.status_code == 422
    assert response.json()["code"] == ErrorCode.UNKNOWN.value


def test_artwork_rejects_something_that_is_not_an_image(client: TestClient, tmp_path: Path):
    source = tmp_path / "notes.txt"
    source.write_text("not a picture", encoding="utf-8")
    response = client.post("/artwork/prepare", json={"path": str(source)})
    assert response.status_code == 422


def test_the_fixture_fingerprint_identifies_the_entry_that_was_downloaded(
    fixture_client: TestClient, tmp_path: Path
):
    """One recorded block would make thirteen of fourteen tracks look like a mismatch.

    `/download` notes which fixture URL produced each file; `/fingerprint` reads that note and
    answers about *that* entry. Without this, an orchestrator comparing the fingerprint with
    its mapping sees a disagreement on every track but the first.
    """
    for index in (0, 1, 5):
        fixture_client.post(
            "/download",
            json={
                "url": f"fixture://discovery#{index}",
                "dest_dir": str(tmp_path),
                "id": f"track-{index}",
            },
        )

    titles = {}
    for index in (0, 1, 5):
        payload = fixture_client.post(
            "/fingerprint", json={"path": str(tmp_path / f"track-{index}.opus")}
        ).json()
        titles[index] = payload["candidates"][0]["title"]
        assert payload["candidates"][0]["score"] > 0.9

    assert titles[0] == "One More Time"
    assert titles[1] == "Aerodynamic"
    assert titles[5] == "Nightvision"


def test_the_mismatch_fixture_still_names_another_recording(
    fixture_client: TestClient, tmp_path: Path
):
    fixture_client.post(
        "/download",
        json={
            "url": "fixture://discovery?fp=mismatch#0",
            "dest_dir": str(tmp_path),
            "id": "wrong",
        },
    )
    payload = fixture_client.post(
        "/fingerprint", json={"path": str(tmp_path / "wrong.opus")}
    ).json()
    assert payload["candidates"][0]["title"] != "One More Time"
