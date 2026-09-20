"""Structured error taxonomy shared with the TypeScript side.

Every failure the toolbox reports carries four fields — ``code``, ``message``, ``hint`` and
``action`` — and they are the *same* four the Console's error decoder shows. The catalog
below is the single source of truth on the Python side; `packages/contracts` mirrors it
through the generated OpenAPI document.

``hint`` and ``action`` are copied from the prototype's ``errorCatalog``
(`prototypes/shared/data.js`) so that a code raised here renders exactly as designed.
"""

from __future__ import annotations

import re
import traceback
from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, cast

from pydantic import BaseModel, Field

__all__ = [
    "ERROR_CATALOG",
    "ErrorBody",
    "ErrorCode",
    "ErrorSpec",
    "ToolboxError",
    "classify_message",
    "classify_ytdlp_error",
    "describe_failure",
    "spec_for",
    "strip_ytdlp_prefix",
]


class ErrorCode(StrEnum):
    """Every failure mode the toolbox knows how to name."""

    YTDLP_BOT_CHECK = "YTDLP_BOT_CHECK"
    YTDLP_403 = "YTDLP_403"
    YTDLP_FORMAT = "YTDLP_FORMAT"
    YTDLP_NSIG = "YTDLP_NSIG"
    YTDLP_UNAVAILABLE = "YTDLP_UNAVAILABLE"
    YTDLP_AGE = "YTDLP_AGE"
    YTDLP_PRIVATE = "YTDLP_PRIVATE"
    #: The three shades of "this playlist did not come back", which used to collapse into
    #: `YTDLP_UNAVAILABLE` — "This video is not available" — whichever of them had happened.
    #: That is the sentence that made twenty live playlists look dead: one entry inside them
    #: was gone, and the whole call reported the entry's own failure as the playlist's.
    PLAYLIST_UNAVAILABLE = "PLAYLIST_UNAVAILABLE"
    PLAYLIST_PRIVATE = "PLAYLIST_PRIVATE"
    PLAYLIST_ENTRY_UNAVAILABLE = "PLAYLIST_ENTRY_UNAVAILABLE"
    FFMPEG_MISSING = "FFMPEG_MISSING"
    DOWNLOAD_CONTAINER = "DOWNLOAD_CONTAINER"
    TAG_WRITE_FAILED = "TAG_WRITE_FAILED"
    PLACE_CONFLICT = "PLACE_CONFLICT"
    LOCKED = "LOCKED"
    FIXTURE_UNKNOWN = "FIXTURE_UNKNOWN"
    #: Nothing in the catalog matched. Kept deliberately last so that the UI can show the raw
    #: yt-dlp message rather than pretending to understand it.
    UNKNOWN = "UNKNOWN"


@dataclass(frozen=True, slots=True)
class ErrorSpec:
    """A catalog entry: how to recognise a failure and what to tell the operator."""

    code: ErrorCode
    #: Default human message. Overridden by the real exception text when there is one.
    message: str
    #: Why it happened, in one sentence. Mirrors ``cause`` in the prototype's catalog.
    hint: str
    #: Label of the single button the UI offers. Empty string means "no button".
    action: str
    #: HTTP status used when the error surfaces on a synchronous endpoint.
    status: int = 422
    #: Case-insensitive substrings that identify this failure in a yt-dlp message.
    patterns: tuple[str, ...] = ()


