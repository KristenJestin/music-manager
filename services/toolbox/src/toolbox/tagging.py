"""Tag writing with mutagen: Vorbis comments, ID3v2.4 and MP4 atoms.

The rule from `docs/03-metadonnees.md` §2 that drives this file: **write everything that has
a value**, in the standard superset, not in one server's dialect. So the caller hands over a
flat list of canonical key/value pairs and this module encodes them, including the awkward
parts — ``METADATA_BLOCK_PICTURE`` for Opus, ``TIPL``/``TMCL``/``UFID``/``SYLT`` for ID3,
``----:com.apple.iTunes:*`` for MP4.

mutagen's tag containers are dictionaries whose value type depends on the frame, so they are
typed loosely upstream. Rather than sprinkling ignores, every mutagen object is narrowed to
an explicitly ``Any``-typed handle at the top of each writer, and everything that leaves this
module is a concrete type again.

Every failure becomes :attr:`ErrorCode.TAG_WRITE_FAILED`, which is what the Console shows.
"""

from __future__ import annotations

import base64
from collections import OrderedDict
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Final, cast

import mutagen
from mutagen import id3 as mutagen_id3
from mutagen.flac import FLAC, Picture
from mutagen.id3 import (
    APIC,
    COMM,
    SYLT,
    TIPL,
    TMCL,
    TXXX,
    UFID,
    USLT,
    Encoding,
    PictureType,
)
from mutagen.mp3 import MP3
from mutagen.mp4 import MP4, AtomDataType, MP4Cover, MP4FreeForm
from mutagen.oggopus import OggOpus
from mutagen.oggvorbis import OggVorbis

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.lyrics import parse_lrc, plain_text
from toolbox.models import Picture as PictureModel
from toolbox.models import Tag, TagFormat, TagRequest, TagResult
from toolbox.tagmap import (
    ID3_TEXT_FRAMES,
    ID3_URL_FRAMES,
    MP4_ATOMS,
    MP4_BOOL_ATOMS,
    MP4_INT_ATOMS,
    MP4_PAIR_ATOMS,
    MP4_UNSUPPORTED,
    R128_PREFIX,
    TIPL_ROLES,
    UFID_OWNER,
    freeform_name,
    split_performer,
)

__all__ = ["detect_format", "read_tags", "sidecar_path", "write_tags"]

Grouped = OrderedDict[str, list[str]]

_VORBIS_SUFFIXES: Final[frozenset[str]] = frozenset({".opus", ".ogg", ".oga", ".flac"})
_ID3_SUFFIXES: Final[frozenset[str]] = frozenset({".mp3", ".mp2"})
_MP4_SUFFIXES: Final[frozenset[str]] = frozenset({".m4a", ".mp4", ".m4b", ".aac"})

#: Keys a writer consumes as part of a compound frame rather than on their own.
_ID3_CONSUMED: Final[frozenset[str]] = frozenset(
    {
        "TRACKNUMBER",
        "TRACKTOTAL",
        "TOTALTRACKS",
        "DISCNUMBER",
        "DISCTOTAL",
        "TOTALDISCS",
        "LYRICS",
        "PERFORMER",
        "ORIGINALYEAR",
        *TIPL_ROLES,
    }
)
_MP4_CONSUMED: Final[frozenset[str]] = frozenset(
    {"TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS", "DISCNUMBER", "DISCTOTAL", "TOTALDISCS"}
)


def _frame_class(frame_id: str) -> Any:
    """Look a frame class up by id. ID3 frame constructors share no common signature."""
    return getattr(mutagen_id3, frame_id)


_INVERSE_ID3_TEXT: Final[dict[str, str]] = {frame: key for key, frame in ID3_TEXT_FRAMES.items()}
_INVERSE_ID3_URL: Final[dict[str, str]] = {frame: key for key, frame in ID3_URL_FRAMES.items()}
_INVERSE_TIPL: Final[dict[str, str]] = {role: key for key, role in TIPL_ROLES.items()}
_INVERSE_MP4: Final[dict[str, str]] = {atom: key for key, atom in MP4_ATOMS.items()}
_INVERSE_MP4_INT: Final[dict[str, str]] = {atom: key for key, atom in MP4_INT_ATOMS.items()}
_INVERSE_MP4_BOOL: Final[dict[str, str]] = {atom: key for key, atom in MP4_BOOL_ATOMS.items()}


