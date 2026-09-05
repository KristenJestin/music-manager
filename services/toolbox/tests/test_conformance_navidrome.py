"""Navidrome conformance: what the toolbox writes, read back through OpenSubsonic.

`docs/03-metadonnees.md` §7 makes this the *only* proof of what Feishin and Symfonium will
show. The test places a tagged fourteen-track fixture album under `./.local/library`,
triggers `startScan`, waits, and reads it back with `getAlbum`, `getSong`,
`getLyricsBySongId` and `getCoverArt`.

Every field is classified `ok`, `mismatch`, or `not indexed`. A required field that is not
read back fails the test; `not indexed` is allowed only for the fields listed in
:data:`NOT_INDEXED`, which is what this Navidrome version genuinely does not expose.

    docker compose -f docker-compose.dev.yml up -d navidrome
    uv run --directory services/toolbox pytest -m conformance
"""

from __future__ import annotations

import hashlib
import secrets
import shutil
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import httpx2 as httpx
import pytest

from tests.conftest import TINY_JPEG, golden_expected, golden_lrc, golden_pairs
from toolbox import fixtures
from toolbox.models import Picture as PictureModel
from toolbox.models import Tag, TagRequest
from toolbox.tagging import write_tags

pytestmark = pytest.mark.conformance

#: `v2/.local/library` is bind-mounted read-only at /music inside the Navidrome container.
LIBRARY = Path(__file__).parents[3] / ".local" / "library"
ALBUM_DIR = LIBRARY / "Daft Punk" / "Discovery (2001)"

BASE_URL = "http://localhost:4533"
USER = "admin"
#: `ND_DEVAUTOCREATEADMINPASSWORD` in docker-compose.dev.yml.
PASSWORD = "admin"
API_VERSION = "1.16.1"
CLIENT = "mm"

SCAN_TIMEOUT_SECONDS = 240.0

#: Fields this Navidrome does not expose through OpenSubsonic. Measured, not assumed: the
#: test prints the whole table on every run. As of the version pinned in
#: docker-compose.dev.yml the set is *empty* — every field docs/03-metadonnees.md §7 asks
#: about comes back, including moods, bpm and ISRC. Add a name here only with the version
#: that justifies it.
NOT_INDEXED: frozenset[str] = frozenset()


# --------------------------------------------------------------------------------------
# The Subsonic client
# --------------------------------------------------------------------------------------


class Subsonic:
    """The little bit of the Subsonic REST API the verification step needs."""

    def __init__(self, base_url: str = BASE_URL) -> None:
        self.base_url = base_url
        self.client = httpx.Client(timeout=60)

    def close(self) -> None:
        self.client.close()

    def _params(self) -> dict[str, str]:
        salt = secrets.token_hex(8)
        token = hashlib.md5((PASSWORD + salt).encode("utf-8"), usedforsecurity=False).hexdigest()
        return {"u": USER, "t": token, "s": salt, "v": API_VERSION, "c": CLIENT, "f": "json"}

    def get(self, view: str, **params: str | int) -> dict[str, Any]:
        query = {**self._params(), **{key: str(value) for key, value in params.items()}}
        response = self.client.get(f"{self.base_url}/rest/{view}", params=query)
        response.raise_for_status()
        payload = cast(dict[str, Any], response.json())["subsonic-response"]
        if payload.get("status") != "ok":
            raise AssertionError(f"{view} failed: {payload.get('error')}")
        return cast(dict[str, Any], payload)

    def raw(self, view: str, **params: str | int) -> bytes:
        query = {**self._params(), **{key: str(value) for key, value in params.items()}}
        response = self.client.get(f"{self.base_url}/rest/{view}", params=query)
        response.raise_for_status()
        return response.content


# --------------------------------------------------------------------------------------
# Building the album
# --------------------------------------------------------------------------------------


def album_tracks() -> list[tuple[int, str]]:
    """The fourteen Discovery tracks, from the recorded fixture."""
    entries = cast(list[dict[str, Any]], fixtures.load("discovery")["extract"]["entries"])
    return [(index + 1, str(entry["track"])) for index, entry in enumerate(entries[:14])]


def _track_tags(number: int, title: str, total: int) -> list[Tag]:
    """The golden projection, with the per-track fields moved to this track.

    Album-scoped fields (`docs/03-metadonnees.md` §2 "Notes de forme") stay identical across
    every track: a server that sees them diverge splits the album in two.
    """
    per_track = {
        "TITLE": title,
        "TITLESORT": title,
        "TRACKNUMBER": str(number),
        "TRACKTOTAL": str(total),
        "TOTALTRACKS": str(total),
        # A distinct recording MBID per track, derived so the test is reproducible.
        "MUSICBRAINZ_TRACKID": _uuid(f"recording|Discovery|{title}"),
        "MUSICBRAINZ_RELEASETRACKID": _uuid(f"track|Discovery|{title}"),
    }
    tags: list[Tag] = []
    seen: set[str] = set()
    for key, value in golden_pairs():
        if key in per_track:
            if key in seen:
                continue
            seen.add(key)
            tags.append(Tag(key=key, value=per_track[key]))
        else:
            tags.append(Tag(key=key, value=value))
    for key, value in per_track.items():
        if key not in seen:
            tags.append(Tag(key=key, value=value))
    return tags


