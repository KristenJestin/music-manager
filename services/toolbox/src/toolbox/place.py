"""`POST /place` — the atomic move into the library.

Navidrome watches the library directory. A half-written file appearing there produces a
broken track in someone's player, so the move is atomic: same filesystem, ``os.replace``,
which either happened or did not. Across filesystems the file is copied to a temporary name
*inside the destination directory* and then replaced into place, which keeps the same
guarantee.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

import structlog

from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import OnExists, PlaceRequest, PlaceResult

__all__ = ["place", "unique_path"]

log: structlog.stdlib.BoundLogger = structlog.get_logger("toolbox.place")

#: Give up rather than spin forever if a thousand copies already exist.
_MAX_ATTEMPTS = 1000


def unique_path(dest: Path) -> Path:
    """`04 Within.opus` → `04 Within (2).opus`, the first name that is free."""
    for attempt in range(2, _MAX_ATTEMPTS + 2):
        candidate = dest.with_name(f"{dest.stem} ({attempt}){dest.suffix}")
        if not candidate.exists():
            return candidate
    raise ToolboxError(
        ErrorCode.PLACE_CONFLICT,
        f"Could not find a free name next to {dest.name}.",
        details={"dest": str(dest)},
    )


def _atomic_move(src: Path, dest: Path) -> None:
    try:
        src.replace(dest)
        return
    except OSError:
        # Different filesystems: copy beside the destination, then replace atomically.
        pass
    handle, temporary = tempfile.mkstemp(dir=str(dest.parent), prefix=".mm-", suffix=dest.suffix)
    os.close(handle)
    staging = Path(temporary)
    try:
        shutil.copy2(src, staging)
        staging.replace(dest)
    except OSError as exc:
        staging.unlink(missing_ok=True)
        raise ToolboxError(
            ErrorCode.UNKNOWN,
            f"Could not place {src.name}: {exc}",
            details={"src": str(src), "dest": str(dest)},
        ) from exc
    src.unlink(missing_ok=True)


def place(request: PlaceRequest) -> PlaceResult:
    """Move ``src`` onto ``dest``, creating the album and artist folders on the way."""
    src = Path(request.src)
    dest = Path(request.dest)
    if not src.is_file():
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"No such file: {src}", status=404, details={"src": str(src)}
        )
    if dest.is_dir():
        raise ToolboxError(
            ErrorCode.PLACE_CONFLICT,
            f"{dest} is a directory.",
            details={"dest": str(dest)},
        )

    dest.parent.mkdir(parents=True, exist_ok=True)

    # Placing a file onto itself is a no-op, not a conflict: `place` has to be idempotent
    # because the pipeline replays steps.
    if dest.exists() and src.resolve() == dest.resolve():
        return PlaceResult(
            path=str(dest), moved=False, on_exists=request.on_exists, size=dest.stat().st_size
        )

    final = dest
    if dest.exists():
        match request.on_exists:
            case None:
                raise ToolboxError(
                    ErrorCode.PLACE_CONFLICT,
                    f"{dest.name} already exists and no conflict policy was given.",
                    details={"dest": str(dest), "size": dest.stat().st_size},
                )
            case OnExists.SKIP:
                log.info("place.skipped", dest=str(dest))
                return PlaceResult(
                    path=str(dest),
                    moved=False,
                    on_exists=OnExists.SKIP,
                    size=dest.stat().st_size,
                )
            case OnExists.KEEP_BOTH:
                final = unique_path(dest)
            case OnExists.OVERWRITE:
                final = dest

    _atomic_move(src, final)
    log.info("place.moved", src=str(src), dest=str(final))
    return PlaceResult(
        path=str(final), moved=True, on_exists=request.on_exists, size=final.stat().st_size
    )
