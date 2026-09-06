"""The `.webm` regression: what `bestaudio` hands back must never reach `/tag`.

The owner's first real import died at the `tag` step with
``TAG_WRITE_FAILED — Unsupported container '.webm'``. `bestaudio` on YouTube selects itag
251 — Opus packets inside WebM/Matroska — which carries no video, so the old
"only extract when there is video" rule left the file exactly as downloaded.

Three claims are checked here:

1. :func:`toolbox.ytdlp.audio_extraction_codec` asks for a remux of a WebM/Opus download and
   leaves a file that is already `.opus` or `.m4a` alone;
2. `/download` therefore registers ``FFmpegExtractAudio`` with a ``preferredcodec`` that
   matches the stream, and refuses to report ``done`` for an untaggable container;
3. with ffmpeg present, the remux really is a **stream copy**: same codec, same duration,
   same bitrate — and `mutagen` can tag the result, which it cannot do on the `.webm`.
"""

from __future__ import annotations

import json
import os
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from yt_dlp.postprocessor.ffmpeg import (  # pyright: ignore[reportMissingTypeStubs]
    FFmpegExtractAudioPP,
)

from tests.conftest import requires
from toolbox import download as download_module
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import DEFAULT_FORMAT, Tag, TagFormat, TagRequest, YtdlpOptions
from toolbox.tagging import TAGGABLE_SUFFIXES, detect_format, read_tags, write_tags
from toolbox.ytdlp import audio_extraction_codec, build_options, cookie_jar

#: What yt-dlp reports for YouTube's itag 251 — the format the owner's import actually got.
ITAG_251: dict[str, Any] = {
    "format_id": "251",
    "ext": "webm",
    "acodec": "opus",
    "vcodec": "none",
    "abr": 130.184,
}


def events(client: TestClient, body: dict[str, Any]) -> list[dict[str, Any]]:
    with client.stream("POST", "/download", json=body) as response:
        assert response.status_code == 200
        return [json.loads(line) for line in response.iter_lines() if line.strip()]


# --------------------------------------------------------------------------------------
# 1. The decision
# --------------------------------------------------------------------------------------


def test_opus_in_webm_is_remuxed_rather_than_left_as_a_webm():
    """The regression itself: itag 251 has no video, and still must not stay a `.webm`."""
    assert audio_extraction_codec(ITAG_251) == "opus"


@pytest.mark.parametrize(
    ("info", "expected"),
    [
        ({"ext": "opus", "acodec": "opus", "vcodec": "none"}, None),
        ({"ext": "ogg", "acodec": "vorbis", "vcodec": "none"}, None),
        ({"ext": "m4a", "acodec": "mp4a.40.2", "vcodec": "none"}, None),
        ({"ext": "mp3", "acodec": "mp3", "vcodec": "none"}, None),
        ({"ext": "webm", "acodec": "opus", "vcodec": "none"}, "opus"),
        ({"ext": "mkv", "acodec": "opus", "vcodec": "none"}, "opus"),
        # Not Opus: `best` makes yt-dlp copy the stream into its own natural container
        # instead of transcoding it to Opus, which would be a second lossy pass.
        ({"ext": "webm", "acodec": "vorbis", "vcodec": "none"}, "best"),
        ({"ext": "mp4", "acodec": "mp4a.40.2", "vcodec": "avc1"}, "best"),
    ],
)
def test_the_target_codec_is_read_from_the_container_and_the_stream(
    info: dict[str, Any], expected: str | None
):
    assert audio_extraction_codec(info) == expected


def test_a_merged_video_download_is_still_extracted():
    info = {"ext": "mp4", "acodec": "none", "requested_formats": [{"vcodec": "avc1"}]}
    assert audio_extraction_codec(info) == "best"


def test_the_default_format_asks_for_opus_first():
    assert DEFAULT_FORMAT.startswith("bestaudio[acodec=opus]")


