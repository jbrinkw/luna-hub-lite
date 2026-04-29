"""Pin the cloud↔Pi kind translation table introduced for Phase 1 audit
finding L10/HIGH (``AUDIT_FINDINGS_PHASE1.md``).

The mapping has three pairs and a contract:

  cloud           ↔ pi
  ------------------------
  live_shelf      ↔ live_shelf
  catch_all       ↔ catch_all
  live_scale      ↔ single_item

  unknown_kind    → unknown_kind  (round-trips unchanged so an unsupported
                                   value surfaces at the next CHECK
                                   constraint, not silently rewritten)

Three call sites import this helper:
  * ``cloud/pairings_sync_poller.py`` cloud→Pi map for incoming pairings.
  * ``cloud/weight_sync_poller.py`` Pi→cloud map when emitting live_weight_sync.
  * ``handlers/scale_events.py`` ingress translation on POST /scale-event.

Any new place that needs translation MUST import these helpers — do not
inline the mapping.
"""

from __future__ import annotations

import pytest

from server.cloud._kind_translate import (
    CLOUD_CATCH_ALL,
    CLOUD_LIVE_SCALE,
    CLOUD_LIVE_SHELF,
    CLOUD_TO_PI,
    PI_CATCH_ALL,
    PI_LIVE_SHELF,
    PI_SINGLE_ITEM,
    PI_TO_CLOUD,
    cloud_to_pi,
    pi_to_cloud,
)


# ─────────────────────────────────────────────────────────────────
# Bijection — the three known pairs round-trip in both directions.
# ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "cloud,pi",
    [
        (CLOUD_LIVE_SHELF, PI_LIVE_SHELF),
        (CLOUD_CATCH_ALL, PI_CATCH_ALL),
        (CLOUD_LIVE_SCALE, PI_SINGLE_ITEM),
    ],
)
def test_round_trip_cloud_to_pi_to_cloud(cloud: str, pi: str) -> None:
    assert cloud_to_pi(cloud) == pi
    assert pi_to_cloud(pi) == cloud
    # And the bijection through the helper composition.
    assert pi_to_cloud(cloud_to_pi(cloud)) == cloud
    assert cloud_to_pi(pi_to_cloud(pi)) == pi


def test_cloud_to_pi_collision_pin() -> None:
    """The exact collision the audit finding called out — cloud
    ``live_scale`` MUST NOT pass through unchanged on the Pi side.
    A regression here means the SQLite CHECK constraint will reject
    the row at insert time.
    """

    assert cloud_to_pi("live_scale") == "single_item"
    assert cloud_to_pi("live_scale") != "live_scale"


def test_pi_to_cloud_collision_pin() -> None:
    """Inverse of the collision — Pi ``single_item`` MUST translate to
    cloud ``live_scale``. A regression that emits the raw Pi literal
    upstream trips the cloud's CHECK constraint at INSERT time.
    """

    assert pi_to_cloud("single_item") == "live_scale"
    assert pi_to_cloud("single_item") != "single_item"


# ─────────────────────────────────────────────────────────────────
# Unknown values pass through unchanged.
# ─────────────────────────────────────────────────────────────────


def test_unknown_kind_round_trips_unchanged_cloud_to_pi() -> None:
    assert cloud_to_pi("mystery_kind") == "mystery_kind"
    assert cloud_to_pi("") == ""


def test_unknown_kind_round_trips_unchanged_pi_to_cloud() -> None:
    assert pi_to_cloud("mystery_kind") == "mystery_kind"
    assert pi_to_cloud("") == ""


# ─────────────────────────────────────────────────────────────────
# Mapping table shape — pin the size + entries explicitly so a
# silent drop of a row trips this test.
# ─────────────────────────────────────────────────────────────────


def test_cloud_to_pi_table_shape() -> None:
    assert dict(CLOUD_TO_PI) == {
        "live_shelf": "live_shelf",
        "catch_all": "catch_all",
        "live_scale": "single_item",
    }


def test_pi_to_cloud_is_inverse_of_cloud_to_pi() -> None:
    """The two tables must be exact inverses. A drift in either
    direction fails this test rather than going silent at runtime.
    """

    derived = {pi: cloud for cloud, pi in CLOUD_TO_PI.items()}
    assert dict(PI_TO_CLOUD) == derived


# ─────────────────────────────────────────────────────────────────
# Importable from the package's public surface so call sites can
# rely on `from cloud import cloud_to_pi_kind` style imports.
# ─────────────────────────────────────────────────────────────────


def test_helpers_exported_from_cloud_package() -> None:
    from server import cloud as cloud_pkg

    assert hasattr(cloud_pkg, "cloud_to_pi_kind")
    assert hasattr(cloud_pkg, "pi_to_cloud_kind")
    assert cloud_pkg.cloud_to_pi_kind("live_scale") == "single_item"
    assert cloud_pkg.pi_to_cloud_kind("single_item") == "live_scale"
