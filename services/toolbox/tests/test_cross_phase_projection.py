"""The toolbox's ID3 and MP4 encoding, checked against P01's golden projections.

`packages/domain` decides the tag *names*; the toolbox decides how each one is encoded.
Those two decisions are made in two languages by two phases, and the only way to know they
agree is to write P01's Vorbis projection onto a real MP3 and a real M4A and compare the
frames that come out with P01's own `*.id3.txt` and `*.mp4.txt`.

Skipped until P01 publishes those files.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest
from mutagen.id3 import ID3
from mutagen.mp4 import MP4

from tests.conftest import domain_golden, golden_expected, golden_lrc, golden_pairs
from toolbox.models import Tag, TagRequest
from toolbox.tagging import write_tags

#: Frames whose golden form is a descriptor rather than a value, compared separately.
SKIPPED_ID3 = frozenset({"APIC", "USLT", "SYLT"})
SKIPPED_MP4 = frozenset({"covr"})


def _write_golden_to(path: Path) -> None:
    write_tags(
        TagRequest(
            path=str(path),
            tags=[Tag(key=key, value=value) for key, value in golden_pairs()],
            lyrics_lrc=golden_lrc(),
            clear=True,
        )
    )


def _dump_id3(path: Path) -> dict[str, list[str]]:
    """Render an ID3 block in the notation P01's golden file uses."""
    out: dict[str, list[str]] = {}

    def add(key: str, value: str) -> None:
        out.setdefault(key, []).append(value)

    for frame in list(cast(Any, ID3(path)).values()):
        frame_id = str(frame.FrameID)
        if frame_id in SKIPPED_ID3:
            continue
        if frame_id == "TXXX":
            for value in frame.text:
                add(f"TXXX:{frame.desc}", str(value))
        elif frame_id == "UFID":
            add(f"UFID:{frame.owner}", bytes(frame.data).decode("utf-8"))
        elif frame_id in {"TIPL", "TMCL"}:
            for role, person in frame.people:
                add(f"{frame_id}:{role}", str(person))
        elif hasattr(frame, "url"):
            add(f"{frame_id}:{frame.url}", str(frame.url))
        else:
            for value in frame.text:
                add(frame_id, str(value))
    return out


def _dump_mp4(path: Path) -> dict[str, list[str]]:
    """Render an MP4 tag block in the notation P01's golden file uses."""
    out: dict[str, list[str]] = {}
    tags = cast("Any", MP4(path).tags)
    for atom, value in cast("list[tuple[str, Any]]", list(tags.items())):
        if atom in SKIPPED_MP4:
            continue
        if atom.startswith("----:"):
            out[atom] = [bytes(item).decode("utf-8") for item in value]
        elif atom in {"trkn", "disk"}:
            out[atom] = [f"{value[0][0]}/{value[0][1]}"]
        elif isinstance(value, bool):
            out[atom] = ["1" if value else "0"]
        else:
            out[atom] = [str(item) for item in value]
    return out


@pytest.mark.skipif(domain_golden("id3") is None, reason="P01 has not published the ID3 golden")
def test_the_id3_encoding_matches_the_domain_projection(mp3_file: Path):
    _write_golden_to(mp3_file)
    expected = golden_expected("id3")
    actual = _dump_id3(mp3_file)
    ignored = {key for key in expected if key.split(":")[0] in SKIPPED_ID3}
    assert actual == {key: values for key, values in expected.items() if key not in ignored}


@pytest.mark.skipif(domain_golden("mp4") is None, reason="P01 has not published the MP4 golden")
def test_the_mp4_encoding_matches_the_domain_projection(m4a_file: Path):
    _write_golden_to(m4a_file)
    expected = golden_expected("mp4")
    actual = _dump_mp4(m4a_file)
    ignored = {key for key in expected if key in SKIPPED_MP4}
    assert actual == {key: values for key, values in expected.items() if key not in ignored}


@pytest.mark.skipif(domain_golden("id3") is None, reason="P01 has not published the ID3 golden")
def test_the_lyrics_frames_match_the_domain_projection(mp3_file: Path):
    """USLT carries the flattened text, SYLT the timestamps — checked against P01's file."""
    _write_golden_to(mp3_file)
    tags = cast("Any", ID3(mp3_file))
    expected = golden_expected("id3")

    assert str(tags.getall("USLT")[0].text) == expected["USLT"][0]

    synced = cast("list[tuple[str, int]]", tags.getall("SYLT")[0].text)
    golden_lines = expected["SYLT"][0].splitlines()
    assert len(synced) == len(golden_lines)
    first_stamp, first_text = golden_lines[0].split("]", 1)
    minutes, seconds = first_stamp.lstrip("[").split(":")
    assert synced[0][1] == round((int(minutes) * 60 + float(seconds)) * 1000)
    assert synced[0][0] == first_text.strip()
