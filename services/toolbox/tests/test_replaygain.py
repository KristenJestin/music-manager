"""`POST /replaygain`: rsgain's output parsed, and both tag dialects written.

The scan itself needs rsgain (image only), so the parsing and the R128 arithmetic are unit
tested, and the end-to-end write runs with rsgain mocked plus, when the binary is really
there, for real.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tests.conftest import requires
from toolbox import replaygain as rg
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import ReplayGainRequest
from toolbox.replaygain import parse_output, r128_gain, replaygain
from toolbox.tagging import read_tags

RSGAIN_OUTPUT = (
    "Filename\tLoudness (LUFS)\tGain (dB)\tPeak\t Peak (dB)\tPeak Type\tClipping Adjustment?\n"
    "01 One More Time.opus\t-9.90\t-8.10\t0.988000\t-0.10\tSample\tN\n"
    "02 Aerodynamic.opus\t-10.40\t-7.60\t0.995000\t-0.04\tSample\tY\n"
    "Album\t-10.15\t-7.85\t0.995000\t-0.04\tSample\tN\n"
)


def test_rsgain_output_is_parsed_positionally():
    paths = [Path("/library/a/01 One More Time.opus"), Path("/library/a/02 Aerodynamic.opus")]
    files, album = parse_output(RSGAIN_OUTPUT, paths)
    assert [file.path for file in files] == [str(path) for path in paths]
    assert files[0].gain == -8.10
    assert files[0].peak == 0.988
    assert files[0].loudness == -9.90
    assert files[1].clipping_adjustment is True
    assert album is not None
    assert album.gain == -7.85


def test_a_scan_without_album_gain_has_no_album_row():
    single = "\n".join(RSGAIN_OUTPUT.splitlines()[:2]) + "\n"
    files, album = parse_output(single, [Path("a.opus")])
    assert len(files) == 1
    assert album is None


@pytest.mark.parametrize(
    ("gain", "reference", "expected"),
    [
        (-8.10, -18.0, -3354),  # -8.10 dB at -18 LUFS is -13.10 dB at -23 LUFS
        (0.0, -18.0, -1280),
        (0.0, -23.0, 0),
        (9.78, -18.0, 1224),
    ],
)
def test_r128_is_q7_8_relative_to_minus_23_lufs(gain: float, reference: float, expected: int):
    assert r128_gain(gain, reference) == expected


def test_writing_puts_both_dialects_on_an_opus_file(
    opus_file: Path, monkeypatch: pytest.MonkeyPatch
):
    def fake_run_tool(_name: str, _args: Any, **__: Any) -> Any:
        class Completed:
            stdout = (
                "Filename\tLoudness\tGain\tPeak\tPeak dB\tPeak Type\tClip\n"
                f"{opus_file.name}\t-9.90\t-8.10\t0.988000\t-0.10\tSample\tN\n"
                "Album\t-10.15\t-7.60\t0.995000\t-0.04\tSample\tN\n"
            )

        return Completed()

    monkeypatch.setattr(rg, "run_tool", fake_run_tool)
    result = replaygain(ReplayGainRequest(files=[str(opus_file)], album=True))

    assert result.written is True
    assert result.r128 is True
    assert result.album is not None
    tags = read_tags(opus_file)
    assert tags["REPLAYGAIN_TRACK_GAIN"] == ["-8.10 dB"]
    assert tags["REPLAYGAIN_TRACK_PEAK"] == ["0.988000"]
    assert tags["REPLAYGAIN_ALBUM_GAIN"] == ["-7.60 dB"]
    assert tags["REPLAYGAIN_REFERENCE_LOUDNESS"] == ["-18.00 LUFS"]
    assert tags["R128_TRACK_GAIN"] == ["-3354"]
    assert tags["R128_ALBUM_GAIN"] == ["-3226"]


def test_no_r128_on_a_format_that_does_not_use_it(mp3_file: Path, monkeypatch: pytest.MonkeyPatch):
    def fake_run_tool(_name: str, _args: Any, **__: Any) -> Any:
        class Completed:
            stdout = (
                f"Filename\tL\tG\tP\tPd\tT\tC\n{mp3_file.name}\t-9.9\t-8.10\t0.98\t-0.1\tS\tN\n"
            )

        return Completed()

    monkeypatch.setattr(rg, "run_tool", fake_run_tool)
    result = replaygain(ReplayGainRequest(files=[str(mp3_file)], album=False))
    assert result.r128 is False
    tags = read_tags(mp3_file)
    assert tags["REPLAYGAIN_TRACK_GAIN"] == ["-8.10 dB"]
    assert "R128_TRACK_GAIN" not in tags


def test_a_missing_file_is_reported_before_rsgain_runs(tmp_path: Path):
    with pytest.raises(ToolboxError) as raised:
        replaygain(ReplayGainRequest(files=[str(tmp_path / "nope.opus")]))
    assert raised.value.code is ErrorCode.UNKNOWN
    assert raised.value.status == 404


@requires("rsgain")
def test_a_real_rsgain_scan(opus_file: Path):
    """Inside the image: the actual binary, on the actual sample."""
    result = replaygain(ReplayGainRequest(files=[str(opus_file)], album=True))
    assert result.files[0].gain != 0.0
    assert result.album is not None
    tags = read_tags(opus_file)
    assert tags["REPLAYGAIN_TRACK_GAIN"][0].endswith(" dB")
    assert int(tags["R128_TRACK_GAIN"][0]) == r128_gain(result.files[0].gain, -18.0)
