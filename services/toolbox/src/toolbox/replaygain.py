"""`POST /replaygain` — rsgain scans, mutagen writes.

rsgain can write tags itself, but it writes *one* dialect per file. `docs/03-metadonnees.md`
§2.6 asks for both on Opus: ``REPLAYGAIN_*`` **and** ``R128_*``. So rsgain is run in
scan-only mode (`-s s`) and the values are written through the same tag writer as everything
else, which keeps one code path for Vorbis, ID3 and MP4.

R128 is expressed as a Q7.8 fixed-point offset from -23 LUFS, so a ReplayGain 2.0 gain
computed against -18 LUFS becomes ``round((gain - 5) x 256)``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

import structlog

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import (
    ReplayGainFile,
    ReplayGainRequest,
    ReplayGainResult,
    Tag,
    TagFormat,
    TagRequest,
)
from toolbox.subprocesses import run_tool
from toolbox.tagging import detect_format, write_tags

__all__ = ["R128_REFERENCE_LUFS", "parse_output", "r128_gain", "replaygain"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.replaygain")

#: EBU R128 is defined against -23 LUFS; ReplayGain 2.0 against -18 LUFS.
R128_REFERENCE_LUFS: Final[float] = -23.0

#: Only Opus carries R128 tags. FLAC, MP3 and MP4 use REPLAYGAIN_* alone.
_R128_SUFFIXES: Final[frozenset[str]] = frozenset({".opus"})

_ALBUM_ROW: Final[str] = "Album"


def _float(value: str) -> float | None:
    try:
        return float(value.strip())
    except ValueError:
        return None


def parse_output(
    stdout: str, paths: list[Path]
) -> tuple[list[ReplayGainFile], ReplayGainFile | None]:
    """Parse rsgain's tab-delimited output.

    Rows come back in argument order and carry only the *base* name, so they are matched
    positionally rather than by name — two files called `01 Intro.opus` in different album
    folders are a normal thing to scan together.
    """
    rows = [line.split("\t") for line in stdout.splitlines() if line.strip()]
    files: list[ReplayGainFile] = []
    album: ReplayGainFile | None = None
    index = 0
    for row in rows:
        if len(row) < 5 or row[0].strip() in {"Filename", ""}:
            continue
        gain = _float(row[2])
        peak = _float(row[3])
        if gain is None or peak is None:
            continue
        entry = ReplayGainFile(
            path=_ALBUM_ROW if row[0].strip() == _ALBUM_ROW else str(paths[index]),
            loudness=_float(row[1]),
            gain=gain,
            peak=peak,
            peak_db=_float(row[4]),
            clipping_adjustment=len(row) > 6 and row[6].strip().upper() == "Y",
        )
        if row[0].strip() == _ALBUM_ROW:
            album = entry
        else:
            files.append(entry)
            index += 1
    return files, album


def r128_gain(gain_db: float, reference_loudness: float) -> int:
    """Q7.8 fixed-point R128 gain for a ReplayGain figure computed at ``reference_loudness``."""
    return round((gain_db + (R128_REFERENCE_LUFS - reference_loudness)) * 256)


def _tags_for(track: ReplayGainFile, album: ReplayGainFile | None, reference: float) -> list[Tag]:
    tags = [
        Tag(key="REPLAYGAIN_TRACK_GAIN", value=f"{track.gain:.2f} dB"),
        Tag(key="REPLAYGAIN_TRACK_PEAK", value=f"{track.peak:.6f}"),
        Tag(key="REPLAYGAIN_REFERENCE_LOUDNESS", value=f"{reference:.2f} LUFS"),
    ]
    if album is not None:
        tags += [
            Tag(key="REPLAYGAIN_ALBUM_GAIN", value=f"{album.gain:.2f} dB"),
            Tag(key="REPLAYGAIN_ALBUM_PEAK", value=f"{album.peak:.6f}"),
        ]
    return tags


def replaygain(request: ReplayGainRequest) -> ReplayGainResult:
    """Scan every file, then write both tag dialects where they apply."""
    paths = [Path(name) for name in request.files]
    missing = [str(path) for path in paths if not path.is_file()]
    if missing:
        raise ToolboxError(
            ErrorCode.UNKNOWN,
            f"No such file: {missing[0]}",
            status=404,
            details={"missing": missing},
        )

    args = ["custom", "-s", "s", "-O", "-q", "-l", f"{request.reference_loudness:g}"]
    if request.album:
        args.append("-a")
    completed = run_tool("rsgain", [*args, *[str(path) for path in paths]], timeout=900)
    files, album = parse_output(completed.stdout, paths)
    if len(files) != len(paths):
        raise ToolboxError(
            ErrorCode.UNKNOWN,
            f"rsgain reported {len(files)} results for {len(paths)} files.",
            details={"stdout": completed.stdout[:400]},
        )

    wrote_r128 = False
    if request.write:
        for path, track in zip(paths, files, strict=True):
            tags = _tags_for(track, album, request.reference_loudness)
            if path.suffix.lower() in _R128_SUFFIXES:
                wrote_r128 = True
                tags.append(
                    Tag(
                        key="R128_TRACK_GAIN",
                        value=str(r128_gain(track.gain, request.reference_loudness)),
                    )
                )
                if album is not None:
                    tags.append(
                        Tag(
                            key="R128_ALBUM_GAIN",
                            value=str(r128_gain(album.gain, request.reference_loudness)),
                        )
                    )
            write_tags(
                TagRequest(
                    path=str(path),
                    format=detect_format(path, TagFormat.AUTO),
                    tags=tags,
                )
            )
        log.info("replaygain.written", files=len(paths), album=album is not None, r128=wrote_r128)

    return ReplayGainResult(
        files=files,
        album=album,
        reference_loudness=request.reference_loudness,
        written=request.write,
        r128=wrote_r128,
    )