def _uuid(seed: str) -> str:
    digest = hashlib.sha1(seed.encode("utf-8"), usedforsecurity=False).hexdigest()
    return f"{digest[:8]}-{digest[8:12]}-4{digest[13:16]}-a{digest[17:20]}-{digest[20:32]}"


@pytest.fixture(scope="module")
def placed_album() -> Iterator[list[Path]]:
    """Fourteen tagged Opus files, plus their `.lrc` sidecars and a `cover.jpg`."""
    if ALBUM_DIR.exists():
        shutil.rmtree(ALBUM_DIR)
    ALBUM_DIR.mkdir(parents=True, exist_ok=True)

    import base64

    cover = base64.b64encode(TINY_JPEG).decode("ascii")
    tracks = album_tracks()
    written: list[Path] = []
    for number, title in tracks:
        safe = title.replace("/", "-").replace(":", "-")
        path = ALBUM_DIR / f"{number:02d} {safe}.opus"
        shutil.copy2(fixtures.sample_opus(), path)
        write_tags(
            TagRequest(
                path=str(path),
                tags=_track_tags(number, title, len(tracks)),
                pictures=[
                    PictureModel(
                        type=3, mime="image/jpeg", data_base64=cover, description="Front cover"
                    )
                ],
                lyrics_lrc=golden_lrc(),
                sidecar_lrc=True,
                clear=True,
            )
        )
        written.append(path)

    (ALBUM_DIR / "cover.jpg").write_bytes(TINY_JPEG)
    yield written


@pytest.fixture(scope="module")
def navidrome(placed_album: list[Path]) -> Iterator[Subsonic]:
    """A scanned Navidrome that has seen the album, or a skip explaining why not."""
    assert placed_album
    api = Subsonic()
    try:
        api.get("ping")
    except (httpx.HTTPError, AssertionError) as exc:  # pragma: no cover - operator error
        api.close()
        pytest.skip(
            f"Navidrome is not answering on {BASE_URL} ({exc}). Start it with:\n"
            "  docker compose -f docker-compose.dev.yml up -d navidrome"
        )

    api.get("startScan", fullScan="true")
    deadline = time.monotonic() + SCAN_TIMEOUT_SECONDS
    while True:
        status = api.get("getScanStatus")["scanStatus"]
        if not status.get("scanning") and int(status.get("count", 0)) > 0:
            break
        if time.monotonic() > deadline:  # pragma: no cover - a wedged scanner
            api.close()
            pytest.fail(f"Navidrome was still scanning after {SCAN_TIMEOUT_SECONDS:.0f}s")
        time.sleep(2)
    try:
        yield api
    finally:
        api.close()


# --------------------------------------------------------------------------------------
# The comparison
# --------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Field:
    """One compared field: what was written, what came back, and the verdict."""

    name: str
    written: str
    read: str
    status: str


def _verdict(name: str, written: str, read: object) -> Field:
    """Compare one scalar field."""
    return _verdict_many(name, [written], read)


def _verdict_many(name: str, written: list[str], read: object) -> Field:
    """Compare a field that may carry several values.

    Order is not part of the contract on the way back: Navidrome sorts genres
    alphabetically, and a server is free to. Set equality, case-insensitive, is what
    "the value survived" actually means.
    """
    written_text = ", ".join(written)
    if read in (None, "", [], 0) or (isinstance(read, list) and not read):
        return Field(name, written_text, "not indexed", "not indexed")
    values = (
        [str(item) for item in cast(list[Any], read)] if isinstance(read, list) else [str(read)]
    )
    read_text = ", ".join(values)
    left = {value.strip().casefold() for value in written if value.strip()}
    right = {value.strip().casefold() for value in values if value.strip()}
    return Field(name, written_text, read_text, "ok" if left == right else "mismatch")


