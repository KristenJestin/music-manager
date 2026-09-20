"""`/ytdlp/update`, `/ytdlp/selftest`, `/cookies/test` — keeping the downloader alive.

`docs/02-lecons-v1.md` lists "breaks at every YouTube change" as the first v1 pain, with the
answer: auto-update and a self-test. These three endpoints are that answer, and they return
structured results so the Inbox can raise `ytdlp_update` and `cookies_expiring` items
without anyone reading a log.
"""

from __future__ import annotations

import datetime as dt
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Final

import structlog

from toolbox.config import fixtures_enabled
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import (
    CookiesTestRequest,
    CookiesTestResult,
    SelfTestCheck,
    SelfTestRequest,
    SelfTestResult,
    UpdateResult,
    YtdlpOptions,
)
from toolbox.versions import ffmpeg_version, fpcalc_version, rsgain_version
from toolbox.ytdlp import build_options, extract_info, yt_dlp_version

__all__ = ["cookies_test", "parse_cookies", "selftest", "update_ytdlp"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.maintenance")

_UPDATE_TIMEOUT: Final[float] = 300.0

#: Cookies that prove a logged-in YouTube session. Any one of them is enough.
# What yt-dlp **itself** counts as a signed-in session, taken from its own extractor
# (`yt_dlp/extractor/youtube/_base.py`, `_has_auth_cookies`):
#
#     has_login_info = 'LOGIN_INFO' in self._youtube_cookies
#     return bool(has_login_info and (yt_sapisid or yt_1psapisid or yt_3psapisid))
#
# Both halves are needed, and the first is the one a jar loses first: `LOGIN_INFO`, and all three
# SAPISID variants, are **httpOnly**, so an exporter that skips httpOnly drops exactly the
# cookies that make the jar a session — and yt-dlp then says, after every request, "The provided
# YouTube account cookies are no longer valid. They have likely been rotated in the browser as a
# security measure." That sentence reads as rotation while the jar never carried them at all.
# Reading the verdict off yt-dlp's own rule is the point: this toolbox and the tool that does the
# work must not disagree about what "signed in" means.
_LOGIN_INFO: Final[str] = "LOGIN_INFO"
_SAPISID_COOKIES: Final[frozenset[str]] = frozenset(
    {"SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"}
)


def _covers_youtube(domain: str) -> bool:
    """Would yt-dlp send a cookie with this domain to ``youtube.com``?

    A cookie is sent to the host it was set for and to its subdomains, so `youtube.com`,
    `.youtube.com` and `www.youtube.com` all reach it — and `.google.com` does not, however
    healthy the session behind it is. The check used to be absent, so a jar exported from the
    Google side alone was reported as *a usable session* and then failed every extraction with
    `Sign in to confirm you're not a bot`, which reads as a YouTube problem rather than as the
    jar that never reached YouTube.
    """
    host = domain.strip().lower().removeprefix(".")
    return host == "youtube.com" or host.endswith(".youtube.com")


#: A short, stable, public video used by the optional networked self-test.
DEFAULT_SELFTEST_URL: Final[str] = "https://www.youtube.com/watch?v=BaW_jenozKc"


def _installed_version() -> str | None:
    return yt_dlp_version()


def update_ytdlp() -> UpdateResult:
    """Upgrade yt-dlp in place, preferring `uv` and falling back to `pip`.

    Fixtures mode never touches the network, so it reports "no change" and says why.
    """
    previous = _installed_version()
    if fixtures_enabled():
        return UpdateResult(
            ok=True,
            changed=False,
            previous=previous,
            current=previous,
            method="skipped",
            output="fixtures mode: yt-dlp is never updated",
        )

    uv = shutil.which("uv")
    if uv is not None:
        command = [uv, "pip", "install", "--upgrade", "--python", sys.executable, "yt-dlp"]
        method: str = "uv"
    else:
        command = [sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"]
        method = "pip"

    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=_UPDATE_TIMEOUT, check=False
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"Could not run the updater: {exc}", status=500
        ) from exc

    output = f"{completed.stdout}\n{completed.stderr}".strip()
    if completed.returncode != 0:
        log.warning("ytdlp.update.failed", returncode=completed.returncode)
        return UpdateResult(
            ok=False,
            changed=False,
            previous=previous,
            current=previous,
            method="uv" if method == "uv" else "pip",
            output=output[-4000:],
        )

    # The running process still holds the old module; report what is now on disk.
    current = _version_on_disk() or previous
    log.info("ytdlp.update", previous=previous, current=current, method=method)
    return UpdateResult(
        ok=True,
        changed=current != previous,
        previous=previous,
        current=current,
        method="uv" if method == "uv" else "pip",
        output=output[-4000:],
    )


def _version_on_disk() -> str | None:
    """Read the freshly installed yt-dlp version from a child process, not from memory."""
    try:
        completed = subprocess.run(
            [sys.executable, "-c", "import yt_dlp.version as v; print(v.__version__)"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):  # pragma: no cover
        return None
    value = completed.stdout.strip()
    return value or None


def selftest(request: SelfTestRequest) -> SelfTestResult:
    """Prove the downloader is usable: module, binaries, and optionally a real extraction."""
    version = _installed_version()
    checks: list[SelfTestCheck] = [
        SelfTestCheck(name="yt-dlp", ok=version is not None, detail=version or "not importable")
    ]
    for name, probe in (
        ("ffmpeg", ffmpeg_version),
        ("fpcalc", fpcalc_version),
        ("rsgain", rsgain_version),
    ):
        found = probe()
        checks.append(SelfTestCheck(name=name, ok=found is not None, detail=found or "missing"))

    if request.network and not fixtures_enabled():
        url = request.url or DEFAULT_SELFTEST_URL
        try:
            info = extract_info(url, build_options(YtdlpOptions()), download=False)
            title = str(info.get("title") or "")
            checks.append(SelfTestCheck(name="extract", ok=bool(title), detail=title))
        except Exception as exc:
            from toolbox.errors import classify_ytdlp_error

            error = classify_ytdlp_error(exc, url=url)
            checks.append(
                SelfTestCheck(name="extract", ok=False, detail=f"{error.code}: {error.message}")
            )
    else:
        checks.append(
            SelfTestCheck(name="extract", ok=True, detail="skipped (no network requested)")
        )

    return SelfTestResult(ok=all(check.ok for check in checks), version=version, checks=checks)


def parse_cookies(text: str) -> tuple[list[tuple[str, str, int]], list[str]]:
    """Parse a Netscape `cookies.txt` into ``(domain, name, expiry)`` triples.

    Returns the cookies it understood and the problems it found, because a cookie file that
    is half-broken is exactly the case worth reporting.
    """
    cookies: list[tuple[str, str, int]] = []
    problems: list[str] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line or (line.startswith("#") and not line.startswith("#HttpOnly_")):
            continue
        fields = line.removeprefix("#HttpOnly_").split("\t")
        if len(fields) < 7:
            problems.append(f"line {number}: expected 7 tab-separated fields, got {len(fields)}")
            continue
        domain, _, _, _, expiry, name, _ = fields[:7]
        try:
            expires = int(float(expiry))
        except ValueError:
            problems.append(f"line {number}: '{expiry}' is not an expiry timestamp")
            continue
        cookies.append((domain.strip(), name.strip(), expires))
    return cookies, problems


def cookies_test(request: CookiesTestRequest) -> CookiesTestResult:
    """Check a cookie jar offline: is it parseable, is it a session, when does it lapse?"""
    if request.content is not None:
        text = request.content
    elif request.path:
        path = Path(request.path)
        if not path.is_file():
            raise ToolboxError(
                ErrorCode.UNKNOWN, f"No such file: {path}", status=404, details={"path": str(path)}
            )
        text = path.read_text(encoding="utf-8", errors="replace")
    else:
        raise ToolboxError(ErrorCode.UNKNOWN, "Pass either `path` or `content`.", status=422)

    cookies, problems = parse_cookies(text)
    now = int(dt.datetime.now(tz=dt.UTC).timestamp())
    # Session cookies carry expiry 0; they are valid but have no lapse date.
    expiries = [expiry for _, _, expiry in cookies if expiry > 0]
    expired = sum(1 for expiry in expiries if expiry <= now)
    upcoming = [expiry for expiry in expiries if expiry > now]
    has_login_info = any(name == _LOGIN_INFO for _, name, _ in cookies)
    has_sapisid = any(name in _SAPISID_COOKIES for _, name, _ in cookies)
    authenticated = has_login_info and has_sapisid

    # Two things were wrong with the verdict, both of them read off real jars.
    #
    # `ok` used to require `expired == 0` — *no* expired cookie of any kind. A jar carries two
    # dozen cookies and most of them have nothing to do with being logged in: `PREF`, `SOCS` and
    # `VISITOR_INFO1_LIVE` lapse on their own schedule and their expiry says nothing about the
    # session. A jar with 25 cookies, a live `SAPISID` and three lapsed preference cookies was
    # therefore called "not a usable session", and the owner was sent to export a new one for no
    # reason. The expiry that matters is a **session cookie's**: it is the one whose lapse ends
    # the login, and it is the only one that fails the jar now.
    #
    # And the reason was never stated. `problems` only ever received "no cookies found" and "no
    # session cookie present", so `ok == False` could come back with an empty list: the message
    # gave the counts and no cause, which is exactly the "muet en ligne de commande" of the
    # backlog. Every way `ok` can be false now leaves a sentence naming it.
    lapsed_session = sorted(
        {name for _, name, expiry in cookies if 0 < expiry <= now and name in _SAPISID_COOKIES}
    )
    youtube_domains = [domain for domain, _, _ in cookies if _covers_youtube(domain)]

    if not cookies:
        problems.append("no cookies found")
    if not authenticated:
        # Name the half that is missing. "no session cookie" covered three different jars, and
        # the owner of a jar refused for the wrong one cannot tell which export to redo.
        # `LOGIN_INFO` first: it is the half an httpOnly-skipping exporter drops without leaving
        # a trace, and its absence is what yt-dlp reports as cookies "rotated in the browser".
        if not has_login_info and not has_sapisid:
            problems.append(
                "not a YouTube session: neither LOGIN_INFO nor a SAPISID cookie "
                "(SAPISID / __Secure-1PAPISID / __Secure-3PAPISID) is here"
            )
        elif not has_login_info:
            problems.append(
                "not a YouTube session: LOGIN_INFO is missing, and yt-dlp requires it beside a "
                "SAPISID cookie — it is httpOnly, so an export that skips them leaves it out"
            )
        else:
            problems.append(
                "not a YouTube session: no SAPISID cookie (SAPISID / __Secure-1PAPISID / "
                "__Secure-3PAPISID) — all three are httpOnly, so an export that skips them "
                "leaves them out"
            )
    if lapsed_session:
        problems.append(
            f"the session cookie {'/'.join(lapsed_session)} has expired: export a fresh jar"
        )
    if cookies and not youtube_domains:
        problems.append(
            "no cookie for youtube.com (the jar covers "
            f"{', '.join(sorted({domain for domain, _, _ in cookies}))}), and yt-dlp sends a "
            "cookie only to a domain it matches"
        )

    return CookiesTestResult(
        ok=bool(cookies) and authenticated and not lapsed_session and bool(youtube_domains),
        cookies=len(cookies),
        domains=sorted({domain for domain, _, _ in cookies}),
        authenticated=authenticated,
        expires_at=(
            dt.datetime.fromtimestamp(min(upcoming), tz=dt.UTC).isoformat() if upcoming else None
        ),
        expired=expired,
        problems=problems,
    )
