"""Canonical tag key → per-format encoding.

`packages/domain` owns the *names*: it hands the toolbox a flat list of
``{key, value}`` pairs using the canonical (Vorbis) column of the Picard table in
`docs/03-metadonnees.md` §2. What the toolbox owns is the *encoding*: which ID3v2.4 frame
carries a given name, which MP4 atom, and the handful of frames that are not plain text
(``TIPL``, ``TMCL``, ``UFID``, ``TRCK``, ``trkn``…).

That split is why this file is mechanical and has no idea what MusicBrainz is.
"""

from __future__ import annotations

from typing import Final

__all__ = [
    "FREEFORM_NAMES",
    "ID3_TEXT_FRAMES",
    "ID3_URL_FRAMES",
    "MP4_ATOMS",
    "MP4_BOOL_ATOMS",
    "MP4_INT_ATOMS",
    "MP4_PAIR_ATOMS",
    "TIPL_ROLES",
    "freeform_name",
    "split_performer",
]

#: Canonical key → ID3v2.4 text frame. Everything absent lands in ``TXXX:<name>``.
ID3_TEXT_FRAMES: Final[dict[str, str]] = {
    "TITLE": "TIT2",
    "TITLESORT": "TSOT",
    "SUBTITLE": "TIT3",
    "ARTIST": "TPE1",
    "ARTISTSORT": "TSOP",
    "ALBUM": "TALB",
    "ALBUMSORT": "TSOA",
    "ALBUMARTIST": "TPE2",
    "ALBUMARTISTSORT": "TSO2",
    "DISCSUBTITLE": "TSST",
    "COMPILATION": "TCMP",
    "DATE": "TDRC",
    "RELEASEDATE": "TDRL",
    "ORIGINALDATE": "TDOR",
    "MEDIA": "TMED",
    "LABEL": "TPUB",
    "LANGUAGE": "TLAN",
    "COPYRIGHT": "TCOP",
    "COMPOSER": "TCOM",
    "COMPOSERSORT": "TSOC",
    "LYRICIST": "TEXT",
    "CONDUCTOR": "TPE3",
    "REMIXER": "TPE4",
    "GENRE": "TCON",
    "MOOD": "TMOO",
    "GROUPING": "TIT1",
    "MOVEMENTNAME": "MVNM",
    "MOVEMENT": "MVIN",
    "BPM": "TBPM",
    "KEY": "TKEY",
    "ISRC": "TSRC",
    "ENCODEDBY": "TENC",
    "ENCODERSETTINGS": "TSSE",
    "ORIGINALFILENAME": "TOFN",
    "COMMENT": "COMM",
}

#: Canonical key → ID3v2.4 URL frame.
ID3_URL_FRAMES: Final[dict[str, str]] = {"WEBSITE": "WOAR", "LICENSE": "WCOP"}

#: Canonical key → the role string inside ``TIPL`` (involved people list).
TIPL_ROLES: Final[dict[str, str]] = {
    "ARRANGER": "arranger",
    "PRODUCER": "producer",
    "ENGINEER": "engineer",
    "MIXER": "mix",
    "DJMIXER": "DJ-mix",
}

#: Canonical key → MP4 atom for plain text values.
MP4_ATOMS: Final[dict[str, str]] = {
    "TITLE": "\xa9nam",
    "TITLESORT": "sonm",
    "ARTIST": "\xa9ART",
    "ARTISTSORT": "soar",
    "ALBUM": "\xa9alb",
    "ALBUMSORT": "soal",
    "ALBUMARTIST": "aART",
    "ALBUMARTISTSORT": "soaa",
    "DATE": "\xa9day",
    "GENRE": "\xa9gen",
    "COMPOSER": "\xa9wrt",
    "COMPOSERSORT": "soco",
    "COMMENT": "\xa9cmt",
    "ENCODERSETTINGS": "\xa9too",
    "LYRICS": "\xa9lyr",
    "GROUPING": "\xa9grp",
    "WORK": "\xa9wrk",
    "MOVEMENTNAME": "\xa9mvn",
    "DIRECTOR": "\xa9dir",
    "COPYRIGHT": "cprt",
}

#: MP4 atoms holding a ``(number, total)`` pair, and the canonical key of each half.
MP4_PAIR_ATOMS: Final[dict[str, tuple[str, str]]] = {
    "trkn": ("TRACKNUMBER", "TRACKTOTAL"),
    "disk": ("DISCNUMBER", "DISCTOTAL"),
}

#: MP4 atoms holding a signed integer.
MP4_INT_ATOMS: Final[dict[str, str]] = {
    "BPM": "tmpo",
    "ITUNESADVISORY": "rtng",
    "MOVEMENT": "mvi",
    "MOVEMENTTOTAL": "mvc",
}

