"""The golden Opus test: the full projection, written and read back byte-for-byte.

This is the phase's core claim — *the maximum of valid tags per track* — checked on one
file. The tag list is the golden projection of Daft Punk — Discovery, track 1: P01's
`packages/domain/golden/discovery/01-one-more-time.vorbis.txt` when it exists, otherwise
this suite's own copy. The test writes it onto a copy of the bundled sample, reads it back
with mutagen, and asserts equality including multi-valued keys and their order.

`ffprobe` sees the same thing when it is available (i.e. inside the toolbox image), which is
the independent second opinion: mutagen agreeing with mutagen would prove nothing.
"""

from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest
from mutagen.flac import Picture
from mutagen.oggopus import OggOpus

from tests.conftest import (
    golden_expected,
    golden_lrc,
    golden_pairs,
    golden_path,
    golden_pictures,
    requires,
)
from toolbox.models import Picture as PictureModel
from toolbox.models import Tag, TagRequest
from toolbox.replaygain import r128_gain
from toolbox.tagging import read_tags, write_tags


@pytest.fixture
def tagged(opus_file: Path, tiny_jpeg_base64: str) -> dict[str, list[str]]:
    """The bundled sample, carrying the whole golden projection, read back from disk."""
    write_tags(
        TagRequest(
            path=str(opus_file),
            tags=[Tag(key=key, value=value) for key, value in golden_pairs()],
            pictures=[
                PictureModel(
                    type=kind,
                    mime=mime,
                    data_base64=tiny_jpeg_base64,
                    description="Front cover" if kind == 3 else "Back cover",
                )
                for kind, mime in golden_pictures()
            ],
            lyrics_lrc=golden_lrc(),
            sidecar_lrc=True,
            clear=True,
        )
    )
    return read_tags(opus_file)


def test_the_golden_file_is_a_real_projection():
    """Guard against silently testing an empty list if the golden file moves."""
    keys = {key for key, _ in golden_pairs()}
    assert {"TITLE", "ARTIST", "ALBUM", "MUSICBRAINZ_TRACKID", "REPLAYGAIN_TRACK_GAIN"} <= keys
    assert len(golden_pairs()) > 50, golden_path()


def test_the_golden_projection_reads_back_exactly(tagged: dict[str, list[str]]):
    assert tagged == golden_expected()


def test_the_golden_projection_keeps_multi_valued_order(tagged: dict[str, list[str]]):
    """Vorbis stores one entry per value; the order carries meaning (artist credits)."""
    multi = {key: values for key, values in golden_expected().items() if len(values) > 1}
    assert multi, "the golden projection has no multi-valued tag left to check"
    for key, values in multi.items():
        assert tagged[key] == values


def test_the_golden_projection_carries_both_replaygain_dialects(tagged: dict[str, list[str]]):
    """Opus needs REPLAYGAIN_* *and* R128_* — docs/03-metadonnees.md §2.6."""
    track_gain = float(tagged["REPLAYGAIN_TRACK_GAIN"][0].removesuffix(" dB"))
    album_gain = float(tagged["REPLAYGAIN_ALBUM_GAIN"][0].removesuffix(" dB"))
    reference = float(tagged["REPLAYGAIN_REFERENCE_LOUDNESS"][0].removesuffix(" LUFS"))
    assert int(tagged["R128_TRACK_GAIN"][0]) == r128_gain(track_gain, reference)
    assert int(tagged["R128_ALBUM_GAIN"][0]) == r128_gain(album_gain, reference)


def test_the_golden_file_carries_a_front_cover(
    tagged: dict[str, list[str]], opus_file: Path, tiny_jpeg_base64: str
):
    assert "METADATA_BLOCK_PICTURE" not in tagged, "the cover must not leak into the readback"
    encoded = cast("list[str]", cast(Any, OggOpus(opus_file))["METADATA_BLOCK_PICTURE"])
    assert len(encoded) == len(golden_pictures())
    front = cast(Any, Picture(base64.b64decode(encoded[0])))
    assert front.type == 3
    assert front.mime == "image/jpeg"
    assert front.desc == "Front cover"
    assert front.data == base64.b64decode(tiny_jpeg_base64)


def test_the_golden_file_has_an_lrc_sidecar(tagged: dict[str, list[str]], opus_file: Path):
    sidecar = opus_file.with_suffix(".lrc")
    assert sidecar.is_file()
    assert sidecar.read_text(encoding="utf-8") == golden_lrc()
    assert "[0" in sidecar.read_text(encoding="utf-8"), "the sidecar must stay synchronised"


def test_the_lyrics_tag_holds_the_synchronised_lyrics(tagged: dict[str, list[str]]):
    assert tagged["LYRICS"] == [golden_lrc()]


@requires("ffprobe")
def test_ffprobe_sees_the_same_tags(tagged: dict[str, list[str]], opus_file: Path):
    """The independent read: a different library, in a different process."""
    completed = subprocess.run(
        [
            "ffprobe",
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(opus_file),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=True,
    )
    payload = cast("dict[str, Any]", json.loads(completed.stdout))
    # Ogg keeps its comments on the stream, not on the container, so merge both.
    streams = cast("list[dict[str, Any]]", payload.get("streams", []))
    blocks: list[dict[str, Any]] = [cast("dict[str, Any]", payload.get("format", {}))]
    # Skip the attached-picture stream: its `title` is "Front cover", not the track's.
    blocks += [stream for stream in streams if stream.get("codec_type") != "video"]
    seen: dict[str, str] = {}
    for block in blocks:
        for key, value in cast("dict[str, str]", block.get("tags", {})).items():
            seen[key.upper()] = value
    expected = golden_expected()
    for key in ("TITLE", "ARTIST", "ALBUM", "DATE", "MUSICBRAINZ_TRACKID"):
        assert seen[key] == expected[key][0], key
    # ffprobe renames TRACKNUMBER to its own vocabulary and joins repeated comments with ";".
    assert seen["TRACK"] == expected["TRACKNUMBER"][0]
    assert seen["GENRE"] == ";".join(expected["GENRE"])
    # ffprobe turns METADATA_BLOCK_PICTURE into an attached-picture stream rather than a tag.
    assert any(stream.get("codec_type") == "video" for stream in streams)
