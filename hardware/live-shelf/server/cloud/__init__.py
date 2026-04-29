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
from .event_overrides_poller import EventOverridesPoller
from .integration import CloudEventEmitter, null_emitter
from .livetrack_poller import LiveTrackPoller
from .lot_snapshot_poller import LotSnapshotPoller
from .outbox import enqueue_event
from .pairings_sync_poller import PairingsSyncPoller
from .product_sync_poller import ProductSyncPoller
from .settings_cache import (
    ClassifierSettings,
    ClassifierSettingsCache,
    get_global_cache as get_classifier_settings_cache,
)
from .worker import CloudWorker

__all__ = [
    "Catalog",
    "ClassifierSettings",
    "ClassifierSettingsCache",
    "CloudClient",
    "CloudError",
    "CloudEventEmitter",
    "CloudWorker",
    "EventOverridesPoller",
    "LiveTrackPoller",
    "LotSnapshotPoller",
    "PairingsSyncPoller",
    "ProductSyncPoller",
    "enqueue_event",
    "fetch_catalog",
    "get_classifier_settings_cache",
    "null_emitter",
]
