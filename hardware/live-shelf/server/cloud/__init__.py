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

from ._kind_translate import (
    CLOUD_CATCH_ALL,
    CLOUD_LIVE_SCALE,
    CLOUD_LIVE_SHELF,
    PI_CATCH_ALL,
    PI_LIVE_SHELF,
    PI_SINGLE_ITEM,
    cloud_to_pi as cloud_to_pi_kind,
    pi_to_cloud as pi_to_cloud_kind,
)
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
from .weight_sync_poller import WeightSyncPoller
from .worker import CloudWorker

__all__ = [
    "CLOUD_CATCH_ALL",
    "CLOUD_LIVE_SCALE",
    "CLOUD_LIVE_SHELF",
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
    "PI_CATCH_ALL",
    "PI_LIVE_SHELF",
    "PI_SINGLE_ITEM",
    "PairingsSyncPoller",
    "ProductSyncPoller",
    "WeightSyncPoller",
    "cloud_to_pi_kind",
    "enqueue_event",
    "fetch_catalog",
    "get_classifier_settings_cache",
    "null_emitter",
    "pi_to_cloud_kind",
]
