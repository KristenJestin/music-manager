"""The yt-dlp adapter — the whole reason this service is written in Python.

`docs/02-lecons-v1.md` names the v1 failure precisely: yt-dlp driven as a subprocess with
concatenated arguments, the output path *guessed from stdout*, and no update path. Here
yt-dlp is a library: options are a dict, the resulting file path comes out of the info dict,
progress arrives through hooks, and failures are exception objects that
:func:`toolbox.errors.classify_ytdlp_error` turns into catalogued codes.

yt-dlp ships no type information, so this module is the only place that touches it; every
value crossing its boundary is narrowed here.
"""

from __future__ import annotations

import re
import tempfile
from collections.abc import Callable, Generator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Final, cast

from yt_dlp import YoutubeDL  # pyright: ignore[reportMissingTypeStubs]

from toolbox.errors import ErrorCode, ToolboxError, classify_message, strip_ytdlp_prefix
from toolbox.models import ExtractEntry, ExtractGap, ExtractResult, Thumbnail, YtdlpOptions
from toolbox.tagging import TAGGABLE_SUFFIXES

__all__ = [
    "ExtractionLog",
    "audio_extraction_codec",
    "blame_stale_cookies",
    "build_options",
    "cookie_jar",
    "downloaded_path",
    "entry_from_info",
    "extract_info",
    "is_unavailable",
    "result_from_info",
    "yt_dlp_version",
]

InfoDict = dict[str, Any]
ProgressHook = Callable[[dict[str, Any]], None]

#: Options every call shares. `quiet`/`no_warnings` keep stdout clean — we never read it.
_BASE: dict[str, Any] = {
    "quiet": True,
    "no_warnings": True,
    "noprogress": True,
    "noplaylist": False,
    # `False` here and nowhere else: a *download* that fails must fail. `/extract` turns it on
    # for the listing only (:func:`toolbox.extract.listing_options`), because there the unit of
    # failure is an entry rather than the call.
    "ignoreerrors": False,
    "extract_flat": False,
    "retries": 3,
    "socket_timeout": 30,
    # `--continue` is always on: a toolbox restart must resume the `.part`, never restart it.
    "continuedl": True,
}


#: yt-dlp prints every user-visible failure through ``report_error``, which reaches a logger
#: as ``ERROR: [extractor] <id>: <sentence>``. Colour is only added for a tty, but a stray
#: escape sequence would end up quoted in the Console, so it is stripped unconditionally.
_ANSI: Final[re.Pattern[str]] = re.compile(r"\x1b\[[0-9;]*m")
_ERROR_PREFIX: Final[re.Pattern[str]] = re.compile(r"^ERROR:\s*", re.IGNORECASE)
#: ``[youtube] dQw4w9WgXcQ: Private video`` — the id yt-dlp names in a failure it swallowed.
#: Eleven characters is the YouTube video id, and nothing else in these messages has that
#: shape between a bracket and a colon.
_ERROR_ID: Final[re.Pattern[str]] = re.compile(r"\[[^\]]+\]\s+([A-Za-z0-9_-]{11}):")
#: yt-dlp's one sentence about a jar the browser has rotated since it was exported. It is a
#: *warning*, printed before the extraction goes on as if signed out, so the failure that
#: follows is a bot check or an age gate and never mentions the cookies again.
_STALE_COOKIES: Final[re.Pattern[str]] = re.compile(
    r"cookies are no longer valid|likely been rotated in the browser", re.IGNORECASE
)
#: The failures a rotated jar explains: every one of them is what YouTube says to a session it
#: does not trust, and every one of them carries the action "Configure cookies" — which is the
#: wrong advice for an operator who configured them an hour ago.
_STALE_EXPLAINS: Final[frozenset[ErrorCode]] = frozenset(
    {
        ErrorCode.YTDLP_BOT_CHECK,
        ErrorCode.YTDLP_AGE,
        ErrorCode.YTDLP_PRIVATE,
        ErrorCode.PLAYLIST_PRIVATE,
        ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE,
    }
)


