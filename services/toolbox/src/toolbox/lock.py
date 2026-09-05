"""The process-wide download slot.

`docs/06-stack.md`: *"Concurrence 1 : une seule file `download` ; le toolbox refuse un second
téléchargement simultané."* The orchestrator already serialises downloads with a pg-boss
singleton; this lock is the second line of defence, so that a stray API client cannot make
two yt-dlp instances fight over the same `.part` file.
"""

from __future__ import annotations

import threading

from toolbox.errors import ErrorCode, ToolboxError

__all__ = ["DOWNLOAD_LOCK", "DownloadLock"]


class DownloadLock:
    """A non-blocking mutex that fails loudly instead of queueing."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    @property
    def held(self) -> bool:
        """True while a download owns the slot. Reported by `GET /health`."""
        return self._lock.locked()

    def acquire(self) -> None:
        """Take the slot, or raise :attr:`ErrorCode.LOCKED` straight away.

        Called *before* a streaming response starts so that the refusal is a real ``409``
        with a body, not an error event inside a 200 stream.
        """
        if not self._lock.acquire(blocking=False):
            raise ToolboxError(ErrorCode.LOCKED)

    def release(self) -> None:
        """Give the slot back. Safe to call from the generator's ``finally``."""
        if self._lock.locked():
            self._lock.release()

    def __enter__(self) -> DownloadLock:
        """Scoped form of :meth:`acquire` / :meth:`release`."""
        self.acquire()
        return self

    def __exit__(self, *_: object) -> None:
        self.release()


#: One slot for the whole process.
DOWNLOAD_LOCK = DownloadLock()
