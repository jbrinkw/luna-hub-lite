"""Scenario: Pi /inventory remove button propagates to cloud as discarded.

Manual-discard end-to-end (2026-04-27)
--------------------------------------
The Live Shelf Pi web UI has a per-lot × button at /inventory. Pressing
it deletes the lot from Pi SQLite AND emits a ``discarded`` event to the
cloud so cloud ``stock_lots`` stops drifting from Pi reality. The cloud
handler:

  1. Zeroes ``qty_containers`` on the matching lot.
  2. Clears ``in_flight_since`` + ``pickup_event_id`` (so the same
     button doubles as a "stuck-in-flight" recovery affordance).
  3. Does NOT write a ``food_logs`` row — manual discard is NOT a
     consumed event (spilled, expired-and-thrown-out, given-away,
     fed-to-pet) and must not pollute macros.

Walk-through
------------
1. Seed cloud user + device + product + a stock_lot at qty=2.
2. Mirror the lot into Pi SQLite with status='on_shelf'.
3. Reproduce the ``_delete_lot`` handler shape (delete + emit) — this
   is the same closure built inline in ``server/app.py`` and exercised
   by the ``POST /api/lot/<lot_id>/delete`` route.
4. Drain the outbox.
5. Assert:
     * Cloud lot ``qty_containers`` = 0 + ``in_flight_since`` IS NULL.
     * Cloud lot ``last_update_source`` = 'manual_discard'.
     * Exactly ZERO ``food_logs`` rows for the test user/day.
     * Exactly one ``shelf_event_log`` row with event_kind='discarded'.

This scenario doubles as a regression guard for the "stuck-in-flight
recovery" path: if a future change reverts the in_flight_since clear
in the cloud handler, the assertion below would fail. The reciprocal
case (Pi-only lot with no cloud row) is covered by the Pi unit test
``test_delete_lot_with_disabled_emitter_is_local_only``.
"""

from __future__ import annotations

import datetime as _dt
import logging
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _build_delete_lot_fn(conn, db_lock, cloud_emitter):
    """Mirror ``server/app.py::_delete_lot`` closure for harness use.

    The production closure is built inside ``_create_app`` so harness
    scenarios can't import it directly without booting the whole Flask
    app. We replicate its shape verbatim here. If you change the
    production handler, mirror the change in this helper too.
    """
    from server.storage import repo as storage_repo

    log = logging.getLogger("harness.manual_discard")

    def _delete_lot(lot_id):
        with db_lock:
            existing = storage_repo.get_lot(conn, lot_id)
            if existing is None:
                raise LookupError(f"lot not found: {lot_id!r}")
            product_id = existing.product_id
            shelf_id = existing.shelf_id
            counts = storage_repo.delete_lot(conn, lot_id)

            if shelf_id == "single_item":
                cloud_kind = "live_scale"
            elif shelf_id == "catch_all":
                cloud_kind = "catch_all"
            else:
                cloud_kind = "live_shelf"

            cloud_event_id = None
            if cloud_emitter.enabled and product_id:
                try:
                    cloud_event_id = cloud_emitter.emit_manual_discard(
                        scale_id="scale-01",
                        product_id=product_id,
                        kind=cloud_kind,
                        pi_event_id=lot_id,
                    )
                except Exception:
                    log.warning(
                        "harness lot delete: cloud emit raised",
                        exc_info=True,
                    )

        return {
            "lot_id": lot_id,
            "rows_deleted": counts,
            "cloud_event_enqueued": cloud_event_id is not None,
        }

    return _delete_lot


