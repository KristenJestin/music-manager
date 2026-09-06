"""Every request and response body, in one place.

These models *are* the contract: `bun run toolbox:openapi` turns them into
`packages/contracts/toolbox/openapi.json` and the generated TypeScript client. Renaming a
field here is a breaking change for `apps/web`.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "ArtworkRequest",
    "ArtworkResult",
    "CookiesTestRequest",
    "CookiesTestResult",
    "DownloadRequest",
    "ExtractEntry",
    "ExtractRequest",
    "ExtractResult",
    "FingerprintCandidate",
    "FingerprintRequest",
    "FingerprintResult",
    "Health",
    "OnExists",
    "Picture",
    "PlaceRequest",
    "PlaceResult",
    "ProbeRequest",
    "ProbeResult",
    "ProbeStream",
    "ReplayGainFile",
    "ReplayGainRequest",
    "ReplayGainResult",
    "SelfTestCheck",
    "SelfTestRequest",
    "SelfTestResult",
    "Tag",
    "TagFormat",
    "TagRequest",
    "TagResult",
    "Thumbnail",
    "ToolVersions",
    "UpdateResult",
    "YtMusicCandidate",
    "YtMusicSearchRequest",
    "YtMusicSearchResult",
]

# --------------------------------------------------------------------------------------
# Shared building blocks
# --------------------------------------------------------------------------------------


class Strict(BaseModel):
    """Base for request bodies: unknown fields are a bug on the caller's side, not a shrug."""

    model_config = ConfigDict(extra="forbid")


class YtdlpOptions(Strict):
    """The three escape hatches every yt-dlp call shares."""

    cookies: str | None = Field(
        default=None,
        description="Path to a Netscape cookies.txt readable by the container.",
    )
    player_client: str | None = Field(
        default=None,
        description="yt-dlp `extractor_args.youtube.player_client`, e.g. 'android' or 'web'.",
    )
    extra_args: dict[str, Any] = Field(
        default_factory=dict[str, Any],
        description="Raw yt-dlp options merged last. Escape hatch; prefer the named fields.",
    )


# --------------------------------------------------------------------------------------
# /health
# --------------------------------------------------------------------------------------


class ToolVersions(BaseModel):
    """Version of each external tool, or ``None`` when it is missing from the image."""

    model_config = ConfigDict(populate_by_name=True)

    yt_dlp: str | None = Field(alias="yt-dlp")
    ffmpeg: str | None
    fpcalc: str | None
    rsgain: str | None


class Health(BaseModel):
    """Payload of ``GET /health``. Mirrored in `packages/contracts`."""

    ok: bool
    fixtures: bool
    downloading: bool = Field(description="True while the single download slot is taken.")
    versions: ToolVersions


class ErrorCatalogEntry(BaseModel):
    """One row of ``GET /errors`` — the Console's error decoder, straight from ``errors.py``."""

    code: str
    message: str = Field(
        description="What the operator is told when nothing more specific is known."
    )
    hint: str = Field(description="Why it happens, in one sentence.")
    action: str = Field(description="Label of the single button the Console offers. Empty = none.")
    status: int
    patterns: list[str] = Field(
        default_factory=list[str],
        description="Case-insensitive substrings that identify this failure in a yt-dlp message.",
    )


class ErrorCatalog(BaseModel):
    """Payload of ``GET /errors``."""

    entries: list[ErrorCatalogEntry]


# --------------------------------------------------------------------------------------
# /extract
# --------------------------------------------------------------------------------------


class Thumbnail(BaseModel):
    url: str
    width: int | None = None
    height: int | None = None


class ExtractEntry(BaseModel):
    """One video. `track`/`artist`/`album`/`release_year` are YouTube Music's own tags."""

    id: str
    title: str
    duration: float | None = None
    uploader: str | None = None
    index: int
    track: str | None = None
    artist: str | None = None
    album: str | None = None
    release_year: int | None = None
    description: str | None = None
    thumbnails: list[Thumbnail] = Field(default_factory=list[Thumbnail])
    webpage_url: str | None = None