class ExtractionLog:
    """What ``ignoreerrors`` swallowed, kept so the caller can still say what happened.

    ``ignoreerrors`` is the difference between "one dead video kills the playlist" and
    "nineteen of twenty come back", but it buys that by turning an exception into a line on
    stderr. yt-dlp's ``logger`` option is the documented way to intercept that line, so this
    object *is* the option: ``report_error`` arrives at :meth:`error`, and everything else —
    progress, warnings, debug chatter — is dropped on the floor.

    Two readers, both in :mod:`toolbox.extract`:

    - when yt-dlp came back with **nothing at all**, the first message here is the only
      statement of why, and it is what the error is classified from. Without it the caller
      sees ``yt-dlp returned no information`` and has to guess between "the playlist is gone",
      "the playlist is private" and "a video inside it is";
    - when yt-dlp came back with a **playlist minus some entries**, one message was logged per
      entry it gave up on, in the order it tried them, which is how a gap gets an id and a
      sentence instead of only a position.
    """

    __slots__ = ("messages", "stale_cookies")

    def __init__(self) -> None:
        self.messages: list[str] = []
        #: yt-dlp warned that the jar it was handed is signed out. Kept apart from
        #: :attr:`messages`, which is positional (:meth:`gap`) and must hold errors only.
        self.stale_cookies: bool = False

    # -- yt-dlp's logger protocol; only `error` carries anything we keep ----------------
    def debug(self, msg: str) -> None:
        return None

    def info(self, msg: str) -> None:
        return None

    def warning(self, msg: str) -> None:
        """Drop every warning but the one that renames the failure that follows it."""
        if _STALE_COOKIES.search(_ANSI.sub("", str(msg))):
            self.stale_cookies = True

    def error(self, msg: str) -> None:
        """Keep one failure, without its ``ERROR:`` prefix and without its colour."""
        clean = _ANSI.sub("", str(msg)).strip()
        if not clean.upper().startswith("ERROR:"):
            return
        text = _ERROR_PREFIX.sub("", clean).strip()
        if text:
            self.messages.append(text)

    def gap(self, index: int) -> tuple[str | None, str | None]:
        """The ``(id, reason)`` of the ``index``-th failure yt-dlp swallowed, if it logged one.

        Positional, because that is the only correspondence yt-dlp offers: it walks a playlist
        in order and reports each entry it gives up on as it reaches it, so the *n*-th message
        belongs to the *n*-th hole. The caller only uses it when the two counts agree, so a
        surprise message never renames a gap after somebody else's video.
        """
        if index >= len(self.messages):
            return (None, None)
        raw = self.messages[index]
        found = _ERROR_ID.search(raw)
        return (found.group(1) if found else None, strip_ytdlp_prefix(raw) or raw)


def blame_stale_cookies(error: ToolboxError, errors: ExtractionLog) -> ToolboxError:
    """``error``, re-said as :attr:`ErrorCode.YTDLP_COOKIES_STALE` when the log explains it.

    The owner pasted a fresh export, imported one album, and every album after it came back
    as *"Sign in to confirm you're not a bot"* — the same code, the same "Configure cookies"
    button, and no way to tell a jar that was never there from a jar the browser had rotated
    ten minutes after the export. yt-dlp does say which: one warning, before the failure. This
    reads it, and only re-labels the failures a signed-out session accounts for; a deleted
    video is deleted whatever the cookies say.
    """
    if not errors.stale_cookies or error.code not in _STALE_EXPLAINS:
        return error
    return ToolboxError(
        ErrorCode.YTDLP_COOKIES_STALE,
        details={**error.details, "underlying": error.code.value, "reason": error.message},
    )


def yt_dlp_version() -> str | None:
    """The running yt-dlp version, read from the module rather than a binary."""
    try:
        from yt_dlp.version import __version__  # pyright: ignore[reportMissingTypeStubs]
    except ImportError:  # pragma: no cover - yt-dlp is a hard dependency
        return None
    return str(__version__)


def build_options(options: YtdlpOptions, **overrides: Any) -> dict[str, Any]:
    """Assemble the yt-dlp option dict. ``extra_args`` is merged last, on purpose.

    ``cookiefile`` may be supplied through ``overrides`` — that is how :func:`cookie_jar`
    hands over the temporary file it wrote for an inline jar.
    """
    built: dict[str, Any] = {**_BASE, **overrides}
    if "cookiefile" not in built and options.cookies:
        built["cookiefile"] = options.cookies
    if options.player_client:
        built["extractor_args"] = {"youtube": {"player_client": [options.player_client]}}
    built.update(options.extra_args)
    return built


@contextmanager
def cookie_jar(options: YtdlpOptions) -> Generator[dict[str, Any]]:
    """Yield the ``cookiefile`` override for this call, cleaning up after itself.

    Inline content is the case that matters: on a real server the operator has a browser
    export to paste into the Console, not a path that happens to exist inside this container
    (owner review B6). It is written 0600 to the system temp directory and removed on the way
    out, so it never lands in the library, in a log, or in an image layer.
    """
    content = options.cookies_content
    if not content:
        yield {}
        return
    handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - closed explicitly below
        "w", prefix="mm-cookies-", suffix=".txt", encoding="utf-8", delete=False
    )
    try:
        handle.write(content if content.endswith("\n") else f"{content}\n")
        handle.close()
        Path(handle.name).chmod(0o600)
        yield {"cookiefile": handle.name}
    finally:
        Path(handle.name).unlink(missing_ok=True)


