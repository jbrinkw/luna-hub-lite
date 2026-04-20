"""`IntakeRepo` protocol → Bundle A repo adapter.

Bundle F expects three writes plus storage models. The adapter holds a
long-lived ``sqlite3.Connection`` and forwards to :mod:`storage.repo`.

The intake blueprint is called from Flask request threads — same
connection is shared with the scale-event handler, brightness handler,
sweeper thread, and session-capture callback. Without a shared lock
concurrent writes to a single sqlite3.Connection cause
``sqlite3.InterfaceError: bad parameter or other API misuse`` under
load. Every repo call is wrapped in ``self._db_lock`` so the intake
path serializes correctly against other writers.
"""

from __future__ import annotations

import sqlite3
import threading
from typing import Any, Optional

from ..storage import repo as storage_repo
from ..storage.models import (
    Lot,
    LotIn,
    Product,
    ProductIn,
    ProductReferenceImage,
    ProductReferenceImageIn,
)
from ..tools.locks import NullLock as _NullLock


class RepoIntakeFacade:
    """Concrete :class:`intake.IntakeRepo` implementation."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        db_lock: Optional[threading.Lock] = None,
    ) -> None:
        self._conn = conn
        self._db_lock: Any = db_lock if db_lock is not None else _NullLock()

    def create_product(self, data: ProductIn) -> Product:
        with self._db_lock:
            return storage_repo.create_product(self._conn, data)

    def create_product_reference_image(
        self, data: ProductReferenceImageIn
    ) -> ProductReferenceImage:
        with self._db_lock:
            return storage_repo.add_reference_image(self._conn, data)

    def create_lot(self, data: LotIn) -> Lot:
        with self._db_lock:
            return storage_repo.create_lot(self._conn, data)


__all__ = ["RepoIntakeFacade"]