def detect_format(path: Path, requested: TagFormat = TagFormat.AUTO) -> TagFormat:
    """Pick the tag block to write. ``auto`` reads the extension, nothing else."""
    if requested is not TagFormat.AUTO:
        return requested
    suffix = path.suffix.lower()
    if suffix in _VORBIS_SUFFIXES:
        return TagFormat.VORBIS
    if suffix in _ID3_SUFFIXES:
        return TagFormat.ID3
    if suffix in _MP4_SUFFIXES:
        return TagFormat.MP4
    raise ToolboxError(
        ErrorCode.TAG_WRITE_FAILED,
        f"Unsupported container '{suffix or path.name}'; pass an explicit format.",
        details={"path": str(path)},
    )


def sidecar_path(path: Path) -> Path:
    """`NN Title.opus` → `NN Title.lrc`, next to the audio file."""
    return path.with_suffix(".lrc")


def _grouped(tags: Iterable[Tag]) -> Grouped:
    """Canonical key → values, input order preserved on both axes."""
    grouped: Grouped = OrderedDict()
    for tag in tags:
        grouped.setdefault(tag.key.strip().upper(), []).append(tag.value)
    return grouped


def _picture_bytes(picture: PictureModel) -> tuple[bytes, str, int]:
    try:
        data = base64.b64decode(picture.data_base64, validate=True)
    except (ValueError, TypeError) as exc:
        raise ToolboxError(
            ErrorCode.TAG_WRITE_FAILED, f"Picture is not valid base64: {exc}"
        ) from exc
    if not data:
        raise ToolboxError(ErrorCode.TAG_WRITE_FAILED, "Picture is empty.")
    return data, picture.mime, picture.type


def _flac_picture(picture: PictureModel) -> Picture:
    data, mime, kind = _picture_bytes(picture)
    block = Picture()
    block.type = PictureType(kind)
    block.mime = mime
    block.desc = picture.description
    block.data = data
    return block


def _open_vorbis(path: Path) -> tuple[Any, bool]:
    """Open an Opus / Ogg Vorbis / FLAC file, and say which one it is.

    Opening by extension rather than through `mutagen.File` keeps the handle a single
    concrete class: FLAC stores pictures as metadata blocks, Ogg stores them base64-encoded
    inside a comment, and the two paths must not be confused.
    """
    suffix = path.suffix.lower()
    factory = {".flac": FLAC, ".ogg": OggVorbis, ".oga": OggVorbis}.get(suffix, OggOpus)
    try:
        return cast(Any, factory(path)), factory is FLAC
    except mutagen.MutagenError as exc:
        raise ToolboxError(
            ErrorCode.TAG_WRITE_FAILED, f"mutagen could not open {path.name}: {exc}"
        ) from exc


# --------------------------------------------------------------------------------------
# Vorbis (Opus, Ogg Vorbis, FLAC)
# --------------------------------------------------------------------------------------


def _write_vorbis(path: Path, request: TagRequest, grouped: Grouped) -> int:
    audio, is_flac = _open_vorbis(path)
    if audio.tags is None:
        audio.add_tags()
    tags = cast("dict[str, list[str]]", audio.tags)

    if request.clear:
        tags.clear()
        if is_flac:
            audio.clear_pictures()

    written = 0
    for key, values in grouped.items():
        tags[key] = list(values)
        written += len(values)

    if request.lyrics_lrc is not None and "LYRICS" not in grouped:
        tags["LYRICS"] = [plain_text(request.lyrics_lrc)]
        written += 1

    # FLAC has real picture blocks; Ogg carries them base64-encoded in a comment, which is
    # what every player — and Navidrome — expects for Opus.
    if request.pictures:
        if is_flac:
            if not request.clear:
                audio.clear_pictures()
            for picture in request.pictures:
                audio.add_picture(_flac_picture(picture))
        else:
            tags["METADATA_BLOCK_PICTURE"] = [
                base64.b64encode(_flac_picture(picture).write()).decode("ascii")
                for picture in request.pictures
            ]

    audio.save()
    return written