class ExtractResult(BaseModel):
    kind: Literal["video", "playlist"]
    title: str | None = None
    uploader: str | None = None
    id: str | None = None
    entries: list[ExtractEntry]


class ExtractRequest(YtdlpOptions):
    url: str


# --------------------------------------------------------------------------------------
# /download
# --------------------------------------------------------------------------------------


class DownloadRequest(YtdlpOptions):
    url: str
    dest_dir: str
    id: str = Field(description="Opaque id echoed in every event; used as the file stem.")
    format: str = "bestaudio"


# --------------------------------------------------------------------------------------
# /probe
# --------------------------------------------------------------------------------------


class ProbeRequest(Strict):
    path: str


class ProbeStream(BaseModel):
    index: int
    codec_name: str | None = None
    codec_type: str | None = None
    sample_rate: int | None = None
    channels: int | None = None
    bit_rate: int | None = None


class ProbeResult(BaseModel):
    path: str
    format_name: str | None = None
    codec: str | None = None
    duration: float | None = None
    bit_rate: int | None = None
    sample_rate: int | None = None
    channels: int | None = None
    size: int
    streams: list[ProbeStream] = Field(default_factory=list[ProbeStream])
    tags: dict[str, str] = Field(
        default_factory=dict[str, str],
        description="Every tag ffprobe reports, container and stream level, keys upper-cased.",
    )
    has_picture: bool = False


# --------------------------------------------------------------------------------------
# /fingerprint
# --------------------------------------------------------------------------------------


class FingerprintRequest(Strict):
    path: str
    acoustid_key: str | None = None


class FingerprintCandidate(BaseModel):
    recording_mbid: str
    score: float
    title: str | None = None
    artist: str | None = None


class FingerprintResult(BaseModel):
    fingerprint: str
    duration: float
    candidates: list[FingerprintCandidate] | None = None


# --------------------------------------------------------------------------------------
# /tag
# --------------------------------------------------------------------------------------


class TagFormat(StrEnum):
    """Which tag block to write. ``auto`` picks from the file extension."""

    AUTO = "auto"
    VORBIS = "vorbis"
    ID3 = "id3"
    MP4 = "mp4"


class Tag(Strict):
    """One key/value pair, already projected by `packages/domain`.

    Keys are the canonical (Vorbis) names of the Picard table; the toolbox maps them onto
    ID3v2.4 frames and MP4 atoms mechanically. Repeat a key to write a multi-valued tag.
    """

    key: str
    value: str


class Picture(Strict):
    type: int = Field(default=3, description="ID3/FLAC picture type: 3 front cover, 4 back.")
    mime: str = "image/jpeg"
    data_base64: str
    description: str = ""


class TagRequest(Strict):
    path: str
    format: TagFormat = TagFormat.AUTO
    tags: list[Tag] = Field(default_factory=list[Tag])
    pictures: list[Picture] = Field(default_factory=list[Picture])
    lyrics_lrc: str | None = Field(
        default=None, description="Synchronised lyrics in LRC form; also written unsynced."
    )
    sidecar_lrc: bool = Field(default=False, description="Also write `<stem>.lrc` next to it.")
    clear: bool = Field(default=False, description="Drop every existing tag first.")


class TagResult(BaseModel):
    path: str
    format: TagFormat
    written: int = Field(description="Number of key/value pairs written.")
    pictures: int
    size: int
    sidecar_path: str | None = None
    readback: dict[str, list[str]] = Field(
        description="The tag block read back from disk after writing, in canonical keys."
    )


# --------------------------------------------------------------------------------------
# /replaygain
# --------------------------------------------------------------------------------------


