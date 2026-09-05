"""`POST /place`: atomic move, folder creation, and the three conflict policies."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import OnExists, PlaceRequest
from toolbox.place import place, unique_path


def _src(tmp_path: Path, content: bytes = b"audio") -> Path:
    path = tmp_path / "work" / "download.opus"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def test_place_creates_the_artist_and_album_folders(tmp_path: Path):
    src = _src(tmp_path)
    dest = tmp_path / "library" / "Daft Punk" / "Discovery (2001)" / "01 One More Time.opus"
    result = place(PlaceRequest(src=str(src), dest=str(dest)))
    assert result.moved is True
    assert result.path == str(dest)
    assert dest.read_bytes() == b"audio"
    assert not src.exists()
    assert result.size == 5


def test_skip_leaves_the_existing_file_alone(tmp_path: Path):
    src = _src(tmp_path, b"new")
    dest = tmp_path / "library" / "track.opus"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"old")
    result = place(PlaceRequest(src=str(src), dest=str(dest), on_exists=OnExists.SKIP))
    assert result.moved is False
    assert dest.read_bytes() == b"old"
    assert src.exists()


def test_overwrite_replaces_it(tmp_path: Path):
    src = _src(tmp_path, b"new")
    dest = tmp_path / "library" / "track.opus"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"old")
    result = place(PlaceRequest(src=str(src), dest=str(dest), on_exists=OnExists.OVERWRITE))
    assert result.moved is True
    assert dest.read_bytes() == b"new"


def test_keep_both_numbers_the_new_file(tmp_path: Path):
    src = _src(tmp_path, b"new")
    dest = tmp_path / "library" / "track.opus"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"old")
    result = place(PlaceRequest(src=str(src), dest=str(dest), on_exists=OnExists.KEEP_BOTH))
    assert Path(result.path).name == "track (2).opus"
    assert dest.read_bytes() == b"old"
    assert Path(result.path).read_bytes() == b"new"


def test_keep_both_keeps_counting(tmp_path: Path):
    dest = tmp_path / "track.opus"
    dest.write_bytes(b"a")
    (tmp_path / "track (2).opus").write_bytes(b"b")
    assert unique_path(dest).name == "track (3).opus"


def test_no_policy_means_a_conflict_is_an_error(tmp_path: Path):
    src = _src(tmp_path)
    dest = tmp_path / "library" / "track.opus"
    dest.parent.mkdir(parents=True)
    dest.write_bytes(b"old")
    with pytest.raises(ToolboxError) as raised:
        place(PlaceRequest(src=str(src), dest=str(dest)))
    assert raised.value.code is ErrorCode.PLACE_CONFLICT
    assert raised.value.status == 409


def test_placing_a_file_onto_itself_is_idempotent(tmp_path: Path):
    """The pipeline replays steps; `place` must not explode the second time."""
    src = _src(tmp_path)
    result = place(PlaceRequest(src=str(src), dest=str(src)))
    assert result.moved is False
    assert src.exists()


def test_a_directory_at_the_destination_is_a_conflict(tmp_path: Path):
    src = _src(tmp_path)
    dest = tmp_path / "library" / "track.opus"
    dest.mkdir(parents=True)
    with pytest.raises(ToolboxError) as raised:
        place(PlaceRequest(src=str(src), dest=str(dest)))
    assert raised.value.code is ErrorCode.PLACE_CONFLICT


def test_a_missing_source_is_a_404(client: TestClient, tmp_path: Path):
    response = client.post(
        "/place", json={"src": str(tmp_path / "nope.opus"), "dest": str(tmp_path / "a.opus")}
    )
    assert response.status_code == 404
