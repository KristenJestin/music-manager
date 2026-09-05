"""Tag writing per format: Vorbis, ID3v2.4 and MP4, each read back from disk."""

from __future__ import annotations

import base64
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from mutagen.flac import Picture
from mutagen.id3 import ID3
from mutagen.mp4 import MP4
from mutagen.oggopus import OggOpus

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import Picture as PictureModel
from toolbox.models import Tag, TagFormat, TagRequest
from toolbox.tagging import detect_format, read_tags, write_tags
from toolbox.tagmap import freeform_name, split_performer

LRC = "[00:12.00]One more time\n[00:15.50]We're gonna celebrate\n"


def tags(*pairs: tuple[str, str]) -> list[Tag]:
    return [Tag(key=key, value=value) for key, value in pairs]


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("a.opus", TagFormat.VORBIS),
        ("a.flac", TagFormat.VORBIS),
        ("a.ogg", TagFormat.VORBIS),
        ("a.mp3", TagFormat.ID3),
        ("a.m4a", TagFormat.MP4),
    ],
)
def test_format_detection_reads_the_extension(name: str, expected: TagFormat):
    assert detect_format(Path(name)) is expected


def test_an_unsupported_container_is_a_tag_error():
    with pytest.raises(ToolboxError) as raised:
        detect_format(Path("a.wav"))
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED


# --------------------------------------------------------------------------------------
# Vorbis (Opus)
# --------------------------------------------------------------------------------------


def test_vorbis_writes_uppercase_keys_one_entry_per_value(opus_file: Path):
    result = write_tags(
        TagRequest(
            path=str(opus_file),
            tags=tags(
                ("title", "One More Time"),
                ("ARTISTS", "Daft Punk"),
                ("ARTISTS", "Romanthony"),
                ("GENRE", "french house"),
            ),
        )
    )
    assert result.readback["TITLE"] == ["One More Time"]
    assert result.readback["ARTISTS"] == ["Daft Punk", "Romanthony"]
    assert result.written == 4


def test_vorbis_picture_lands_in_metadata_block_picture(opus_file: Path, tiny_jpeg_base64: str):
    write_tags(
        TagRequest(
            path=str(opus_file),
            tags=tags(("TITLE", "One More Time")),
            pictures=[PictureModel(type=3, mime="image/jpeg", data_base64=tiny_jpeg_base64)],
        )
    )
    raw = cast(Any, OggOpus(opus_file))
    encoded = raw["METADATA_BLOCK_PICTURE"]
    assert len(encoded) == 1
    block = cast(Any, Picture(base64.b64decode(cast(str, encoded[0]))))
    assert block.mime == "image/jpeg"
    assert block.type == 3
    assert block.data == base64.b64decode(tiny_jpeg_base64)
    # The picture must not leak into the readback as a tag.
    assert "METADATA_BLOCK_PICTURE" not in read_tags(opus_file)


def test_clear_drops_everything_that_was_there(opus_file: Path):
    write_tags(TagRequest(path=str(opus_file), tags=tags(("OLDKEY", "stale"))))
    result = write_tags(TagRequest(path=str(opus_file), tags=tags(("TITLE", "Fresh")), clear=True))
    assert result.readback == {"TITLE": ["Fresh"]}


def test_lyrics_are_written_unsynced_and_as_a_sidecar(opus_file: Path):
    result = write_tags(TagRequest(path=str(opus_file), lyrics_lrc=LRC, sidecar_lrc=True))
    assert result.readback["LYRICS"] == ["One more time\nWe're gonna celebrate"]
    assert result.sidecar_path is not None
    sidecar = Path(result.sidecar_path)
    assert sidecar.name == "sample.lrc"
    assert sidecar.read_text(encoding="utf-8") == LRC


def test_no_sidecar_unless_it_was_asked_for(opus_file: Path):
    result = write_tags(TagRequest(path=str(opus_file), lyrics_lrc=LRC))
    assert result.sidecar_path is None
    assert not (opus_file.with_suffix(".lrc")).exists()


def test_tagging_a_missing_file_is_a_tag_error(tmp_path: Path):
    with pytest.raises(ToolboxError) as raised:
        write_tags(TagRequest(path=str(tmp_path / "nope.opus")))
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED


def test_a_broken_picture_is_a_tag_error(opus_file: Path):
    with pytest.raises(ToolboxError) as raised:
        write_tags(
            TagRequest(
                path=str(opus_file),
                pictures=[PictureModel(data_base64="not base64 at all!!")],
            )
        )
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED


# --------------------------------------------------------------------------------------
# ID3v2.4
# --------------------------------------------------------------------------------------


