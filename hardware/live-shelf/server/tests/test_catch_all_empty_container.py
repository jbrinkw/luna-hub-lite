"""Empty-container detection on the catch-all scale (2026-04-27).

When the user places a product on the catch-all (scale-02) and its
weight is within 5% of one container's full mass (``tare + net``) of
the product's tare alone, the apply path treats it as the user
"logging the empty container out of inventory":

  * Local lot row is DELETEd.
  * Cloud emit fires ``discarded`` (zero qty, clear in_flight, NO
    food_logs row — consumption was already logged earlier when the
    user actually drank from the bottle, e.g. via live_scale weight
    changes during the session).

Mutation-verification: changing the production constant ``0.05`` to
``0.5`` in :func:`ScaleHandler._maybe_emit_empty_container_discard`
makes the boundary tests fail (the wider window mis-fires on the
"placed = tare + 100g" case which used to fall through). See
``test_mutation_evidence_05_to_5`` for the explicit guard.
"""

from __future__ import annotations

import json
import sqlite3
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402
from server.storage import repo as storage_repo  # noqa: E402
from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class _NullCandidateSource:
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _make_handler(
    conn: sqlite3.Connection, tmp_path: Path, **kwargs
) -> ScaleHandler:
    events_root = tmp_path / "events"
    events_root.mkdir(exist_ok=True)
    defaults = dict(
        conn=conn,
        db_lock=threading.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        cloud_emitter=CloudEventEmitter(conn, enabled=True),
    )
    defaults.update(kwargs)
    return ScaleHandler(**defaults)


_BC = [0]