def extract_info(url: str, options: Mapping[str, Any], *, download: bool = False) -> InfoDict:
    """Run yt-dlp and hand back its info dict. Exceptions are left to the caller."""
    # yt-dlp types its option dict as a private TypedDict; ours is assembled at runtime.
    with YoutubeDL(cast(Any, dict(options))) as ydl:
        info = ydl.extract_info(url, download=download)
        if not info:
            raise ValueError("Video unavailable: yt-dlp returned no information.")
        return cast(InfoDict, ydl.sanitize_info(cast(Any, info)))


def _carries_video(info: Mapping[str, Any]) -> bool:
    vcodec = info.get("vcodec")
    if isinstance(vcodec, str) and vcodec not in {"none", ""}:
        return True
    requested = info.get("requested_formats")
    if isinstance(requested, list):
        for item in cast("list[Any]", requested):
            if not isinstance(item, dict):
                continue
            selected = cast("dict[str, Any]", item)
            if str(selected.get("vcodec", "none")) not in {"none", ""}:
                return True
    return False


def audio_extraction_codec(info: Mapping[str, Any]) -> str | None:
    """The ``FFmpegExtractAudio`` ``preferredcodec``, or ``None`` when nothing to do.

    ``bestaudio`` on YouTube selects itag 251: **Opus inside WebM/Matroska**. That has no
    video stream, so the old "only extract when there is video" rule left the file as
    ``.webm`` — a container mutagen cannot tag, which is where the owner's import died with
    ``TAG_WRITE_FAILED — Unsupported container '.webm'``. The real question is not "is there
    video" but "can this container hold a tag block"; :data:`toolbox.tagging.TAGGABLE_SUFFIXES`
    answers it, so the two can never drift apart.

    Nothing is ever re-encoded. ``preferredcodec="opus"`` on an Opus stream and
    ``preferredcodec="best"`` on anything else both make yt-dlp pick ``acodec="copy"``: the
    packets are moved into Ogg (or MP4) untouched, same bitrate, same duration.
    """
    ext = info.get("ext")
    suffix = f".{ext}".lower() if isinstance(ext, str) and ext else ""
    if suffix in TAGGABLE_SUFFIXES and not _carries_video(info):
        return None
    acodec = info.get("acodec")
    codec = acodec.split(".")[0].lower() if isinstance(acodec, str) else ""
    return "opus" if codec == "opus" else "best"


def _thumbnails(info: Mapping[str, Any]) -> list[Thumbnail]:
    raw = info.get("thumbnails")
    if not isinstance(raw, list):
        return []
    out: list[Thumbnail] = []
    for item in cast(list[Any], raw):
        if not isinstance(item, dict):
            continue
        entry = cast(dict[str, Any], item)
        url = entry.get("url")
        if not isinstance(url, str):
            continue
        out.append(
            Thumbnail(
                url=url,
                width=_as_int(entry.get("width")),
                height=_as_int(entry.get("height")),
            )
        )
    return out


def _as_int(value: Any) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str) and value.strip().lstrip("-").isdigit():
        return int(value)
    return None


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


#: Titles yt-dlp substitutes for an entry it listed but cannot reach. In flat mode that is
#: *all* it says — there is no error to classify, only this placeholder — so the words are the
#: signal. Matched case-insensitively against the whole title.
_UNAVAILABLE_TITLES: Final[frozenset[str]] = frozenset(
    {
        "[private video]",
        "[deleted video]",
        "[unavailable video]",
        "private video",
        "deleted video",
        "[age restricted video]",
    }
)


def is_unavailable(info: Mapping[str, Any]) -> bool:
    """True when an entry is in the listing but cannot be fetched.

    Three independent tells, because yt-dlp uses whichever it happens to have: the explicit
    ``availability`` string, its placeholder title, or an entry with no id at all.
    """
    availability = _as_str(info.get("availability"))
    if availability is not None and availability.lower() in {
        "private",
        "needs_auth",
        "subscriber_only",
        "premium_only",
    }:
        return True
    title = str(info.get("title") or "").strip().casefold()
    if title in _UNAVAILABLE_TITLES:
        return True
    return not str(info.get("id") or "").strip()


def entry_from_info(info: Mapping[str, Any], index: int) -> ExtractEntry:
    """Project one yt-dlp entry onto the contract, keeping YouTube Music's own tags."""
    return ExtractEntry(
        id=str(info.get("id") or ""),
        title=str(info.get("title") or ""),
        duration=_as_float(info.get("duration")),
        uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
        index=index,
        track=_as_str(info.get("track")),
        artist=_as_str(info.get("artist")),
        album=_as_str(info.get("album")),
        release_year=_as_int(info.get("release_year")),
        description=_as_str(info.get("description")),
        thumbnails=_thumbnails(info),
        webpage_url=_as_str(info.get("webpage_url")) or _as_str(info.get("url")),
        playlist_index=_as_int(info.get("playlist_index")),
        availability=_as_str(info.get("availability")),
        unavailable=is_unavailable(info),
    )