def test_id3_writes_the_awkward_frames(mp3_file: Path, tiny_jpeg_base64: str):
    result = write_tags(
        TagRequest(
            path=str(mp3_file),
            tags=tags(
                ("TITLE", "One More Time"),
                ("ARTIST", "Daft Punk"),
                ("ARTISTS", "Daft Punk"),
                ("TRACKNUMBER", "1"),
                ("TRACKTOTAL", "14"),
                ("DISCNUMBER", "1"),
                ("DISCTOTAL", "1"),
                ("PRODUCER", "Thomas Bangalter"),
                ("MIXER", "Guy-Manuel de Homem-Christo"),
                ("PERFORMER", "Romanthony (vocals)"),
                ("MUSICBRAINZ_TRACKID", "b8ba3f4e-9d1e-4a1f-9d3f-2f1a5f0c1b4a"),
                ("MUSICBRAINZ_ALBUMID", "c6ea1d33-0b1c-4d54-9d1b-0a1b2c3d4e5f"),
                ("WEBSITE", "https://daftpunk.com"),
                ("COMMENT", "Source: youtu.be/x"),
            ),
            lyrics_lrc=LRC,
            pictures=[PictureModel(data_base64=tiny_jpeg_base64)],
            clear=True,
        )
    )
    raw = cast(Any, ID3(mp3_file))
    assert raw.version[:2] == (2, 4)

    # TIPL for production roles, TMCL for performance credits.
    assert dict(raw["TIPL"].people) == {
        "producer": "Thomas Bangalter",
        "mix": "Guy-Manuel de Homem-Christo",
    }
    assert dict(raw["TMCL"].people) == {"vocals": "Romanthony"}
    # UFID for the recording MBID, TXXX (Picard casing) for the others.
    assert raw["UFID:http://musicbrainz.org"].data.decode() == (
        "b8ba3f4e-9d1e-4a1f-9d3f-2f1a5f0c1b4a"
    )
    assert raw["TXXX:MusicBrainz Album Id"].text == ["c6ea1d33-0b1c-4d54-9d1b-0a1b2c3d4e5f"]
    assert raw["TXXX:Artists"].text == ["Daft Punk"]
    # Compound frames.
    assert raw["TRCK"].text == ["1/14"]
    assert raw["TPOS"].text == ["1/1"]
    assert raw["WOAR:https://daftpunk.com"].url == "https://daftpunk.com"
    assert raw.getall("APIC")

    # SYLT carries the synchronised lyrics, USLT the flattened ones.
    sylt = raw.getall("SYLT")[0]
    assert sylt.text == [("One more time", 12000), ("We're gonna celebrate", 15500)]
    assert raw.getall("USLT")[0].text == "One more time\nWe're gonna celebrate"

    assert result.readback["TRACKNUMBER"] == ["1"]
    assert result.readback["TRACKTOTAL"] == ["14"]
    assert result.readback["PRODUCER"] == ["Thomas Bangalter"]
    assert result.readback["PERFORMER"] == ["Romanthony (vocals)"]
    assert result.readback["MUSICBRAINZ_TRACKID"] == ["b8ba3f4e-9d1e-4a1f-9d3f-2f1a5f0c1b4a"]


def test_id3_track_number_without_a_total(mp3_file: Path):
    write_tags(TagRequest(path=str(mp3_file), tags=tags(("TRACKNUMBER", "7")), clear=True))
    assert cast(Any, ID3(mp3_file))["TRCK"].text == ["7"]


# --------------------------------------------------------------------------------------
# MP4
# --------------------------------------------------------------------------------------


def test_mp4_writes_atoms_pairs_and_freeform(m4a_file: Path, tiny_jpeg_base64: str):
    result = write_tags(
        TagRequest(
            path=str(m4a_file),
            tags=tags(
                ("TITLE", "One More Time"),
                ("ALBUMARTIST", "Daft Punk"),
                ("TRACKNUMBER", "1"),
                ("TRACKTOTAL", "14"),
                ("COMPILATION", "1"),
                ("BPM", "123"),
                ("MUSICBRAINZ_ALBUMID", "c6ea1d33-0b1c-4d54-9d1b-0a1b2c3d4e5f"),
                ("RELEASETYPE", "album"),
            ),
            pictures=[PictureModel(data_base64=tiny_jpeg_base64)],
            clear=True,
        )
    )
    raw = cast(Any, MP4(m4a_file))
    assert raw["\xa9nam"] == ["One More Time"]
    assert raw["aART"] == ["Daft Punk"]
    assert raw["trkn"] == [(1, 14)]
    assert raw["cpil"] is True
    assert raw["tmpo"] == [123]
    assert bytes(raw["----:com.apple.iTunes:MusicBrainz Album Id"][0]).decode() == (
        "c6ea1d33-0b1c-4d54-9d1b-0a1b2c3d4e5f"
    )
    assert bytes(raw["----:com.apple.iTunes:MusicBrainz Album Type"][0]).decode() == "album"
    assert raw["covr"]

    assert result.readback["TRACKNUMBER"] == ["1"]
    assert result.readback["TRACKTOTAL"] == ["14"]
    assert result.readback["COMPILATION"] == ["1"]


# --------------------------------------------------------------------------------------
# The tag map itself
# --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("MUSICBRAINZ_ALBUMID", "MusicBrainz Album Id"),
        ("RELEASETYPE", "MusicBrainz Album Type"),
        ("ARTISTS", "Artists"),
        ("ACOUSTID_ID", "Acoustid Id"),
        ("MUSICMANAGER_TAGSCHEMA", "MUSICMANAGER_TAGSCHEMA"),
    ],
)
def test_freeform_names_follow_picard(key: str, expected: str):
    assert freeform_name(key) == expected


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("Nile Rodgers (guitar)", ("guitar", "Nile Rodgers")),
        ("Romanthony (lead vocals)", ("lead vocals", "Romanthony")),
        ("Someone", ("", "Someone")),
    ],
)
def test_performer_credits_split_into_role_and_name(value: str, expected: tuple[str, str]):
    assert split_performer(value) == expected


# --------------------------------------------------------------------------------------
# Over HTTP
# --------------------------------------------------------------------------------------


def test_tag_endpoint_returns_the_readback(client: TestClient, opus_file: Path):
    response = client.post(
        "/tag",
        json={
            "path": str(opus_file),
            "tags": [{"key": "TITLE", "value": "One More Time"}],
            "clear": True,
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["format"] == "vorbis"
    assert payload["readback"]["TITLE"] == ["One More Time"]
    assert payload["size"] == opus_file.stat().st_size
