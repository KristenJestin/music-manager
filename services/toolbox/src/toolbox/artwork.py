"""`POST /artwork/prepare` — crop to square, resize, re-encode as JPEG.

Cover Art Archive images arrive in every shape and size, and YouTube thumbnails are 16:9.
`docs/02-lecons-v1.md` keeps v1's "thumbnail cropped to a square" behaviour, so the crop is
centred and the output is always a JPEG the caller can hand straight to `/tag`.

In fixtures mode a URL is never fetched: a deterministic gradient of the requested size is
generated instead, so the offline end-to-end run still produces an embedded cover.
"""

from __future__ import annotations

import base64
import hashlib
import io
from pathlib import Path
from typing import Final, Literal

import httpx2 as httpx
from PIL import Image

from toolbox.config import fixtures_enabled
from toolbox.errors import ErrorCode, ToolboxError
from toolbox.models import ArtworkRequest, ArtworkResult

__all__ = ["prepare"]

_TIMEOUT: Final[float] = 20.0
#: Refuse absurd downloads rather than filling the container's memory.
_MAX_BYTES: Final[int] = 32 * 1024 * 1024


def _fetch(url: str) -> bytes:
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
            response = client.get(url)
            response.raise_for_status()
            data = response.content
    except httpx.HTTPError as exc:
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"Could not fetch artwork: {exc}", status=502, details={"url": url}
        ) from exc
    if len(data) > _MAX_BYTES:
        raise ToolboxError(ErrorCode.UNKNOWN, "Artwork is larger than 32 MiB.", status=413)
    return data


def _generated(url: str, size: int) -> bytes:
    """A deterministic placeholder cover for fixtures mode, seeded by the URL."""
    seed = hashlib.sha256(url.encode("utf-8")).digest()
    top = (seed[0], seed[1], seed[2])
    bottom = (seed[3], seed[4], seed[5])
    image = Image.new("RGB", (size, size))
    for y in range(size):
        ratio = y / max(size - 1, 1)
        row = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        for x in range(size):
            image.putpixel((x, y), row)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=90)
    return buffer.getvalue()


def _square(image: Image.Image) -> Image.Image:
    width, height = image.size
    if width == height:
        return image
    side = min(width, height)
    left = (width - side) // 2
    top = (height - side) // 2
    return image.crop((left, top, left + side, top + side))


def prepare(request: ArtworkRequest) -> ArtworkResult:
    """Produce the JPEG that goes into `METADATA_BLOCK_PICTURE`, `APIC` or `covr`."""
    source: Literal["url", "path", "fixture"]
    if request.path:
        path = Path(request.path)
        if not path.is_file():
            raise ToolboxError(
                ErrorCode.UNKNOWN, f"No such file: {path}", status=404, details={"path": str(path)}
            )
        data = path.read_bytes()
        source = "path"
    elif request.url:
        if fixtures_enabled():
            data = _generated(request.url, request.size)
            source = "fixture"
        else:
            data = _fetch(request.url)
            source = "url"
    else:
        raise ToolboxError(ErrorCode.UNKNOWN, "Pass either `url` or `path`.", status=422)

    try:
        with Image.open(io.BytesIO(data)) as opened:
            image = opened.convert("RGB")
    except OSError as exc:
        raise ToolboxError(
            ErrorCode.UNKNOWN, f"Artwork is not a readable image: {exc}", status=422
        ) from exc

    if request.square:
        image = _square(image)
    if max(image.size) > request.size:
        image.thumbnail((request.size, request.size), Image.Resampling.LANCZOS)

    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=request.quality, optimize=True)
    encoded = buffer.getvalue()
    return ArtworkResult(
        width=image.width,
        height=image.height,
        bytes=len(encoded),
        data_base64=base64.b64encode(encoded).decode("ascii"),
        source=source,
    )