#: Ordered: the first entry whose pattern matches wins, so the specific ones come first.
ERROR_CATALOG: Final[tuple[ErrorSpec, ...]] = (
    ErrorSpec(
        code=ErrorCode.YTDLP_BOT_CHECK,
        message="YouTube asked this client to confirm it is not a bot.",
        hint="YouTube challenges anonymous or datacenter IPs.",
        action="Configure cookies",
        status=403,
        patterns=(
            "sign in to confirm you're not a bot",
            "sign in to confirm you’re not a bot",  # noqa: RUF001 - YouTube's own text
            "confirm you're not a bot",
        ),
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_NSIG,
        message="yt-dlp could not solve YouTube's JavaScript challenge.",
        hint="JS challenge changed; downloads will be throttled or fail.",
        action="Update yt-dlp",
        patterns=("nsig extraction failed", "unable to decode n-parameter"),
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_403,
        message="YouTube refused the download with HTTP 403.",
        hint="Signature/nsig extraction broke after a YouTube change.",
        action="Update yt-dlp",
        status=403,
        patterns=("http error 403", "403: forbidden", "403 forbidden"),
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_FORMAT,
        message="No audio format was offered for this video.",
        hint="Player client returned no audio formats.",
        action="Update yt-dlp",
        patterns=(
            "requested format is not available",
            "no video formats found",
            "requested format not available",
        ),
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_AGE,
        message="This video is age-restricted.",
        hint="Age gate requires an authenticated session.",
        action="Configure cookies",
        status=403,
        patterns=("age-restricted", "age restricted", "confirm your age", "inappropriate"),
    ),
    ErrorSpec(
        code=ErrorCode.PLAYLIST_PRIVATE,
        message="This playlist is private.",
        hint="The playlist exists but only its owner can list it.",
        action="Configure cookies",
        status=403,
        patterns=(
            "this playlist is private",
            "playlist is private",
            "sign in to view this playlist",
            "this playlist type is unviewable",
        ),
    ),
    ErrorSpec(
        code=ErrorCode.PLAYLIST_UNAVAILABLE,
        message="This playlist no longer exists.",
        hint="The playlist itself was deleted, or the id is wrong.",
        action="Find alternative",
        status=404,
        patterns=(
            "the playlist does not exist",
            "playlist does not exist",
            "playlist unavailable",
            "this playlist is unavailable",
        ),
    ),
    ErrorSpec(
        code=ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE,
        message="An entry of this playlist could not be read.",
        hint="The playlist is fine; one of the videos inside it is gone, private or blocked.",
        action="Import what came back",
        status=404,
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_PRIVATE,
        message="This video is private.",
        hint="The uploader made it private; no session can read it.",
        action="Find alternative",
        status=404,
        patterns=("private video", "this video is private", "join this channel"),
    ),
    ErrorSpec(
        code=ErrorCode.YTDLP_UNAVAILABLE,
        message="This video is unavailable.",
        hint="The video was removed or is private/region-locked.",
        action="Find alternative",
        status=404,
        patterns=(
            "video unavailable",
            # yt-dlp says "This video is unavailable" as often as the terse
            # "Video unavailable", and the two share no substring.
            "video is unavailable",
            "this video is no longer available",
            "removed by the uploader",
            "not available in your country",
        ),
    ),
    ErrorSpec(
        code=ErrorCode.FFMPEG_MISSING,
        message="ffmpeg is not available in this image.",
        hint="Post-processing needs ffmpeg on PATH.",
        action="Open settings",
        status=500,
        patterns=("ffmpeg not found", "ffprobe and ffmpeg not found", "ffmpeg is not installed"),
    ),
    ErrorSpec(
        code=ErrorCode.DOWNLOAD_CONTAINER,
        message="The downloaded file is in a container that cannot hold tags.",
        hint="The audio was not remuxed out of its video container.",
        action="Check the download format",
        status=422,
    ),
    ErrorSpec(
        code=ErrorCode.TAG_WRITE_FAILED,
        message="The tags could not be written to this file.",
        hint="The container was not recognised, is read-only, or the tag block is corrupt.",
        action="Retry tagging",
        status=422,
    ),
    ErrorSpec(
        code=ErrorCode.PLACE_CONFLICT,
        message="Something already exists at the destination.",
        hint="A file is already placed there and no conflict policy was given.",
        action="Choose what to keep",
        status=409,
    ),
    ErrorSpec(
        code=ErrorCode.LOCKED,
        message="A download is already running.",
        hint="The toolbox downloads one file at a time, on purpose.",
        action="Wait for the current download",
        status=409,
    ),
    ErrorSpec(
        code=ErrorCode.FIXTURE_UNKNOWN,
        message="No fixture is recorded for this URL.",
        hint="Fixtures mode only answers for the recorded fixture:// URLs.",
        action="Use a recorded fixture",
        status=404,
    ),
    ErrorSpec(
        code=ErrorCode.UNKNOWN,
        message="The operation failed.",
        hint="No known cause matched; the original message is in `message`.",
        action="",
        status=500,
    ),
)

_BY_CODE: Final[dict[ErrorCode, ErrorSpec]] = {spec.code: spec for spec in ERROR_CATALOG}

#: yt-dlp prefixes every user-visible message with "ERROR: " and often a video id.
_YTDLP_PREFIX = re.compile(r"^\s*(?:ERROR:\s*)?(?:\[[^\]]+\]\s*)?(?:[\w-]{11}:\s*)?", re.IGNORECASE)


def spec_for(code: ErrorCode) -> ErrorSpec:
    """The catalog entry for ``code``. Every member of the enum has one."""
    return _BY_CODE[code]


def strip_ytdlp_prefix(message: str) -> str:
    """``ERROR: [youtube] dQw4w9WgXcQ: Private video`` → ``Private video``.

    Public because two callers need the same sentence: this module, turning an exception into
    a body, and :class:`toolbox.ytdlp.ExtractionLog`, turning a failure yt-dlp *swallowed* into
    the reason attached to one gap in a playlist.
    """
    return _YTDLP_PREFIX.sub("", message.strip()).strip()


