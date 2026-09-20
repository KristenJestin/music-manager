"""`POST /extract` — resolve a URL to entries, without downloading anything.

This is the `resolve` step of `docs/04-pipeline-et-matching.md`: yt-dlp is asked for the
metadata only, and the result feeds the matcher — durations, YouTube Music's own
`track`/`artist`/`album`/`release_year` tags, and the auto-generated description whose
"Provided to YouTube by" block v1 already proved to be a reliable signal.

**A dead entry is a gap, never a verdict on the playlist.** That is the one rule this module
now exists to hold: `ignoreerrors` is on for every extraction, what could not be read comes
back in `ExtractResult.unreadable`, and the three ways a playlist can fail to answer are three
codes instead of one borrowed from whichever video happened to be broken.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, Final

import structlog

from toolbox import fixtures
from toolbox.config import fixtures_enabled, ytdlp_verbose
from toolbox.errors import (
    ErrorCode,
    ToolboxError,
    classify_message,
    classify_ytdlp_error,
    strip_ytdlp_prefix,
)
from toolbox.models import ExtractGap, ExtractRequest, ExtractResult
from toolbox.urls import UrlKind, is_fixture_url, parse_url
from toolbox.ytdlp import (
    ExtractionLog,
    build_options,
    cookie_jar,
    cookie_secrets,
    cookie_shape,
    extract_info,
    result_from_info,
)

__all__ = ["extract", "listing_options"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.extract")


def listing_options(flat: bool) -> dict[str, object]:
    """The options that turn a yt-dlp call into *a listing we are allowed to lose parts of*.

    **`ignoreerrors=True`, in both modes.** It used to be flat mode's alone, on the reasoning
    that a watched playlist accumulates private and deleted videos forever and a scan must not
    stop at the first one. The reasoning was right and the scope was wrong: an ordinary
    playlist accumulates them too. With the default (`False`) yt-dlp raises on the first entry
    it cannot reach and the nineteen it had already read are discarded with it — which is how
    twenty of the owner's playlists came to be recorded as "vanished from YouTube" on the
    strength of one dead video each, under that video's own message, *"This video is not
    available"*.

    **Not `"only_download"`.** yt-dlp's option takes `False`, `True` or `"only_download"`, and
    the third ignores failures *during a download* and nothing else. The failure here happens
    while the playlist is being enumerated, so `"only_download"` would abort exactly as `False`
    does. There is no narrower value to prefer.

    Turning it on does **not** make a dead single video succeed. yt-dlp then answers `None` for
    the whole call, :func:`toolbox.ytdlp.extract_info` refuses an empty info dict, and
    :func:`_failure` classifies it from the sentence the log kept. One dead video is still an
    error; a playlist that lost one entry is now nineteen entries and a gap.

    `extract_flat="in_playlist"` rather than `True`: a *video* URL asked for flatly must still
    come back as a video, and `True` would answer with a stub for it too.
    """
    options: dict[str, object] = {"ignoreerrors": True}
    if flat:
        options["extract_flat"] = "in_playlist"
    return options


#: A video-level code, seen on a playlist URL that produced no entry at all, is a statement
#: about the playlist and not about a video. `UNKNOWN` is promoted with them: "the playlist did
#: not answer" is more than was otherwise known, and it is true.
_PLAYLIST_EQUIVALENT: Final[dict[ErrorCode, ErrorCode]] = {
    ErrorCode.YTDLP_UNAVAILABLE: ErrorCode.PLAYLIST_UNAVAILABLE,
    ErrorCode.YTDLP_PRIVATE: ErrorCode.PLAYLIST_PRIVATE,
    ErrorCode.UNKNOWN: ErrorCode.PLAYLIST_UNAVAILABLE,
}

#: Added to a hint when yt-dlp said the jar it was given is no longer a session. The sentence is
#: quoted rather than paraphrased because the export tips at its end — yt-dlp's own wiki page —
#: are the ones the reader needs, and because a paraphrase of somebody else's diagnosis is how a
#: right answer becomes an arguable one.
_SESSION_REJECTED: Final[str] = (
    "yt-dlp named the session itself: “{verdict}” — and it says that only when the jar was a "
    "session when the run started, so the session *was* sent and YouTube dropped it in a "
    "response. Two readings, with opposite moves: the export is stale, or this machine is what "
    "YouTube refuses. Export a fresh jar from a signed-in browser and retry; if the same line "
    "comes back, run that same jar from another machine before exporting a third time."
)


def _failure(
    exc: Exception,
    errors: ExtractionLog,
    *,
    url: str,
    playlist: bool,
    cookies: dict[str, Any],
) -> ToolboxError:
    """The error to raise when the call came back with nothing, said in the right words.

    Three cases used to arrive here as one sentence — *"This video is not available"* — because
    whatever failed first threw, and on a playlist that was usually a video inside it. They are
    now three codes:

    - **`PLAYLIST_UNAVAILABLE`** — the playlist itself is gone;
    - **`PLAYLIST_PRIVATE`** — the playlist is there and we are not allowed to list it;
    - **`YTDLP_*`** — a *video* URL failed, which is the one case that is about a video.

    (The third of the owner's three, *an entry inside a healthy playlist*, is no longer an
    error at all: it is an :class:`toolbox.models.ExtractGap` and the other nineteen come back.
    It reaches this file only when it happened to **every** entry, in :func:`extract`.)

    The log is read before the exception because with `ignoreerrors` the exception is *ours*:
    `extract_info` raises "yt-dlp returned no information", while yt-dlp's own sentence — the
    one worth classifying and worth quoting — was swallowed into the log a moment earlier.
    """
    swallowed = errors.messages[0] if errors.messages else ""
    error = (
        ToolboxError(
            classify_message(swallowed),
            strip_ytdlp_prefix(swallowed),
            details={"exception": type(exc).__name__, "url": url, "cookies": cookies},
        )
        if swallowed
        else classify_ytdlp_error(exc, url=url, cookies=cookies)
    )
    if not playlist:
        return _explained(error, errors)
    promoted = _PLAYLIST_EQUIVALENT.get(error.code)
    return _explained(
        error if promoted is None else ToolboxError(promoted, error.message, details=error.details),
        errors,
    )


def _shared_reason(gaps: Sequence[ExtractGap]) -> str | None:
    """The one sentence every unreadable entry answered, when they all answered the same.

    `None` when they disagree, or when any of them came back without a sentence at all: a
    "shared" reason that half the entries do not carry is not shared.
    """
    reasons = {gap.reason for gap in gaps if gap.reason}
    if len(reasons) != 1 or any(gap.reason is None for gap in gaps):
        return None
    return next(iter(reasons))


def _refusal_hint(shared: str | None, errors: ExtractionLog) -> str | None:
    """The hint for "every entry answered the same refusal", plus yt-dlp's reason if it had one.

    The shared sentence is the *what*; the session verdict is the *why*, and a hint that gives
    the first without the second is what sends an operator to his player client while YouTube is
    refusing the session he has just pasted.
    """
    verdict = errors.session_verdict
    explained = None if verdict is None else _SESSION_REJECTED.format(verdict=verdict)
    if shared is None:
        return explained
    refusal = (
        "The playlist itself was read: every entry answered the same thing — "
        f"“{shared}”. That is YouTube refusing the request rather than a deleted "
        "video, so look at the session (the cookies) and at the player client."
    )
    return refusal if explained is None else f"{refusal} {explained}"


def _explained(error: ToolboxError, errors: ExtractionLog) -> ToolboxError:
    """The same failure, with the sentence that explains it, when yt-dlp said one.

    Only the raise site can add this: the catalog answers by *code*, and `YTDLP_BOT_CHECK` is
    three situations — no jar at all, a jar of anonymous cookies, a session YouTube no longer
    accepts — that want three different words. `session` goes into the details too, so whoever
    reads the JSON does not have to parse the hint to learn which of the three it was.
    """
    verdict = errors.session_verdict
    if verdict is None:
        return error
    return ToolboxError(
        error.code,
        error.message,
        hint=f"{error.hint} {_SESSION_REJECTED.format(verdict=verdict)}",
        action=error.action,
        status=error.status,
        details={
            **error.details,
            "session": {
                "cookies_rejected": True,
                # Why this is a verdict on the session and not on the export: yt-dlp prints that
                # line only when `_initialize_cookie_auth` found LOGIN_INFO and a SAPISID cookie
                # at the start of the run. The jar was a session, it was sent, and a *response*
                # took it away (`Set-Cookie: LOGIN_INFO=; Expires=Mon, 25-Dec-2023 …` — read it
                # yourself with `--print-traffic`, on your own machine).
                "recognised_at_start": True,
                "reason": verdict,
            },
        },
    )


def extract(request: ExtractRequest) -> ExtractResult:
    """Resolve ``url`` into entries. Fixture URLs answer from disk in either mode."""
    if is_fixture_url(request.url):
        return fixtures.extract(request.url, flat=request.flat)
    if fixtures_enabled():
        raise ToolboxError(
            ErrorCode.FIXTURE_UNKNOWN,
            f"Fixtures mode refuses to reach the network for '{request.url}'.",
            details={"requested": request.url, "known": sorted(fixtures.KNOWN)},
        )

    parsed = parse_url(request.url)
    if parsed.kind is UrlKind.UNKNOWN:
        raise ToolboxError(
            ErrorCode.YTDLP_UNAVAILABLE,
            f"'{request.url}' is not a YouTube video or playlist URL.",
            status=422,
            details={"requested": request.url},
        )

    errors = ExtractionLog(log=log, verbose=ytdlp_verbose())
    # yt-dlp prints the request headers it sends when it is asked to be verbose, and those
    # carry the session. It is told the values to keep out before it is handed the jar.
    errors.add_secrets(cookie_secrets(request))
    cookies = cookie_shape(request)
    try:
        with cookie_jar(request) as jar:
            info = extract_info(
                request.url,
                build_options(
                    request,
                    skip_download=True,
                    logger=errors,
                    **jar,
                    **listing_options(request.flat),
                ),
                download=False,
            )
    except Exception as exc:
        raise _failure(
            exc,
            errors,
            url=request.url,
            playlist=parsed.kind is UrlKind.PLAYLIST,
            cookies=cookies,
        ) from exc

    result = result_from_info(info, errors=errors)

    # A playlist that answered with nothing but holes is not an empty playlist, and the caller
    # must not be left to tell the two apart. Its own code, rather than reaching the
    # orchestrator as the generic "the URL resolved to no videos".
    if not result.entries and result.unreadable:
        shared = _shared_reason(result.unreadable)
        failure = ToolboxError(
            ErrorCode.PLAYLIST_ENTRY_UNAVAILABLE,
            f"None of the {len(result.unreadable)} entries of this playlist could be read.",
            # The catalog's hint blames "one of the videos inside it", which is right when a few
            # entries are lost and the rest came back, and wrong when *every* entry failed — and
            # wrongest when they all answered one sentence of YouTube's own. The owner of a
            # fifteen-track album is then told about a single dead video while the actual
            # refusal — "The page needs to be reloaded." — points at the session or the player,
            # and the hint sends him looking for the wrong thing.
            hint=_refusal_hint(shared, errors),
            # Nothing came back, so "Import what came back" is not an offer that can be taken.
            action="Retry the listing",
            details={
                "url": request.url,
                "cookies": cookies,
                "unreadable": [gap.model_dump(mode="json") for gap in result.unreadable],
            },
        )
        raise _explained(failure, errors)

    # `warning` when something was lost, so a partial listing is visible in the JSON logs
    # without anyone having to diff two counts.
    emit = log.info if not result.unreadable else log.warning
    emit(
        "extract.ok",
        cookies=cookies,
        kind=result.kind,
        entries=len(result.entries),
        unreadable=len(result.unreadable),
        unavailable=sum(1 for entry in result.entries if entry.unavailable),
        flat=request.flat,
        id=parsed.id,
    )
    return result
