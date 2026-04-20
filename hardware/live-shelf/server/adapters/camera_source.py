"""`CameraSource` (intake) protocol → Bundle C camera daemon adapter.

The intake blueprint needs a `.current_frame_jpeg() -> bytes` callable.
:class:`CameraDaemon` already exposes that method, but tests (and future
refactors) benefit from a thin layer so the daemon isn't passed around
as a protocol instance.
"""

from __future__ import annotations

from ..camera.daemon import CameraDaemon
from ..camera.extract import FrameNotAvailableError


class CameraDaemonSource:
    """Wraps :class:`CameraDaemon` to satisfy :class:`intake.CameraSource`.

    Raises :class:`FrameNotAvailableError` if the ring buffer is empty,
    so intake can surface a 503 with a helpful message rather than a
    generic 500.
    """

    def __init__(self, daemon: CameraDaemon) -> None:
        self._daemon = daemon

    def current_frame_jpeg(self) -> bytes:
        buf = self._daemon.current_frame_jpeg()
        if buf is None:
            raise FrameNotAvailableError("now", None)
        return buf


__all__ = ["CameraDaemonSource"]