def _seed_product_and_lot(
    conn: sqlite3.Connection,
    *,
    tare_weight_g,
    net_weight_g,
    shelf_id: str = "catch_all",
    lot_status: str = "in_flight",
    pickup_weight_g=None,
):
    """Seed a single product + lot pair for the catch-all empty-container path.

    The lot defaults to ``in_flight`` status with the FULL container weight
    as the pickup_weight_g — that mirrors the production scenario: user
    grabbed the full bottle off the live-shelf, drank it down to ~empty,
    then placed it on the catch-all.
    """
    _BC[0] += 1
    product = storage_repo.create_product(
        conn,
        ProductIn(
            barcode=f"EMPTY-{_BC[0]}",
            name=f"Gatorade {_BC[0]}",
            net_weight_g=float(net_weight_g) if net_weight_g is not None else None,
            gross_weight_g=(
                float(tare_weight_g) + float(net_weight_g)
                if tare_weight_g is not None and net_weight_g is not None
                else None
            ),
            tare_weight_g=(
                float(tare_weight_g) if tare_weight_g is not None else None
            ),
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    pickup = pickup_weight_g
    if pickup is None and tare_weight_g is not None and net_weight_g is not None:
        pickup = float(tare_weight_g) + float(net_weight_g)
    lot = storage_repo.create_lot(
        conn,
        LotIn(
            product_id=product.product_id,
            status=lot_status,
            current_weight_g=(
                float(tare_weight_g) + float(net_weight_g)
                if tare_weight_g is not None and net_weight_g is not None
                else 0.0
            ),
            initial_weight_g=(
                float(tare_weight_g) + float(net_weight_g)
                if tare_weight_g is not None and net_weight_g is not None
                else 0.0
            ),
            pickup_weight_g=pickup,
            in_flight_since=(
                "2026-04-27T12:00:00.000Z" if lot_status == "in_flight" else None
            ),
            shelf_id=shelf_id,
        ),
    )
    return product, lot


def _open_session(conn, shelf_id="catch_all"):
    return storage_repo.open_session(
        conn, "2026-04-27T12:05:00.000Z", initial_weight_g=0.0,
        shelf_id=shelf_id,
    ).session_id


def _record_add(conn, session_id, *, delta_g, ts="2026-04-27T12:05:01.000Z"):
    ev = storage_repo.record_scale_event(
        conn,
        ScaleEventIn(
            ts=ts, delta_g=delta_g,
            before_weight_g=0.0, after_weight_g=delta_g,
            direction="add", session_id=session_id,
            classifier_status="pending",
            shelf_id="catch_all",
        ),
    )
    return ev.event_id


def _classification(item_id):
    return {
        "item_id": item_id,
        "action": "added",
        "confidence": 0.95,
        "multi_match": [],
        "candidate_pool_used": [{"candidate_id": item_id}],
    }


def _outbox_kinds(conn):
    return [
        json.loads(row[0]).get("event_kind")
        for row in conn.execute(
            "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id ASC"
        )
    ]


def _outbox_payloads(conn):
    return [
        json.loads(row[0])
        for row in conn.execute(
            "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id ASC"
        )
    ]


# ---------------------------------------------------------------------------
# Boundary tests for the 5% window
# ---------------------------------------------------------------------------


class TestEmptyContainerWindow:
    """Each test runs a catch-all ADD against a 25g-tare / 575g-net product
    (full = 600g, ±5% window = ±30g around the tare). Asserts the apply
    path either emits ``discarded`` (and deletes the lot locally) or
    falls through to the in_flight return branch (no discarded emit, lot
    flips to on_shelf with the placed weight)."""

    TARE = 25.0
    NET = 575.0  # full container = 600g; window = ±30g around 25g

    def test_placed_at_tare_emits_discarded(self, tmp_path):
        """placed_weight_g = tare exactly → empty → ``discarded``."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        product, lot = _seed_product_and_lot(
            conn, tare_weight_g=self.TARE, net_weight_g=self.NET,
        )
        session_id = _open_session(conn)
        event_id = _record_add(conn, session_id, delta_g=self.TARE)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:01.000Z",
            delta_g=self.TARE,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        # Local lot deleted.
        assert storage_repo.get_lot(conn, lot.lot_id) is None, (
            "empty-container hit must DELETE the local lot row "
            "(matches manual_discard semantics)"
        )

        # Outbox: exactly one discarded event for this product.
        kinds = _outbox_kinds(conn)
        assert kinds == ["discarded"], (
            f"expected outbox=['discarded'] for empty-container hit; got {kinds!r}"
        )
        payload = _outbox_payloads(conn)[0]
        assert payload["event_kind"] == "discarded"
        assert payload["product_id"] == product.product_id
        assert payload["kind"] == "catch_all", (
            "kind must be 'catch_all' for catch-all-shelf discards "
            "(not 'live_shelf')"
        )
        assert payload["scale_id"] == "scale-02"
        assert payload["pi_event_id"] == event_id, (
            "pi_event_id must be the catch-all event_id so the cloud "
            "event viewer can cross-ref"
        )
        assert float(payload["delta_g"]) == 0.0, (
            "discarded delta_g is informational (cloud zeros qty regardless); "
            "stamp 0.0"
        )

    def test_placed_at_tare_plus_10g_within_window_emits_discarded(self, tmp_path):
        """placed = tare + 10g (within 30g window) → empty → ``discarded``."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=self.TARE, net_weight_g=self.NET,
        )
        session_id = _open_session(conn)
        placed = self.TARE + 10.0  # 35g, well within ±30g of 25g
        event_id = _record_add(conn, session_id, delta_g=placed)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:02.000Z",
            delta_g=placed,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        assert storage_repo.get_lot(conn, lot.lot_id) is None
        assert _outbox_kinds(conn) == ["discarded"]

    def test_placed_at_tare_plus_100g_outside_window_falls_through(self, tmp_path):
        """placed = tare + 100g (= 125g, outside ±30g) → fall through to
        normal in_flight return branch. No ``discarded`` emit, lot flips
        back to on_shelf."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=self.TARE, net_weight_g=self.NET,
        )
        session_id = _open_session(conn)
        placed = self.TARE + 100.0  # 125g — far outside ±30g window
        event_id = _record_add(conn, session_id, delta_g=placed)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:03.000Z",
            delta_g=placed,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        # Local lot still exists — empty-container path did NOT fire.
        lot_now = storage_repo.get_lot(conn, lot.lot_id)
        assert lot_now is not None, (
            "outside-window placement must NOT delete the lot — empty-"
            "container check fired wrongly"
        )

        # No discarded event in the outbox. The in_flight return path
        # may emit other event kinds (consumed / in_flight_return marker)
        # — we only assert ``discarded`` did not leak through.
        kinds = _outbox_kinds(conn)
        assert "discarded" not in kinds, (
            f"placed={placed}g is outside the ±5% empty-window; "
            f"discarded must NOT be emitted. Outbox kinds: {kinds!r}"
        )

    def test_placed_at_full_container_falls_through(self, tmp_path):
        """placed = 600g (full bottle, |placed - tare| = 575g, way outside
        ±30g) → fall through, no ``discarded`` emit. This is the canonical
        "user put a fresh full bottle back on catch-all" case."""
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=self.TARE, net_weight_g=self.NET,
        )
        session_id = _open_session(conn)
        placed = self.TARE + self.NET  # 600g
        event_id = _record_add(conn, session_id, delta_g=placed)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:04.000Z",
            delta_g=placed,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        assert storage_repo.get_lot(conn, lot.lot_id) is not None
        assert "discarded" not in _outbox_kinds(conn), (
            "full container placement must NOT trigger discarded event"
        )


# ---------------------------------------------------------------------------
# Defensive: missing tare or net falls through
# ---------------------------------------------------------------------------


class TestMissingTareOrNet:
    """Defensive guards around missing product geometry.

    * ``net_weight_g IS NULL`` always falls through — there's no
      reference for either the tare-set ≈tare path or the null-tare
      <30% path.
    * ``tare_weight_g IS NULL`` is now a valid input to the
      catch-all-livetrack auto-import branch (2026-05-02): when a
      placement reads under 30% of net, treat as an empty container and
      capture tare from the reading. So this class only asserts the
      "not low enough" half — when the reading is above 30% of net we
      MUST NOT fire (defends against false-positive empty-detection on
      partial placements like a half-full bottle returned to the
      catch-all)."""

    def test_missing_tare_with_partial_reading_falls_through(self, tmp_path):
        """Null tare + placed weight > 30% of net → DON'T fire.

        With ``net_weight_g=575g`` the empty-threshold is 172.5g. A 300g
        placement (≈52% of net — a partially full container) is above
        the threshold, so the null-tare auto-import branch must NOT
        treat this as empty. The lot stays put; no discarded emit fires.
        """
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=None, net_weight_g=575.0,
            pickup_weight_g=600.0,
        )
        session_id = _open_session(conn)
        # 300g > 172.5g (30% of 575g) — partial fill, NOT empty.
        event_id = _record_add(conn, session_id, delta_g=300.0)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:05.000Z",
            delta_g=300.0,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        assert storage_repo.get_lot(conn, lot.lot_id) is not None, (
            "null tare + partial-fill reading must NOT trigger discarded — "
            "the 30% threshold protects against false-positive empty-"
            "detection on half-full placements"
        )
        assert "discarded" not in _outbox_kinds(conn)

    def test_missing_net_falls_through(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=25.0, net_weight_g=None,
            pickup_weight_g=600.0,
        )
        session_id = _open_session(conn)
        event_id = _record_add(conn, session_id, delta_g=25.0)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:06.000Z",
            delta_g=25.0,
            session_id=session_id,
            event_id=event_id,
            shelf_id="catch_all",
        )

        assert storage_repo.get_lot(conn, lot.lot_id) is not None
        assert "discarded" not in _outbox_kinds(conn)


# ---------------------------------------------------------------------------
# Live-shelf scope guard — empty-container is catch-all only
# ---------------------------------------------------------------------------


class TestScopedToCatchAll:
    """Same weight pattern on a live_shelf event must NOT trigger the
    empty-container branch — the rule only applies when the user
    explicitly drops the empty on the catch-all scale."""

    def test_live_shelf_at_tare_does_not_trigger(self, tmp_path):
        conn = init_db(":memory:")
        handler = _make_handler(conn, tmp_path)
        _, lot = _seed_product_and_lot(
            conn, tare_weight_g=25.0, net_weight_g=575.0,
            shelf_id="live_shelf",
        )
        session_id = _open_session(conn, shelf_id="live_shelf")
        event_id = _record_add(conn, session_id, delta_g=25.0)

        handler._apply_lot_update_from_classification(
            direction="add",
            classification=_classification(lot.lot_id),
            event_ts="2026-04-27T12:05:07.000Z",
            delta_g=25.0,
            session_id=session_id,
            event_id=event_id,
            shelf_id="live_shelf",
        )

        # No discarded for a live_shelf event regardless of weight.
        assert "discarded" not in _outbox_kinds(conn), (
            "empty-container branch is catch-all only; live_shelf events "
            "must always fall through"
        )


# ---------------------------------------------------------------------------
# Mutation-verification helper
# ---------------------------------------------------------------------------


def test_mutation_evidence_05_to_5(tmp_path):
    """Wired guard for the prod-code constant ``0.05``.

    If a future refactor changes the tolerance to a much wider 0.5 (50%),
    the boundary case "placed = tare + 100g" would accidentally fall
    INSIDE the new window and trigger ``discarded``. This test pins both
    sides of the threshold:

      * placed = tare + 30g (= 55g) → at the 5% boundary, IS inside →
        discarded fires.
      * placed = tare + 31g (= 56g) → just past the 5% boundary, is
        OUTSIDE → discarded does NOT fire.

    Mutating ``0.05`` → ``0.5`` would flip the second case (the wider
    window now accepts +31g) → assertion fails → mutation killed.
    """
    conn = init_db(":memory:")
    handler = _make_handler(conn, tmp_path)
    _, lot_in = _seed_product_and_lot(
        conn, tare_weight_g=25.0, net_weight_g=575.0,
    )
    # Window is 0.05 * 600 = 30g exactly.
    session_id = _open_session(conn)
    event_id = _record_add(conn, session_id, delta_g=55.0)
    handler._apply_lot_update_from_classification(
        direction="add",
        classification=_classification(lot_in.lot_id),
        event_ts="2026-04-27T12:05:08.000Z",
        delta_g=55.0,
        session_id=session_id,
        event_id=event_id,
        shelf_id="catch_all",
    )
    assert storage_repo.get_lot(conn, lot_in.lot_id) is None, (
        "55g (= tare + 30g, exactly at boundary) must trigger discard "
        "(boundary is inclusive: |placed-tare| <= tolerance)"
    )

    # Fresh seed for the just-outside case (the previous lot is gone).
    _, lot_out = _seed_product_and_lot(
        conn, tare_weight_g=25.0, net_weight_g=575.0,
    )
    event_id_2 = _record_add(
        conn, session_id, delta_g=56.0, ts="2026-04-27T12:05:09.000Z",
    )
    pre_out_count = sum(1 for k in _outbox_kinds(conn) if k == "discarded")
    handler._apply_lot_update_from_classification(
        direction="add",
        classification=_classification(lot_out.lot_id),
        event_ts="2026-04-27T12:05:09.000Z",
        delta_g=56.0,
        session_id=session_id,
        event_id=event_id_2,
        shelf_id="catch_all",
    )
    assert storage_repo.get_lot(conn, lot_out.lot_id) is not None, (
        "56g (= tare + 31g, just past boundary) MUST NOT trigger discard. "
        "If this fires, the 5%% tolerance has been widened — mutation suspect."
    )
    post_out_count = sum(1 for k in _outbox_kinds(conn) if k == "discarded")
    assert post_out_count == pre_out_count, (
        "no NEW discarded event must be enqueued for the just-outside case"
    )