# --------------------------------------------------------------------------------------
# 2. `/download` acts on it
# --------------------------------------------------------------------------------------


def _mocked_download(
    monkeypatch: pytest.MonkeyPatch, preflight: dict[str, Any], produced: Path
) -> dict[str, Any]:
    """Drive `_Worker` with yt-dlp replaced; return the option dict it built."""
    captured: dict[str, Any] = {}

    def fake(_url: str, options: Mapping[str, Any], *, download: bool = False) -> dict[str, Any]:
        if not download:
            return preflight
        captured.update(options)
        produced.write_bytes(b"x" * 32)
        return {
            "requested_downloads": [{"filepath": str(produced)}],
            "format_id": preflight.get("format_id", ""),
            "acodec": preflight.get("acodec", ""),
        }

    monkeypatch.setattr(download_module, "extract_info", fake)
    return captured


def test_a_webm_preflight_registers_the_opus_postprocessor(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    captured = _mocked_download(monkeypatch, ITAG_251, tmp_path / "trk.opus")
    stream = events(client, {"url": "https://youtu.be/x", "dest_dir": str(tmp_path), "id": "trk"})
    assert stream[-1]["event"] == "done"
    assert captured["postprocessors"] == [
        {"key": "FFmpegExtractAudio", "preferredcodec": "opus", "preferredquality": None}
    ]


def test_an_opus_preflight_registers_no_postprocessor_at_all(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    preflight = {"format_id": "251", "ext": "opus", "acodec": "opus", "vcodec": "none"}
    captured = _mocked_download(monkeypatch, preflight, tmp_path / "trk.opus")
    events(client, {"url": "https://youtu.be/x", "dest_dir": str(tmp_path), "id": "trk"})
    assert "postprocessors" not in captured


def test_a_webm_that_survived_the_postprocessor_is_an_error_not_a_done(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """The belt to the postprocessor's braces: `/download` never reports an untaggable file."""
    _mocked_download(monkeypatch, ITAG_251, tmp_path / "trk.webm")
    stream = events(client, {"url": "https://youtu.be/x", "dest_dir": str(tmp_path), "id": "trk"})
    assert stream[-1]["event"] == "error"
    assert stream[-1]["code"] == ErrorCode.DOWNLOAD_CONTAINER.value
    assert ".webm" in stream[-1]["message"]


def test_the_taggable_list_is_exactly_what_detect_format_accepts(tmp_path: Path):
    for suffix in TAGGABLE_SUFFIXES:
        assert detect_format(tmp_path / f"x{suffix}") is not TagFormat.AUTO
    with pytest.raises(ToolboxError) as raised:
        detect_format(tmp_path / "x.webm")
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED
    assert "'.webm'" in raised.value.message


# --------------------------------------------------------------------------------------
# 3. The real ffmpeg round trip: a remux, not a re-encode
# --------------------------------------------------------------------------------------


def _probe(path: Path) -> dict[str, Any]:
    raw = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration,bit_rate:stream=codec_name,sample_rate,channels",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    parsed: dict[str, Any] = json.loads(raw)
    return parsed


@pytest.fixture
def webm_file(opus_file: Path, tmp_path: Path) -> Path:
    """The bundled Opus sample, repackaged into WebM exactly as YouTube serves it."""
    target = tmp_path / "itag251.webm"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(opus_file), "-c:a", "copy", str(target)],
        check=True,
        capture_output=True,
    )
    return target


def _remux(path: Path) -> Path:
    """Run the postprocessor `/download` registers, exactly as yt-dlp would run it.

    yt-dlp ships no type information, so its boundary is narrowed here in one place — the
    same rule `toolbox.ytdlp` follows.
    """
    pp = cast(Any, FFmpegExtractAudioPP)(preferredcodec=audio_extraction_codec(ITAG_251))
    information: dict[str, Any] = {"filepath": str(path), "ext": path.suffix.lstrip(".")}
    _, info = cast("tuple[Any, dict[str, Any]]", pp.run(information))
    return Path(str(info["filepath"]))


@requires("ffmpeg")
@requires("ffprobe")
def test_mutagen_cannot_tag_the_webm_but_can_tag_the_remuxed_opus(webm_file: Path):
    """One file, two containers: the failing case and the fixed one, side by side."""
    with pytest.raises(ToolboxError) as raised:
        read_tags(webm_file)
    assert raised.value.code is ErrorCode.TAG_WRITE_FAILED

    remuxed = _remux(webm_file)

    assert remuxed.suffix == ".opus"
    written = write_tags(TagRequest(path=str(remuxed), tags=[Tag(key="TITLE", value="Graffiti")]))
    assert written.format is TagFormat.VORBIS
    assert read_tags(remuxed)["TITLE"] == ["Graffiti"]


@requires("ffmpeg")
@requires("ffprobe")
def test_the_remux_copies_the_stream_instead_of_re_encoding_it(webm_file: Path):
    """Same codec, same duration, same bitrate — the spec's "never re-encode", measured."""
    before = _probe(webm_file)
    after = _probe(_remux(webm_file))

    assert before["streams"][0]["codec_name"] == "opus"
    assert after["streams"][0]["codec_name"] == "opus"
    assert after["streams"][0]["sample_rate"] == before["streams"][0]["sample_rate"]
    assert after["streams"][0]["channels"] == before["streams"][0]["channels"]

    assert abs(float(after["format"]["duration"]) - float(before["format"]["duration"])) < 0.05
    ratio = float(after["format"]["bit_rate"]) / float(before["format"]["bit_rate"])
    assert 0.95 < ratio < 1.05, "a re-encode would not land within 5% of the source bitrate"


# --------------------------------------------------------------------------------------
# 4. The cookie jar, pasted rather than mounted (owner review B6)
# --------------------------------------------------------------------------------------


def test_a_pasted_jar_becomes_a_private_temporary_file_and_then_stops_existing():
    """`cookies_content` is the case a real server has: an export to paste, not a path."""
    options = YtdlpOptions(cookies_content="# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/")
    with cookie_jar(options) as jar:
        path = Path(str(jar["cookiefile"]))
        assert path.is_file()
        assert path.read_text(encoding="utf-8").startswith("# Netscape HTTP Cookie File")
        assert path.read_text(encoding="utf-8").endswith("\n")
        if os.name != "nt":  # Windows has no POSIX mode bits to speak of
            assert path.stat().st_mode & 0o077 == 0
    assert not path.exists()


def test_the_temporary_jar_is_removed_even_when_the_download_blows_up():
    options = YtdlpOptions(cookies_content="x")
    seen: Path | None = None
    with pytest.raises(RuntimeError):  # noqa: PT012 - the point is what happens on the way out
        with cookie_jar(options) as jar:
            seen = Path(str(jar["cookiefile"]))
            raise RuntimeError("boom")
    assert seen is not None
    assert not seen.exists()


def test_a_path_is_passed_straight_through_and_an_absent_jar_adds_nothing():
    with cookie_jar(YtdlpOptions(cookies="/data/cookies.txt")) as jar:
        assert jar == {}
    assert build_options(YtdlpOptions(cookies="/data/cookies.txt"))["cookiefile"] == (
        "/data/cookies.txt"
    )
    with cookie_jar(YtdlpOptions()) as jar:
        assert jar == {}
    assert "cookiefile" not in build_options(YtdlpOptions())


def test_inline_content_wins_over_a_path_that_the_container_cannot_see():
    options = YtdlpOptions(cookies="/not/in/this/container.txt", cookies_content="pasted")
    with cookie_jar(options) as jar:
        built = build_options(options, **jar)
        assert built["cookiefile"] == jar["cookiefile"]
        assert built["cookiefile"] != "/not/in/this/container.txt"