#: MP4 atoms holding a boolean.
MP4_BOOL_ATOMS: Final[dict[str, str]] = {"COMPILATION": "cpil", "SHOWMOVEMENT": "shwm"}

#: Canonical key → the display name Picard uses inside ``TXXX`` and ``----:com.apple.iTunes``.
#: Anything not listed keeps its canonical name, which is what Picard does too.
FREEFORM_NAMES: Final[dict[str, str]] = {
    "ARTISTS": "Artists",
    "WRITER": "Writer",
    "RELEASETYPE": "MusicBrainz Album Type",
    "RELEASESTATUS": "MusicBrainz Album Status",
    "RELEASECOUNTRY": "MusicBrainz Album Release Country",
    "MUSICBRAINZ_TRACKID": "MusicBrainz Track Id",
    "MUSICBRAINZ_RELEASETRACKID": "MusicBrainz Release Track Id",
    "MUSICBRAINZ_ALBUMID": "MusicBrainz Album Id",
    "MUSICBRAINZ_RELEASEGROUPID": "MusicBrainz Release Group Id",
    "MUSICBRAINZ_ARTISTID": "MusicBrainz Artist Id",
    "MUSICBRAINZ_ALBUMARTISTID": "MusicBrainz Album Artist Id",
    "MUSICBRAINZ_WORKID": "MusicBrainz Work Id",
    "MUSICBRAINZ_ORIGINALALBUMID": "MusicBrainz Original Album Id",
    "MUSICBRAINZ_ORIGINALARTISTID": "MusicBrainz Original Artist Id",
    "MUSICBRAINZ_COMPOSERID": "MusicBrainz Composer Id",
    "MUSICBRAINZ_LYRICISTID": "MusicBrainz Lyricist Id",
    "MUSICBRAINZ_PRODUCERID": "MusicBrainz Producer Id",
    "MUSICBRAINZ_ENGINEERID": "MusicBrainz Engineer Id",
    "MUSICBRAINZ_MIXERID": "MusicBrainz Mixer Id",
    "MUSICBRAINZ_REMIXERID": "MusicBrainz Remixer Id",
    "MUSICBRAINZ_DJMIXERID": "MusicBrainz DJ-Mixer Id",
    "MUSICBRAINZ_CONDUCTORID": "MusicBrainz Conductor Id",
    "MUSICBRAINZ_ARRANGERID": "MusicBrainz Arranger Id",
    "MUSICBRAINZ_PERFORMERID": "MusicBrainz Performer Id",
    "ACOUSTID_ID": "Acoustid Id",
    "ACOUSTID_FINGERPRINT": "Acoustid Fingerprint",
}

#: Picard spells a few names differently in MP4 than in ``TXXX``. ``ARTISTS`` is the one that
#: matters here: `TXXX:Artists` but `----:com.apple.iTunes:ARTISTS`.
MP4_FREEFORM_OVERRIDES: Final[dict[str, str]] = {"ARTISTS": "ARTISTS"}

#: The MBID of a recording travels in a ``UFID`` frame keyed by the MusicBrainz namespace.
UFID_OWNER: Final[str] = "http://musicbrainz.org"

#: R128 is defined for Opus only. Writing it into ID3 or MP4 would be noise, not metadata.
R128_PREFIX: Final[str] = "R128_"

#: Fields with a ``—`` in the MP4 column of `docs/03-metadonnees.md` §2: the format has no
#: slot for them, so they are dropped rather than invented as freeform atoms.
MP4_UNSUPPORTED: Final[frozenset[str]] = frozenset(
    {"WRITER", "ARRANGER", "PERFORMER", "WEBSITE", "ENCODEDBY", "ORIGINALFILENAME"}
)


def freeform_name(key: str, *, target: str = "id3") -> str:
    """Display name used by ``TXXX`` and ``----:com.apple.iTunes:`` for a canonical key."""
    upper = key.upper()
    if target == "mp4" and upper in MP4_FREEFORM_OVERRIDES:
        return MP4_FREEFORM_OVERRIDES[upper]
    return FREEFORM_NAMES.get(upper, upper)


def split_performer(value: str) -> tuple[str, str]:
    """Split ``"Nile Rodgers (guitar)"`` into ``("guitar", "Nile Rodgers")`` for ``TMCL``.

    A credit without a role keeps an empty role rather than being dropped; ID3 allows it and
    losing the name would be worse than an unnamed instrument.
    """
    stripped = value.strip()
    if stripped.endswith(")") and "(" in stripped:
        name, _, role = stripped[:-1].rpartition("(")
        return role.strip(), name.strip()
    return "", stripped
