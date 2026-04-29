"""Single-source-of-truth translation between cloud + Pi shelf-kind literals.

Background
----------
Cloud (`chefbyte.scale_pairings.kind`, ESP firmware, shelf registry) uses
the canonical vocabulary ``{live_shelf, catch_all, live_scale}``. The Pi's
SQLite CHECK constraints (``lots.shelf_id``, ``sessions.shelf_id``,
``scale_pairings.kind``) still use the legacy literal ``single_item`` for
the live-scale kind. Migrating the SQLite schema would require a coordinated
upgrade on every deployed Pi DB; until then we translate at every boundary.

Audit context
-------------
Phase 1 audit finding L10/HIGH (`AUDIT_FINDINGS_PHASE1.md`): "live_scale ↔
single_item literal collision relies on lossy translation table at every
boundary". Translation logic was duplicated in three places:

  1. ``cloud/pairings_sync_poller.py`` cloud→Pi map for incoming pairings.
  2. ``cloud/weight_sync_poller.py`` Pi→cloud map when emitting live_weight_sync.
  3. ``handlers/scale_events.py:3285`` ingress translation on event POST.

Any new code reading either side must remember to translate or drift silently.
This module centralises both directions; callers import the helpers and the
mapping itself.

Invariants
----------
* `cloud_to_pi(c) → p` and `pi_to_cloud(p) → c` are bijective for the three
  pairs ``{live_shelf, catch_all, live_scale<->single_item}``.
* Unknown kinds round-trip unchanged (so a future fourth kind only requires a
  single edit here, and the existing call sites continue to behave sanely).
* The pgTAP test ``supabase/tests/invariants/kind_translation_table.test.sql``
  pins the cloud-side authoritative literal set; the unit test next door pins
  the Pi-side set.
"""

from __future__ import annotations

from typing import Final, Mapping

# Cloud-side authoritative literals — match the CHECK constraint on
# ``chefbyte.scale_pairings.kind`` (cloud).
CLOUD_LIVE_SHELF: Final[str] = "live_shelf"
CLOUD_CATCH_ALL: Final[str] = "catch_all"
CLOUD_LIVE_SCALE: Final[str] = "live_scale"

# Pi-side legacy literals — match the SQLite CHECK constraint on
# ``lots.shelf_id`` / ``sessions.shelf_id`` / ``scale_pairings.kind``.
PI_LIVE_SHELF: Final[str] = "live_shelf"
PI_CATCH_ALL: Final[str] = "catch_all"
PI_SINGLE_ITEM: Final[str] = "single_item"

# Cloud → Pi mapping.
CLOUD_TO_PI: Final[Mapping[str, str]] = {
    CLOUD_LIVE_SHELF: PI_LIVE_SHELF,
    CLOUD_CATCH_ALL: PI_CATCH_ALL,
    CLOUD_LIVE_SCALE: PI_SINGLE_ITEM,
}

# Pi → Cloud mapping (inverse of CLOUD_TO_PI).
PI_TO_CLOUD: Final[Mapping[str, str]] = {
    PI_LIVE_SHELF: CLOUD_LIVE_SHELF,
    PI_CATCH_ALL: CLOUD_CATCH_ALL,
    PI_SINGLE_ITEM: CLOUD_LIVE_SCALE,
}


def cloud_to_pi(kind: str) -> str:
    """Translate a cloud-vocabulary kind to the Pi's SQLite literal.

    Unknown values pass through unchanged so downstream CHECK constraints
    surface the error rather than silently rewriting the value.
    """

    return CLOUD_TO_PI.get(kind, kind)


def pi_to_cloud(kind: str) -> str:
    """Translate a Pi-vocabulary kind to the cloud's canonical literal.

    Unknown values pass through unchanged (see :func:`cloud_to_pi`).
    """

    return PI_TO_CLOUD.get(kind, kind)


__all__ = [
    "CLOUD_CATCH_ALL",
    "CLOUD_LIVE_SCALE",
    "CLOUD_LIVE_SHELF",
    "CLOUD_TO_PI",
    "PI_CATCH_ALL",
    "PI_LIVE_SHELF",
    "PI_SINGLE_ITEM",
    "PI_TO_CLOUD",
    "cloud_to_pi",
    "pi_to_cloud",
]