def _read_vorbis(path: Path) -> dict[str, list[str]]:
    audio, _ = _open_vorbis(path)
    if audio.tags is None:
        return {}
    out: dict[str, list[str]] = {}
    for key, value in cast("Iterable[tuple[str, str]]", audio.tags):
        name = str(key).upper()
        if name == "METADATA_BLOCK_PICTURE":
            continue
        out.setdefault(name, []).append(str(value))
    return out


# --------------------------------------------------------------------------------------
# ID3v2.4 (MP3)
# --------------------------------------------------------------------------------------


def _drop(key: str, fmt: TagFormat) -> bool:
    """True when the target format has no slot for this canonical key.

    `docs/03-metadonnees.md` §2 marks those cells with an em dash; inventing a freeform atom
    for them would put noise in the file rather than metadata. R128 is Opus-only everywhere.
    """
    if key.startswith(R128_PREFIX):
        return fmt is not TagFormat.VORBIS
    return fmt is TagFormat.MP4 and key in MP4_UNSUPPORTED


def _id3_pair(grouped: Grouped, number: str, total: str, alias: str) -> str | None:
    """`TRCK` / `TPOS` carry "n" or "n/total" in a single frame."""
    numbers = grouped.get(number)
    if not numbers:
        return None
    totals = grouped.get(total) or grouped.get(alias)
    return f"{numbers[0]}/{totals[0]}" if totals else numbers[0]


def _write_id3(path: Path, request: TagRequest, grouped: Grouped) -> int:
    audio = cast(Any, MP3(path))
    if audio.tags is None:
        audio.add_tags()
    tags = cast(Any, audio.tags)
    if request.clear:
        tags.clear()

    written = 0
    tipl: list[list[str]] = []
    tmcl: list[list[str]] = []

    for key, values in grouped.items():
        if _drop(key, TagFormat.ID3):
            continue
        written += len(values)
        if key in TIPL_ROLES:
            tipl.extend([TIPL_ROLES[key], value] for value in values)
        elif key == "PERFORMER":
            tmcl.extend(list(split_performer(value)) for value in values)
        elif key == "MUSICBRAINZ_TRACKID":
            tags.add(UFID(owner=UFID_OWNER, data=values[0].encode("utf-8")))
        elif key == "COMMENT":
            tags.add(COMM(encoding=Encoding.UTF8, lang="eng", desc="", text=list(values)))
        elif key in ID3_URL_FRAMES:
            tags.add(_frame_class(ID3_URL_FRAMES[key])(url=values[0]))
        elif key in ID3_TEXT_FRAMES:
            frame = _frame_class(ID3_TEXT_FRAMES[key])
            tags.add(frame(encoding=Encoding.UTF8, text=list(values)))
        elif key in _ID3_CONSUMED:
            written -= len(values)  # part of a compound frame, counted below
        else:
            tags.add(TXXX(encoding=Encoding.UTF8, desc=freeform_name(key), text=list(values)))

    # ORIGINALDATE and ORIGINALYEAR share one frame; the fuller value wins.
    original = grouped.get("ORIGINALDATE") or grouped.get("ORIGINALYEAR")
    if original and "ORIGINALDATE" not in grouped:
        tags.add(_frame_class("TDOR")(encoding=Encoding.UTF8, text=[original[0]]))
        written += 1

    for frame_id, number, total, alias in (
        ("TRCK", "TRACKNUMBER", "TRACKTOTAL", "TOTALTRACKS"),
        ("TPOS", "DISCNUMBER", "DISCTOTAL", "TOTALDISCS"),
    ):
        value = _id3_pair(grouped, number, total, alias)
        if value is not None:
            tags.add(_frame_class(frame_id)(encoding=Encoding.UTF8, text=[value]))
            written += 1

    if tipl:
        tags.add(TIPL(encoding=Encoding.UTF8, people=tipl))
        written += len(tipl)
    if tmcl:
        tags.add(TMCL(encoding=Encoding.UTF8, people=tmcl))
        written += len(tmcl)

    written += _write_id3_lyrics(tags, request, grouped)

    for picture in request.pictures:
        data, mime, kind = _picture_bytes(picture)
        tags.add(
            APIC(
                encoding=Encoding.UTF8,
                mime=mime,
                type=PictureType(kind),
                desc=picture.description,
                data=data,
            )
        )

    audio.save(v2_version=4)
    return written