def classify_message(message: str) -> ErrorCode:
    """Map a raw yt-dlp (or ffmpeg) message onto a catalog code."""
    haystack = message.casefold()
    for spec in ERROR_CATALOG:
        if any(pattern in haystack for pattern in spec.patterns):
            return spec.code
    return ErrorCode.UNKNOWN


class ErrorBody(BaseModel):
    """The JSON body of every failed request, and of the NDJSON ``error`` event."""

    code: ErrorCode
    message: str
    hint: str
    action: str
    details: dict[str, Any] = Field(default_factory=dict[str, Any])


class ToolboxError(Exception):
    """A failure that already knows how it should be presented.

    ``hint`` and ``action`` default to the catalog's and exist for the caller that knows more
    than the code does. The catalog answers by *code*, and a code can cover two situations that
    need different words — `PLAYLIST_ENTRY_UNAVAILABLE` is "one video of twenty is gone, import
    the nineteen" **and** "all twenty answered the same refusal, nothing came back". Only the
    raise site can tell them apart, so it must be able to say which one it is.
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        *,
        hint: str | None = None,
        action: str | None = None,
        status: int | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        spec = spec_for(code)
        self.code = code
        self.message = message or spec.message
        self.hint = hint or spec.hint
        self.action = action or spec.action
        self.status = status if status is not None else spec.status
        self.details: dict[str, Any] = details or {}
        super().__init__(f"{code}: {self.message}")

    def body(self) -> ErrorBody:
        """The wire representation, identical for HTTP bodies and NDJSON events."""
        return ErrorBody(
            code=self.code,
            message=self.message,
            hint=self.hint,
            action=self.action,
            details=self.details,
        )


def classify_ytdlp_error(exc: BaseException, **details: Any) -> ToolboxError:
    """Turn any yt-dlp exception into a catalogued :class:`ToolboxError`.

    The v1 downloader read stdout and guessed; here the exception object is the signal and
    its message is only used to pick a code, never to find a file path.
    """
    raw = str(exc).strip()
    code = classify_message(raw)
    message = strip_ytdlp_prefix(raw) or spec_for(code).message
    payload: dict[str, Any] = {"exception": type(exc).__name__, **details}
    return ToolboxError(code, message, details=payload)


def describe_failure(error: ToolboxError) -> dict[str, Any]:
    """Everything a log line should say about a failure, in one payload.

    `code`, `message`, `hint` and `action` are the four fields the Console shows. `details` is
    what they were summarised *from*, and for the case that matters it is the only place the
    reason exists: a playlist whose every entry was refused reports "None of the 15 entries
    could be read" while the fifteen sentences yt-dlp gave sit in `unreadable`, one per gap.
    Logging the summary alone is what left an import that produced nothing with nothing to
    read in `docker logs`.

    `reasons` is those sentences deduplicated with their count — fifteen refusals are one
    sentence fifteen times, and the operator wants the sentence. `cause` is the exception this
    one was raised from (`raise ... from exc`): yt-dlp's own text, which is where the real
    message lives when the catalogue has renamed it, plus its traceback. A cookie jar's *path*
    may appear in `details`; its values never do.
    """
    payload: dict[str, Any] = {
        "code": error.code.value,
        "message": error.message,
        "hint": error.hint,
        "action": error.action,
        "status": error.status,
        "details": error.details,
    }
    reasons = _reasons(error.details)
    if reasons:
        payload["reasons"] = reasons
    cause = error.__cause__
    if cause is not None:
        payload["cause"] = "".join(traceback.format_exception_only(type(cause), cause)).strip()
        payload["cause_traceback"] = traceback.format_exception(cause)
    return payload


def _reasons(details: Mapping[str, Any]) -> list[str]:
    """The distinct per-gap sentences a listing carries, commonest first."""
    counts: Counter[str] = Counter()
    unreadable = details.get("unreadable")
    if not isinstance(unreadable, list):
        return []
    for gap in cast("list[Any]", unreadable):
        if not isinstance(gap, Mapping):
            continue
        reason = cast("Mapping[str, Any]", gap).get("reason")
        if isinstance(reason, str) and reason.strip():
            counts[reason.strip()] += 1
    sentences: list[str] = []
    for reason, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        # The count is deliberate: fifteen identical refusals are one sentence, not fifteen.
        sentences.append(reason if count == 1 else f"{reason} ({count}×)")  # noqa: RUF001
    return sentences