class ReplayGainRequest(Strict):
    files: list[str] = Field(min_length=1)
    album: bool = True
    reference_loudness: float = Field(default=-18.0, description="LUFS target, rsgain's `-l`.")
    write: bool = Field(default=True, description="Write the tags, not just report the gains.")


class ReplayGainFile(BaseModel):
    path: str
    loudness: float | None = None
    gain: float
    peak: float
    peak_db: float | None = None
    range: float | None = None
    clipping_adjustment: bool = False


class ReplayGainResult(BaseModel):
    files: list[ReplayGainFile]
    album: ReplayGainFile | None = None
    reference_loudness: float
    written: bool
    r128: bool = Field(description="True when R128_* tags were written (Opus targets).")


# --------------------------------------------------------------------------------------
# /place
# --------------------------------------------------------------------------------------


class OnExists(StrEnum):
    """What to do when the destination is already taken."""

    SKIP = "skip"
    OVERWRITE = "overwrite"
    KEEP_BOTH = "keep_both"


class PlaceRequest(Strict):
    src: str
    dest: str
    on_exists: OnExists | None = Field(
        default=None,
        description="Omit to make a pre-existing destination a PLACE_CONFLICT error.",
    )


class PlaceResult(BaseModel):
    path: str
    moved: bool = Field(description="False when `skip` left an existing file alone.")
    on_exists: OnExists | None = None
    size: int


# --------------------------------------------------------------------------------------
# /artwork/prepare
# --------------------------------------------------------------------------------------


class ArtworkRequest(Strict):
    url: str | None = None
    path: str | None = None
    size: Annotated[int, Field(ge=16, le=4000)] = 1200
    square: bool = True
    quality: Annotated[int, Field(ge=1, le=100)] = 90


class ArtworkResult(BaseModel):
    mime: Literal["image/jpeg"] = "image/jpeg"
    width: int
    height: int
    bytes: int
    data_base64: str
    source: Literal["url", "path", "fixture"]


# --------------------------------------------------------------------------------------
# /ytmusic/search
# --------------------------------------------------------------------------------------


class YtMusicSearchRequest(Strict):
    artist: str
    album: str | None = None
    title: str | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 10


class YtMusicCandidate(BaseModel):
    kind: Literal["album", "song", "video"]
    title: str
    artist: str | None = None
    album: str | None = None
    year: int | None = None
    duration: float | None = None
    track_count: int | None = None
    #: `OLAK5uy_…` for an album playlist, or a video id for a single.
    playlist_id: str | None = None
    video_id: str | None = None
    browse_id: str | None = None
    url: str | None = None
    thumbnails: list[Thumbnail] = Field(default_factory=list[Thumbnail])


class YtMusicSearchResult(BaseModel):
    query: str
    candidates: list[YtMusicCandidate]


# --------------------------------------------------------------------------------------
# /ytdlp/update, /ytdlp/selftest, /cookies/test
# --------------------------------------------------------------------------------------


class UpdateResult(BaseModel):
    ok: bool
    changed: bool
    previous: str | None = None
    current: str | None = None
    method: Literal["uv", "pip", "skipped"] = "skipped"
    output: str = ""


class SelfTestCheck(BaseModel):
    name: str
    ok: bool
    detail: str = ""


class SelfTestRequest(Strict):
    network: bool = Field(
        default=False, description="Also hit YouTube. Never enabled in tests or fixtures mode."
    )
    url: str | None = None


class SelfTestResult(BaseModel):
    ok: bool
    version: str | None
    checks: list[SelfTestCheck]


class CookiesTestRequest(Strict):
    path: str | None = None
    content: str | None = Field(default=None, description="Netscape cookies.txt, inline.")


class CookiesTestResult(BaseModel):
    ok: bool
    cookies: int
    domains: list[str]
    authenticated: bool = Field(description="A YouTube session cookie is present.")
    expires_at: str | None = Field(default=None, description="Earliest expiry, ISO-8601 UTC.")
    expired: int = 0
    problems: list[str] = Field(default_factory=list[str])