def _write_id3_lyrics(tags: Any, request: TagRequest, grouped: Grouped) -> int:
    """``USLT`` always, plus ``SYLT`` when the lyrics really are synchronised."""
    lyrics = grouped.get("LYRICS")
    lrc = request.lyrics_lrc if request.lyrics_lrc is not None else (lyrics[0] if lyrics else None)
    if lrc is None:
        return 0
    written = 1
    tags.add(USLT(encoding=Encoding.UTF8, lang="eng", desc="", text=plain_text(lrc)))
    synced = [(line.text, line.at_ms) for line in parse_lrc(lrc)]
    if synced:
        # format=2: timestamps in milliseconds. type=1: the lyrics themselves.
        tags.add(SYLT(encoding=Encoding.UTF8, lang="eng", format=2, type=1, desc="", text=synced))
        written += 1
    return written


def _read_id3(path: Path) -> dict[str, list[str]]:
    try:
        audio = cast(Any, MP3(path))
    except mutagen.MutagenError:
        return {}
    if audio.tags is None:
        return {}
    out: dict[str, list[str]] = {}

    def add(key: str, value: str) -> None:
        out.setdefault(key, []).append(value)

    for raw in cast("Iterable[Any]", audio.tags.values()):
        frame_id = str(raw.FrameID)
        if frame_id == "TXXX":
            add(str(raw.desc), "\n".join(str(item) for item in raw.text))
        elif frame_id == "UFID":
            add("MUSICBRAINZ_TRACKID", bytes(raw.data).decode("utf-8", "replace"))
        elif frame_id in {"TIPL", "TMCL"}:
            for role, person in cast("Iterable[tuple[str, str]]", raw.people):
                if frame_id == "TIPL":
                    add(_INVERSE_TIPL.get(role, role.upper()), str(person))
                else:
                    add("PERFORMER", f"{person} ({role})" if role else str(person))
        elif frame_id in {"TRCK", "TPOS"}:
            number, _, total = str(raw.text[0]).partition("/")
            names = (
                ("TRACKNUMBER", "TRACKTOTAL") if frame_id == "TRCK" else ("DISCNUMBER", "DISCTOTAL")
            )
            add(names[0], number)
            if total:
                add(names[1], total)
        elif frame_id == "USLT":
            add("LYRICS", str(raw.text))
        elif frame_id in {"SYLT", "APIC"}:
            continue
        elif frame_id in _INVERSE_ID3_URL:
            add(_INVERSE_ID3_URL[frame_id], str(raw.url))
        elif frame_id in _INVERSE_ID3_TEXT:
            for value in cast("Iterable[Any]", raw.text):
                add(_INVERSE_ID3_TEXT[frame_id], str(value))
        else:
            for value in cast("Iterable[Any]", getattr(raw, "text", [])):
                add(frame_id, str(value))
    return out


# --------------------------------------------------------------------------------------
# MP4 atoms (AAC / ALAC)
# --------------------------------------------------------------------------------------


def _write_mp4(path: Path, request: TagRequest, grouped: Grouped) -> int:
    audio = cast(Any, MP4(path))
    if audio.tags is None:
        audio.add_tags()
    tags = cast(Any, audio.tags)
    if request.clear:
        tags.clear()

    written = 0
    for key, values in grouped.items():
        if _drop(key, TagFormat.MP4):
            continue
        written += len(values)
        if key in MP4_ATOMS:
            tags[MP4_ATOMS[key]] = list(values)
        elif key in MP4_INT_ATOMS:
            tags[MP4_INT_ATOMS[key]] = [int(float(values[0]))]
        elif key in MP4_BOOL_ATOMS:
            tags[MP4_BOOL_ATOMS[key]] = values[0].strip().lower() in {"1", "true", "yes"}
        elif key in _MP4_CONSUMED:
            written -= len(values)
        else:
            tags[f"----:com.apple.iTunes:{freeform_name(key, target='mp4')}"] = [
                MP4FreeForm(value.encode("utf-8"), AtomDataType.UTF8) for value in values
            ]

    for atom, (number, total) in MP4_PAIR_ATOMS.items():
        values = grouped.get(number)
        if values:
            totals = grouped.get(total)
            tags[atom] = [(int(values[0].split("/")[0]), int(totals[0]) if totals else 0)]
            written += 1

    if request.lyrics_lrc is not None and "LYRICS" not in grouped:
        tags["\xa9lyr"] = [plain_text(request.lyrics_lrc)]
        written += 1

    if request.pictures:
        covers: list[MP4Cover] = []
        for picture in request.pictures:
            data, mime, _ = _picture_bytes(picture)
            fmt = MP4Cover.FORMAT_PNG if "png" in mime.lower() else MP4Cover.FORMAT_JPEG
            covers.append(MP4Cover(data, imageformat=fmt))
        tags["covr"] = covers

    audio.save()
    return written