def _first(payload: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload:
            return payload[key]
    return None


@pytest.fixture(scope="module")
def verification(navidrome: Subsonic) -> list[Field]:
    """Read the album back and classify every field the spec lists."""
    expected = golden_expected()
    search = navidrome.get("search3", query="Discovery", albumCount=20, songCount=0, artistCount=0)
    albums = cast(list[dict[str, Any]], search["searchResult3"].get("album", []))
    matching = [album for album in albums if album.get("name") == expected["ALBUM"][0]]
    assert matching, f"Navidrome did not index the album; it returned {albums}"
    album_id = str(matching[0]["id"])

    album = navidrome.get("getAlbum", id=album_id)["album"]
    songs = cast(list[dict[str, Any]], album.get("song", []))
    assert len(songs) == 14, f"expected 14 tracks in the album, got {len(songs)}"

    first = next(song for song in songs if str(song.get("track")) == "1")
    song = navidrome.get("getSong", id=str(first["id"]))["song"]

    lyrics = navidrome.get("getLyricsBySongId", id=str(first["id"]))
    structured = cast(
        list[dict[str, Any]], lyrics.get("lyricsList", {}).get("structuredLyrics", [])
    )
    synced = "synced" if structured and structured[0].get("synced") else ""

    cover = navidrome.raw("getCoverArt", id=str(album.get("coverArt") or album_id), size=200)

    replaygain = cast(dict[str, Any], song.get("replayGain", {}))
    genres = [str(item.get("name")) for item in cast(list[Any], album.get("genres", []))]
    artists = [str(item.get("name")) for item in cast(list[Any], song.get("artists", []))]
    labels = [str(item.get("name")) for item in cast(list[Any], album.get("recordLabels", []))]

    fields = [
        _verdict("title", expected["TITLE"][0], song.get("title")),
        _verdict("albumArtist", expected["ALBUMARTIST"][0], album.get("artist")),
        _verdict_many("artists[]", expected["ARTISTS"], artists or song.get("artist")),
        _verdict("album", expected["ALBUM"][0], album.get("name")),
        _verdict("year", expected["ORIGINALDATE"][0][:4], album.get("year")),
        _verdict(
            "originalReleaseDate",
            expected["ORIGINALDATE"][0],
            _iso_date(album.get("originalReleaseDate")),
        ),
        _verdict_many("genres[]", expected["GENRE"], genres),
        _verdict_many("releaseTypes[]", expected["RELEASETYPE"], album.get("releaseTypes")),
        _verdict_many("recordLabels[]", expected["LABEL"], labels),
        _verdict_many("isrc", expected["ISRC"], _first(song, "isrc", "isrcs")),
        # The album is built with one recording MBID per track, so compare with the value
        # this track was actually given rather than with the golden file's.
        _verdict(
            "musicBrainzId",
            _uuid(f"recording|Discovery|{expected['TITLE'][0]}"),
            song.get("musicBrainzId"),
        ),
        _verdict(
            "replayGain.trackGain",
            expected["REPLAYGAIN_TRACK_GAIN"][0].removesuffix(" dB"),
            _round(replaygain.get("trackGain")),
        ),
        _verdict(
            "replayGain.albumGain",
            expected["REPLAYGAIN_ALBUM_GAIN"][0].removesuffix(" dB"),
            _round(replaygain.get("albumGain")),
        ),
        _verdict("synced lyrics", "synced", synced),
        _verdict("coverArt", "jpeg", "jpeg" if cover[:2] == b"\xff\xd8" else ""),
        _verdict_many("moods[]", expected.get("MOOD", [""]), album.get("moods")),
        _verdict("bpm", expected.get("BPM", [""])[0], song.get("bpm")),
    ]
    ping = navidrome.get("ping")
    print("\n=== Navidrome conformance ===")
    print(f"server: {ping.get('type')} {ping.get('serverVersion')}")
    for field in fields:
        print(f"  {field.status:<12} {field.name:<22} wrote={field.written!r} read={field.read!r}")
    return fields


def _iso_date(value: Any) -> str | None:
    """Navidrome returns `{year, month, day}` for originalReleaseDate."""
    if isinstance(value, dict):
        parts = cast(dict[str, Any], value)
        if parts.get("year"):
            return "-".join(
                f"{int(parts[key]):02d}" if key != "year" else f"{int(parts[key]):04d}"
                for key in ("year", "month", "day")
                if parts.get(key)
            )
        return None
    return str(value) if value else None


def _round(value: Any) -> str | None:
    """ReplayGain comes back as a float; compare it at the precision we wrote."""
    if isinstance(value, (int, float)) and value:
        return f"{float(value):.2f}"
    return None


def test_navidrome_reads_back_every_required_field(verification: list[Field]):
    failures = [
        field for field in verification if field.status != "ok" and field.name not in NOT_INDEXED
    ]
    assert not failures, "\n".join(
        f"{field.name}: {field.status} (written {field.written!r}, read {field.read!r})"
        for field in failures
    )


def test_the_fields_known_not_to_be_indexed_are_still_written(verification: list[Field]):
    """`not indexed` is information, not an error — but only for the listed fields."""
    for field in verification:
        if field.name in NOT_INDEXED:
            assert field.written, f"{field.name} was not written at all"


def test_the_album_is_not_split(navidrome: Subsonic):
    """Album-scoped tags identical on every track: one album, not fourteen."""
    search = navidrome.get("search3", query="Discovery", albumCount=20, songCount=0, artistCount=0)
    albums = cast(list[dict[str, Any]], search["searchResult3"].get("album", []))
    assert len([album for album in albums if album.get("name") == "Discovery"]) == 1