@scenario("live_shelf_manual_discard_no_macros")
def _live_shelf_manual_discard_no_macros(ctx: HarnessContext) -> None:
    from server.storage import repo as storage_repo
    from server.storage.models import LotIn, ProductIn

    # 1. Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    cloud_product_id = ctx.seed_product(
        name="Manual discard test",
        net_weight_g=net_weight_g,
        servings_per_container=1.0,
    )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=2.0,
    )

    # 2. Mirror into Pi SQLite. The Pi lot_id == cloud lot_id is
    # incidental for the test — production uses Pi-minted UUIDs that
    # don't have to match cloud — but reusing the cloud_lot_id makes
    # the assertions cross-readable.
    pi_conn = ctx.pi_sqlite
    storage_repo.create_product(
        pi_conn,
        ProductIn(
            barcode="HRN-DISC",
            name="Manual discard test",
            net_weight_g=net_weight_g,
            gross_weight_g=net_weight_g,
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )
    # Override the Pi product_id with the cloud product_id so the
    # emit's product_id field maps to a known cloud row. The repo
    # helper doesn't accept overrides, so rewrite the row inline.
    with pi_conn:
        pi_conn.execute(
            "UPDATE products SET product_id = ? "
            " WHERE name = 'Manual discard test'",
            (cloud_product_id,),
        )
    storage_repo.create_lot(
        pi_conn,
        LotIn(
            product_id=cloud_product_id,
            status="on_shelf",
            current_weight_g=net_weight_g * 2,
            initial_weight_g=net_weight_g * 2,
            shelf_id="live_shelf",
        ),
    )
    # Pull the minted Pi lot_id for the delete call.
    pi_lot_row = pi_conn.execute(
        "SELECT lot_id FROM lots WHERE product_id = ?",
        (cloud_product_id,),
    ).fetchone()
    pi_lot_id = pi_lot_row["lot_id"]

    # 3. Build the delete handler with the cloud emitter wired.
    delete_lot_fn = _build_delete_lot_fn(
        pi_conn, ctx._pi_db_lock, ctx.pi_emitter,
    )

    # 4. Press the × button.
    summary = delete_lot_fn(pi_lot_id)
    ctx.check(
        "local_lot_deleted",
        summary["rows_deleted"]["lots"] == 1,
        evidence=f"local DELETE summary={summary!r}",
    )
    ctx.check(
        "cloud_event_enqueued",
        summary["cloud_event_enqueued"] is True,
        evidence=f"cloud emit must succeed for an enabled emitter; got {summary!r}",
    )

    # Outbox row pre-drain — exactly one discarded event.
    pre_drain = pi_conn.execute(
        "SELECT json_extract(payload_json, '$.event_kind') "
        "  FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchall()
    pre_drain_kinds = [r[0] for r in pre_drain]
    ctx.check(
        "outbox_has_exactly_one_discarded",
        pre_drain_kinds == ["discarded"],
        evidence=(
            f"expected outbox=['discarded']; got {pre_drain_kinds!r}. "
            f"If empty, the emit was suppressed — check "
            f"PATTERN_TO_EVENT_KIND['manual_discard'] mapping."
        ),
    )

    # 5. Drain to cloud.
    ctx.pi_worker.tick()
    pending_after = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "outbox_drained",
        pending_after == 0,
        evidence=f"pending_after_drain={pending_after}",
    )

    # 6. Cloud state assertions.
    after = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text, "
        "       pickup_event_id::text, last_update_source "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (cloud_lot_id,),
    )
    ctx.check(
        "cloud_qty_zeroed",
        after is not None and float(after[0] or 0) == 0.0,
        evidence=(
            f"discarded event must zero qty_containers regardless of delta_g; "
            f"got lot row={after!r}"
        ),
    )
    ctx.check(
        "cloud_in_flight_cleared",
        after is not None and after[1] is None and after[2] is None,
        evidence=(
            f"discarded must clear in_flight_since + pickup_event_id "
            f"(stuck-in-flight recovery affordance); got lot row={after!r}"
        ),
    )
    ctx.check(
        "cloud_last_update_source_manual_discard",
        after is not None and after[3] == "manual_discard",
        evidence=(
            f"last_update_source must be 'manual_discard' so audits can "
            f"distinguish manual discard from regular consume/refill; "
            f"got lot row={after!r}"
        ),
    )

    # 7. NO food_logs row for the discard. This is the load-bearing
    # assertion: the whole point of the discarded event_kind is that
    # it bypasses macro logging. If a food_logs row exists, a future
    # refactor accidentally wired discard through the consumed branch.
    food_log_count = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.food_logs WHERE user_id = %s",
        (ctx.user_id,),
    )[0]
    ctx.check(
        "no_food_logs_written",
        food_log_count == 0,
        evidence=(
            f"discarded event must NOT write food_logs; got "
            f"{food_log_count} row(s) for user {ctx.user_id}. If >0, the "
            f"discarded branch in private.apply_shelf_event is leaking "
            f"into the consumed/depleted INSERT."
        ),
    )

    # 8. shelf_event_log must show exactly one discarded row, applied=true.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind', applied, reason "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at ASC",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_one_discarded_applied",
        (
            len(log_rows) == 1
            and log_rows[0][0] == "discarded"
            and log_rows[0][1] is True
            and log_rows[0][2] == "discarded"
        ),
        evidence=f"shelf_event_log rows={log_rows!r}",
    )