def _read_mp4(path: Path) -> dict[str, list[str]]:
    audio = cast(Any, MP4(path))
    if audio.tags is None:
        return {}
    out: dict[str, list[str]] = {}
    for atom, value in cast("Iterable[tuple[str, Any]]", audio.tags.items()):
        if atom == "covr":
            continue
        if atom.startswith("----:com.apple.iTunes:"):
            out[atom.split(":", 2)[2]] = [bytes(item).decode("utf-8", "replace") for item in value]
        elif atom in MP4_PAIR_ATOMS:
            number, total = MP4_PAIR_ATOMS[atom]
            pair = cast("tuple[int, ...]", value[0])
            out[number] = [str(pair[0])]
            if len(pair) > 1 and pair[1]:
                out[total] = [str(pair[1])]
        elif atom in _INVERSE_MP4_INT:
            out[_INVERSE_MP4_INT[atom]] = [str(value[0])]
        elif atom in _INVERSE_MP4_BOOL:
            out[_INVERSE_MP4_BOOL[atom]] = ["1" if value else "0"]
        elif atom == "\xa9lyr":
            out["LYRICS"] = [str(item) for item in value]
        elif atom in _INVERSE_MP4:
            out[_INVERSE_MP4[atom]] = [str(item) for item in value]
        else:
            out[atom] = [str(item) for item in value]
    return out


# --------------------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------------------

_WRITERS: Final[dict[TagFormat, Callable[[Path, TagRequest, Grouped], int]]] = {
    TagFormat.VORBIS: _write_vorbis,
    TagFormat.ID3: _write_id3,
    TagFormat.MP4: _write_mp4,
}

_READERS: Final[dict[TagFormat, Callable[[Path], dict[str, list[str]]]]] = {
    TagFormat.VORBIS: _read_vorbis,
    TagFormat.ID3: _read_id3,
    TagFormat.MP4: _read_mp4,
}


def read_tags(path: Path, fmt: TagFormat = TagFormat.AUTO) -> dict[str, list[str]]:
    """Read a tag block back from disk, in canonical keys. Used by `/tag` and the tests."""
    return _READERS[detect_format(path, fmt)](path)


def write_tags(request: TagRequest) -> TagResult:
    """Write every pair, then read the block back so the caller never has to trust us."""
    path = Path(request.path)
    if not path.is_file():
        raise ToolboxError(
            ErrorCode.TAG_WRITE_FAILED, f"No such file: {path}", details={"path": str(path)}
        )
    fmt = detect_format(path, request.format)
    grouped = _grouped(request.tags)

    try:
        written = _WRITERS[fmt](path, request, grouped)
    except ToolboxError:
        raise
    except Exception as exc:
        raise ToolboxError(
            ErrorCode.TAG_WRITE_FAILED,
            f"{type(exc).__name__}: {exc}",
            details={"path": str(path), "format": fmt.value},
        ) from exc

    sidecar: Path | None = None
    if request.sidecar_lrc and request.lyrics_lrc:
        sidecar = sidecar_path(path)
        sidecar.write_text(request.lyrics_lrc, encoding="utf-8")

    return TagResult(
        path=str(path),
        format=fmt,
        written=written,
        pictures=len(request.pictures),
        size=path.stat().st_size,
        sidecar_path=str(sidecar) if sidecar else None,
        readback=read_tags(path, fmt),
    )
