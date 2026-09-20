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
from collections.abc import Callable, Generator, Iterable, Mapping, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Final, cast

from yt_dlp import YoutubeDL  # pyright: ignore[reportMissingTypeStubs]

from toolbox.config import ytdlp_verbose
from toolbox.errors import ErrorCode, classify_message, strip_ytdlp_prefix
from toolbox.models import ExtractEntry, ExtractGap, ExtractResult, Thumbnail, YtdlpOptions
from toolbox.tagging import TAGGABLE_SUFFIXES

__all__ = [
    "ExtractionLog",
    "audio_extraction_codec",
    "build_options",
    "cookie_jar",
    "cookie_secrets",
    "cookie_shape",
    "downloaded_path",
    "entry_from_info",
    "extract_info",
    "is_unavailable",
    "jar_secret_values",
    "redact_cookies",
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

#: Levels that reach the log whatever ``verbose`` says: the two that carry a refusal, or the
#: sentence that explains one. `info` and `debug` stay behind the flag — they are yt-dlp walking
#: its own code, thousands of lines per download.
_ALWAYS_FORWARDED: Final[frozenset[str]] = frozenset({"error", "warning"})

#: yt-dlp's own words, said once per call, when YouTube refused the account cookies it was
#: handed. Its text, not ours: it is quoted in the failure's hint.
_COOKIES_REJECTED: Final[re.Pattern[str]] = re.compile(
    r"account cookies are no longer valid", re.IGNORECASE
)
#: ``[youtube] dQw4w9WgXcQ: Private video`` — the id yt-dlp names in a failure it swallowed.
#: Eleven characters is the YouTube video id, and nothing else in these messages has that
#: shape between a bracket and a colon.
_ERROR_ID: Final[re.Pattern[str]] = re.compile(r"\[[^\]]+\]\s+([A-Za-z0-9_-]{11}):")
#: Field index of the value in a Netscape jar line — domain, flag, path, secure, expiry, name,
#: value. Everything before it is metadata; the field itself is the credential.
_JAR_VALUE_INDEX: Final[int] = 6
#: `Cookie: …`, `'Cookie': '…'`, `Set-Cookie: …` — redacted from the header name to the end of
#: the line. Blunt on purpose: it catches the shapes yt-dlp formats itself, which are the ones
#: no caller can know about, and a line carrying a cookie is not worth keeping.
_COOKIE_HEADER: Final[re.Pattern[str]] = re.compile(r"""(?i)\b((?:set-)?cookie)['"]?\s*[:=]\s.*$""")


def jar_secret_values(text: str) -> list[str]:
    """The cookie values of a Netscape jar, so they can be kept out of the logs.

    Every one of them is a credential: a YouTube session cookie in `docker logs` is a session
    anybody reading the log can use. They are read from the jar the toolbox itself just wrote,
    so what gets redacted is exactly what was handed to yt-dlp rather than a guess at what a
    request header looks like.
    """
    values: list[str] = []
    for line in text.splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        fields = line.split("\t")
        if len(fields) > _JAR_VALUE_INDEX and fields[_JAR_VALUE_INDEX].strip():
            values.append(fields[_JAR_VALUE_INDEX])
    return values


def redact_cookies(line: str, secrets: Sequence[str]) -> str:
    """A yt-dlp line with the jar's values, and any cookie header, taken out of it."""
    for value in secrets:
        line = line.replace(value, "<redacted>")
    return _COOKIE_HEADER.sub(r"\1: <redacted>", line)


class ExtractionLog:
    """What ``ignoreerrors`` swallowed, kept so the caller can still say what happened.

    ``ignoreerrors`` is the difference between "one dead video kills the playlist" and
    "nineteen of twenty come back", but it buys that by turning an exception into a line on
    stderr. yt-dlp's ``logger`` option is the documented way to intercept that line, so this
    object *is* the option: ``report_error`` arrives at :meth:`error`, and the messages are kept
    for the two readers in :mod:`toolbox.extract` —

    - when yt-dlp came back with **nothing at all**, the first message here is the only
      statement of why, and it is what the error is classified from. Without it the caller
      sees ``yt-dlp returned no information`` and has to guess between "the playlist is gone",
      "the playlist is private" and "a video inside it is";
    - when yt-dlp came back with a **playlist minus some entries**, one message was logged per
      entry it gave up on, in the order it tried them, which is how a gap gets an id and a
      sentence instead of only a position.

    **Keeping a message is not the same as being able to read it.** The owner's complaint was an
    import that produced nothing and a `docker logs` that said nothing, while the refusals
    yt-dlp had already named sat in this list. Every line is therefore also forwarded to a
    structlog logger when one is given: `error` lines whatever the configured level, because
    the sentence is the whole point, `warning` lines for the same reason, and the rest only
    when ``verbose`` — yt-dlp's own debug stream, thousands of lines per download, request
    headers included, which is why :meth:`add_secrets` exists and why the jar's values are
    stripped out of every line before it is logged.

    **Warnings are in that first group because of what one of them says.** The refusals are
    loud: yt-dlp reports one per entry, at `error`, and they are all the same sentence — *"Sign
    in to confirm you're not a bot"* — whether the jar was a session that died, a jar of
    anonymous cookies, or no jar at all. The line that tells those three apart is quieter: when
    YouTube answers as if nobody were signed in, yt-dlp says so **once**, at `warning` — "The
    provided YouTube account cookies are no longer valid" — and the toolbox used to drop it
    unless somebody had turned ``verbose`` on. The operator was left reading fifteen identical
    refusals with the explanation sitting in the same process, which is the complaint this
    class exists to answer. :attr:`session_verdict` is that line, and
    :func:`toolbox.extract.extract` quotes it in the failure's `hint`.
    """

    __slots__ = ("_log", "_secrets", "_verbose", "messages", "warnings")

    def __init__(self, log: Any | None = None, *, verbose: bool = False) -> None:
        self.messages: list[str] = []
        self.warnings: list[str] = []
        self._log = log
        self._verbose = verbose
        self._secrets: list[str] = []

    def add_secrets(self, values: Iterable[str]) -> None:
        """Register cookie values to keep out of every line forwarded from now on."""
        self._secrets.extend(value for value in values if value)

    def _emit(self, level: str, msg: str) -> None:
        """Forward one yt-dlp line, redacted, if the level and the verbosity want it."""
        if self._log is None or (level not in _ALWAYS_FORWARDED and not self._verbose):
            return
        line = redact_cookies(str(msg), self._secrets).rstrip()
        if not line:
            return
        if level == "debug":
            self._log.debug("ytdlp", line=line)
        elif level == "info":
            self._log.info("ytdlp", line=line)
        elif level == "warning":
            self._log.warning("ytdlp", line=line)
        else:
            self._log.error("ytdlp", line=line)

    # -- yt-dlp's logger protocol; `error` and `warning` are also kept -------------------
    def debug(self, msg: str) -> None:
        self._emit("debug", msg)

    def info(self, msg: str) -> None:
        self._emit("info", msg)

    def warning(self, msg: str) -> None:
        """Forward one warning, and keep it — this is where YouTube's *reason* arrives.

        A warning is the one level that carries a sentence the refusals do not: yt-dlp reports
        each refusal per entry and never says why, then says why once, here. Kept without its
        prefix and without colour, the way :meth:`error` keeps a refusal, so
        :attr:`session_verdict` can hand the sentence back verbatim — and redacted here rather
        than only in the log, because that sentence ends up in a failure's `hint`, which travels
        in the API response: a line kept for the operator is still a line that can leave the
        process, so it leaves with the jar's values already gone.

        **Once per distinct sentence**, however many entries yt-dlp repeated it for. It walks a
        playlist entry by entry, so "no JS runtime" and "no title found" arrive once per video:
        fifteen tracks wrote forty-six warnings on the owner's album, and a two-hundred-entry
        playlist would write four hundred lines of the same three sentences, burying the one
        that differs — which is the whole reason warnings are kept.
        """
        clean = strip_ytdlp_prefix(redact_cookies(_ANSI.sub("", str(msg)), self._secrets)).strip()
        if not clean or clean in self.warnings:
            return
        self.warnings.append(clean)
        self._emit("warning", clean)

    def error(self, msg: str) -> None:
        """Forward one failure, and keep it without its ``ERROR:`` prefix or its colour."""
        self._emit("error", msg)
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

    @property
    def session_verdict(self) -> str | None:
        """yt-dlp's own sentence when YouTube refused the session it was handed, if it said one.

        It arrives once, as a warning, and it answers the only question a refusal leaves open.
        *"Sign in to confirm you're not a bot"* is what YouTube says to a datacenter IP with no
        jar, to a jar of anonymous cookies, **and** to a session rotated out from under the
        export — three different cures behind one sentence. This line separates them, and it is
        handed back verbatim rather than summarised: the export tips at its end are yt-dlp's
        own, and they are the ones the reader needs.
        """
        for line in self.warnings:
            if _COOKIES_REJECTED.search(line):
                return line
        return None


def yt_dlp_version() -> str | None:
    """The running yt-dlp version, read from the module rather than a binary."""
    try:
        from yt_dlp.version import __version__  # pyright: ignore[reportMissingTypeStubs]
    except ImportError:  # pragma: no cover - yt-dlp is a hard dependency
        return None
    return str(__version__)


def _client_list(value: str) -> list[str]:
    """``web_safari,web_embedded,-tv_downgraded`` → three values, in order.

    Empty fragments are dropped rather than passed on: ``a,,b`` is a typo, not a client whose
    name is the empty string.
    """
    return [part.strip() for part in value.split(",") if part.strip()]


def build_options(options: YtdlpOptions, **overrides: Any) -> dict[str, Any]:
    """Assemble the yt-dlp option dict. ``extra_args`` is merged last, on purpose.

    ``cookiefile`` may be supplied through ``overrides`` — that is how :func:`cookie_jar`
    hands over the temporary file it wrote for an inline jar.
    """
    built: dict[str, Any] = {**_BASE, **overrides}
    if "cookiefile" not in built and options.cookies:
        built["cookiefile"] = options.cookies
    if options.player_client:
        # Split on commas, because that is what the value *is*. yt-dlp's own CLI turns
        # `player_client=web_safari,web_embedded,-tv_downgraded` into three values, and the
        # setting's help text documents that same comma-separated form — but this handed the
        # whole string over as **one** element, so yt-dlp read a single client named
        # "web_safari,web_embedded,-tv_downgraded", answered `Skipping unsupported client`, and
        # carried on with its defaults. Silently: this toolbox runs `quiet` and `no_warnings`,
        # so even that warning was thrown away, and the operator had every reason to believe a
        # setting that had been applied.
        built["extractor_args"] = {
            "youtube": {"player_client": _client_list(options.player_client)}
        }
    if ytdlp_verbose():
        # `quiet` stays: stdout is never read, and the debug stream travels through the `logger`
        # option. `no_warnings` has to go, or the stream arrives with its warnings cut out.
        built["verbose"] = True
        built["no_warnings"] = False
    built.update(options.extra_args)
    return built


@contextmanager
def cookie_jar(options: YtdlpOptions) -> Generator[dict[str, Any]]:
    """Yield the ``cookiefile`` override for this call, cleaning up after itself.

    Inline content is the case that matters: on a real server the operator has a browser
    export to paste into the Console, not a path that happens to exist inside this container
    (owner review B6). It is written 0600 to the system temp directory and removed on the way
    out, so it never lands in the library, in a log, or in an image layer.

    **A path is copied before it is used, never handed to yt-dlp directly.** yt-dlp does not
    only read a jar, it rewrites it — expiring cookies it found dead, refreshing the ones it
    renewed — and on a real installation the file is a mount the operator made read-only on
    purpose. Handing over the operator's own path made every download die with
    `OSError: [Errno 30] Read-only file system` at the *end* of a successful fetch, which reads
    as a download failure and is nothing of the sort. The copy is what a pasted jar already
    got; a path now gets the same treatment, and the operator's file is never touched.
    """
    content = options.cookies_content
    if not content and not options.cookies:
        yield {}
        return
    handle = tempfile.NamedTemporaryFile(  # noqa: SIM115 - closed explicitly below
        "w", prefix="mm-cookies-", suffix=".txt", encoding="utf-8", delete=False
    )
    try:
        if content:
            handle.write(content if content.endswith("\n") else f"{content}\n")
        else:
            source = Path(str(options.cookies))
            if not source.is_file():
                raise ValueError(f"Cookies file not found: {source}")
            handle.write(source.read_text(encoding="utf-8", errors="replace"))
        handle.close()
        Path(handle.name).chmod(0o600)
        yield {"cookiefile": handle.name}
    finally:
        Path(handle.name).unlink(missing_ok=True)


def cookie_shape(options: YtdlpOptions) -> dict[str, Any]:
    """What a request carried, for the log: the shape of the jar, never its content.

    "I get nothing with cookies and without them" is a sentence about two different requests,
    and the log has to be able to tell them apart: whether a jar arrived at all, which of the
    two shapes it was, how many cookies it held, whether the path it named is even there. The
    values are credential material and stay out of it.
    """
    content = options.cookies_content
    if content:
        return {"mode": "inline", "cookies": _cookie_lines(content), "bytes": len(content)}
    if not options.cookies:
        return {"mode": "none"}
    path = Path(str(options.cookies))
    if not path.is_file():
        return {"mode": "path", "path": str(path), "exists": False}
    text = path.read_text(encoding="utf-8", errors="replace")
    return {
        "mode": "path",
        "path": str(path),
        "exists": True,
        "cookies": _cookie_lines(text),
        "bytes": len(text),
    }


def cookie_secrets(options: YtdlpOptions) -> list[str]:
    """The credential values of the jar a request carries, so the log can keep them out.

    Read from the same two shapes `cookie_jar` copies: the pasted export, or the file the
    operator mounted. A literal read an instant before yt-dlp is handed the copy, because the
    alternative — logging request headers with a YouTube session in them — is how a `docker
    logs` paste becomes somebody else's session.
    """
    content = options.cookies_content
    if content:
        return jar_secret_values(content)
    if not options.cookies:
        return []
    path = Path(str(options.cookies))
    if not path.is_file():
        return []
    return jar_secret_values(path.read_text(encoding="utf-8", errors="replace"))


def _cookie_lines(text: str) -> int:
    """How many cookies a jar holds — its lines that are neither blank nor a comment."""
    return sum(1 for line in text.splitlines() if line.strip() and not line.startswith("#"))


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
