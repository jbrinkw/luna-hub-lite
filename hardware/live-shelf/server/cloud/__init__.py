"""Cloud integration for the Live Shelf Pi (PROD_MIGRATION_PLAN.md).

Pull-per-event architecture: before every scale event the Pi fetches the
user's current products + stock from the cloud, classifies locally, then
POSTs the resolved event back. When the cloud is unreachable the event
is queued in ``cloud_outbox`` and drained by a background worker.

Public surface:
    CloudClient, CloudError  -- thin HTTPS client with x-api-key auth
    Catalog, fetch_catalog   -- GET /catalog parser
    enqueue_event            -- write an event to the SQLite outbox
    CloudWorker              -- background drainer + heartbeat sender
"""

from __future__ import annotations

from .catalog import Catalog, fetch_catalog
from .client import CloudClient, CloudError
from .integration import CloudEventEmitter, null_emitter
from .livetrack_poller import LiveTrackPoller
from .outbox import enqueue_event
from .worker import CloudWorker

__all__ = [
    "Catalog",
    "CloudClient",
    "CloudError",
    "CloudEventEmitter",
    "CloudWorker",
    "LiveTrackPoller",
    "enqueue_event",
    "fetch_catalog",
    "null_emitter",
]