def _stated_positions(info: Mapping[str, Any]) -> list[int] | None:
    """yt-dlp's own one-based numbering of the entries it handed back, when it kept it.

    ``requested_entries`` is written per playlist and **includes the holes**, so it is the one
    place a gap's real position survives. yt-dlp drops the key when it would be the full
    ``1..n`` range, which is exactly the case where the index in ``entries`` already is the
    position — so its absence costs nothing.
    """
    raw = info.get("requested_entries")
    if not isinstance(raw, list):
        return None
    out: list[int] = []
    for item in cast(list[Any], raw):
        if not isinstance(item, int) or isinstance(item, bool):
            return None
        out.append(item)
    return out


def _gaps(
    holes: list[int],
    info: Mapping[str, Any],
    listed_total: int,
    errors: ExtractionLog | None,
) -> list[ExtractGap]:
    """One :class:`ExtractGap` per entry the source listed and yt-dlp handed back as nothing.

    Two sources of holes, and both are counted because the difference is invisible to whoever
    reads the number: a ``None`` left in ``entries`` by ``ignoreerrors``, and the shortfall
    between ``playlist_count`` — the source's own statement of how many it holds — and the
    length of the list. Either way ``len(entries) + len(unreadable)`` is what the playlist
    claimed to contain, which is the "of 20" in "19 of 20 entries".
    """
    positions = _stated_positions(info)
    # The n-th message belongs to the n-th hole *only* if yt-dlp logged exactly one per hole.
    # Anything else — a retry that also failed, a warning promoted to an error — and the
    # alignment is a guess, so the gaps keep their positions and lose their sentences.
    aligned = errors is not None and len(errors.messages) == len(holes)
    gaps: list[ExtractGap] = []
    for nth, at in enumerate(holes):
        position = positions[at] if positions is not None and at < len(positions) else at + 1
        video_id, reason = errors.gap(nth) if aligned and errors is not None else (None, None)
        code = classify_message(reason) if reason else ErrorCode.UNKNOWN
        gaps.append(
            ExtractGap(
                position=position,
                id=video_id,
                reason=reason,
                # Never `UNKNOWN`: even with nothing to quote, what happened is known — the
                # playlist answered and one of its entries did not.
                code=ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE if code is ErrorCode.UNKNOWN else code,
            )
        )
    stated = _as_int(info.get("playlist_count"))
    missing = 0 if stated is None else stated - listed_total
    for _ in range(max(0, missing)):
        gaps.append(ExtractGap(code=ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE))
    return gaps


def result_from_info(
    info: Mapping[str, Any], *, errors: ExtractionLog | None = None
) -> ExtractResult:
    """Turn a video or playlist info dict into an :class:`ExtractResult`.

    ``errors`` is the :class:`ExtractionLog` the same call was run with. It is optional because
    two callers have none — the fixtures backend and the maintenance self-test — and a gap
    without a sentence is still a gap.
    """
    entries_raw = info.get("entries")
    if isinstance(entries_raw, list):
        items = cast(list[Any], entries_raw)
        entries: list[ExtractEntry] = []
        holes: list[int] = []
        # `ignoreerrors` replaces an entry it could not read with `None`. It is **counted, not
        # dropped**: nineteen entries where the source listed twenty is a fact the operator has
        # to be told, and the whole defect this file was changed for is nineteen good tracks
        # being thrown away to report the twentieth.
        for at, item in enumerate(items):
            if isinstance(item, dict):
                entries.append(entry_from_info(cast(dict[str, Any], item), len(entries)))
            else:
                holes.append(at)
        return ExtractResult(
            kind="playlist",
            title=_as_str(info.get("title")),
            uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
            id=_as_str(info.get("id")),
            entries=entries,
            unreadable=_gaps(holes, info, len(items), errors),
        )
    return ExtractResult(
        kind="video",
        title=_as_str(info.get("title")),
        uploader=_as_str(info.get("uploader")) or _as_str(info.get("channel")),
        id=_as_str(info.get("id")),
        entries=[entry_from_info(info, 0)],
    )


def downloaded_path(info: Mapping[str, Any]) -> Path | None:
    """The file yt-dlp actually wrote, taken from the info dict — never from stdout."""
    requested = info.get("requested_downloads")
    if isinstance(requested, list) and requested:
        first = cast(list[Any], requested)[0]
        if isinstance(first, dict):
            for key in ("filepath", "_filename", "filename"):
                value = cast(dict[str, Any], first).get(key)
                if isinstance(value, str) and value:
                    return Path(value)
    for key in ("filepath", "_filename"):
        value = info.get(key)
        if isinstance(value, str) and value:
            return Path(value)
    return None
