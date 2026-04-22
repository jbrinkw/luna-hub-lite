"""Scenario: single-item first placement on scale-03 paired to product.

Pins the 2026-04-22 regression.

Bug replayed
------------
Scale-03 is paired via ``chefbyte.scale_pairings`` to a product whose
``net_weight_g > 0``. There is no existing ``stock_lots`` row for that
product (user just provisioned it). When the user places a fresh
container on scale-03:

  * Pi fires a +N gram scale_event with ``delta_g > refill_threshold``.
  * Pi's ``handle_scale_event`` takes the single-item short-circuit:
    ``kind='live_scale'``, ``event_kind='refilled'``, ``product_id``
    OMITTED (cloud resolves via ``scale_pairings``).
  * Cloud's ``apply_shelf_event`` must handle the "refilled with no
    existing lot" branch by CREATING a lot with the delta as the
    initial ``qty_containers`` computation.

Pre-fix (commit 0d23dbc): the cloud "refilled" branch tried to UPDATE
the most recent lot in place. With zero lots to pick up, it errored
(or no-op'd), leaving ``stock_lots`` empty. The inventory page showed
nothing. Fix: revive-empty-lot-on-refill in migration
``20260425070000_resolve_add_reuse_empty_lot.sql`` (actually the
branch was reworked in ``20260425080000_shelf_event_in_flight_pickup.sql``
too; the resolve-add-reuse migration is where the first-lot path was
explicitly handled).

Harness verification
--------------------
  1. Seed user + device + product (net_weight_g=1000), pair scale-03
     to the product, no ``stock_lots`` rows.
  2. Fire a +1000g scale_event via ``ScaleHandler.handle_scale_event``
     — this is the on-Pi ingress, same as the ESP firing.
  3. Tick ``pi_worker.tick()`` once to drain the outbox into the real
     cloud edge function.
  4. Assert ``stock_lots`` now has one row with ``qty_containers > 0``
     for the paired product.

Pre-fix failure path: step 4's query returns 0 rows OR qty_containers=0.
Post-fix: exactly 1 row with qty_containers=1 (the delta/net_weight_g
ratio yields 1 container).
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


def _now_iso() -> str:
    """Return a fresh ISO-8601 UTC-ms timestamp.

    The cloud edge fn rejects ``occurred_at`` outside [now-30d, now+5m];
    hard-coding a date in the scenario would break as soon as that
    window shifted. Stamp fresh per-scenario.
    """
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


@scenario("single_item_first_placement")
def _single_item_first_placement(ctx: HarnessContext) -> None:
    # 1. Seed cloud-side user / device / product. No stock_lot rows.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(
        name="Chocolate Milk (harness)",
        net_weight_g=1000.0,
        servings_per_container=1.0,
    )
    ctx.seed_pairing(
        scale_id="scale-03",
        kind="live_scale",
        product_id=product_id,
    )
    ctx.check(
        "cloud_seeded_no_stock",
        True,
        evidence=f"product_id={product_id}, scale-03 paired, zero stock_lots",
    )

    # Baseline assertion: stock_lots is empty for this product. If seed
    # is wrong, every downstream check becomes ambiguous.
    pre = ctx.q_all(
        "SELECT lot_id FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "pre_no_stock_lots",
        len(pre) == 0,
        evidence=f"expected 0 stock_lots; got {len(pre)} rows {pre!r}",
    )

    # 2. Fire the scale event on the Pi handler. This must take the
    # live_scale → single_item short-circuit branch and enqueue a
    # cloud_outbox row.
    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-03",
        "event_seq": 1,
        "delta_g": 1000.0,
        "before_weight_g": 0.0,
        "after_weight_g": 1000.0,
    })
    ctx.check(
        "pi_handler_accepted",
        status == 200,
        evidence=f"status={status} resp={resp!r}",
    )
    ctx.check(
        "pi_short_circuit_single_item",
        isinstance(resp, dict) and resp.get("shelf_id") == "single_item",
        evidence=(
            f"expected shelf_id=single_item (the Pi short-circuit "
            f"for live_scale). Got resp={resp!r}"
        ),
    )

    # Pi outbox should contain exactly one pending row, payload kind=
    # live_scale / event_kind=refilled, no product_id (cloud resolves
    # via pairing).
    outbox_rows = ctx.pi_sqlite.execute(
        "SELECT payload_json FROM cloud_outbox WHERE sent_at IS NULL "
        "ORDER BY outbox_id ASC"
    ).fetchall()
    ctx.check(
        "outbox_one_pending_row",
        len(outbox_rows) == 1,
        evidence=f"expected 1 pending outbox row; got {len(outbox_rows)}",
    )

    # 3. Drain: tick the cloud worker once. This POSTs to the real
    # shelf-ingest edge function.
    ctx.pi_worker.tick()

    # The outbox row must have been marked sent (or failed_permanently=0
    # with sent_at!=NULL). If the edge function returned anything 4xx/5xx
    # it'd still be pending, so a simple "no rows pending" assert catches
    # most failures.
    pending_after = ctx.pi_sqlite.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    # If drain failed, try to surface the error from the row's last_error
    # column so the failure message is actionable.
    if pending_after != 0:
        err_info = ctx.pi_sqlite.execute(
            "SELECT outbox_id, attempts, last_error, failed_permanently "
            "  FROM cloud_outbox ORDER BY outbox_id ASC LIMIT 1"
        ).fetchone()
        ctx.check(
            "outbox_drained",
            False,
            evidence=(
                f"outbox drain failed — still {pending_after} rows "
                f"pending after tick. First row state: {dict(err_info) if err_info else err_info!r}"
            ),
        )
    ctx.check(
        "outbox_drained",
        pending_after == 0,
        evidence=f"expected 0 pending after drain; got {pending_after}",
    )

    # 4. Cloud-side state: stock_lots must now have at least one row for
    # this product with qty_containers > 0. This is THE assertion that
    # flips across the 0d23dbc / resolve-add-reuse-empty-lot boundary.
    post = ctx.q_all(
        "SELECT lot_id, qty_containers::text "
        "  FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "cloud_stock_lot_created",
        len(post) >= 1,
        evidence=(
            f"expected >= 1 stock_lots row for paired product after "
            f"refill event; got {len(post)} rows {post!r}. Pre-fix: "
            f"empty-lot revive branch was missing, so no row landed."
        ),
    )
    ctx.check(
        "cloud_qty_positive",
        all(float(row[1] or 0) > 0 for row in post),
        evidence=(
            f"expected qty_containers > 0 on every created lot; got "
            f"rows={post!r}"
        ),
    )

    # Finally: shelf_event_log row reflects the applied=true application.
    log_row = ctx.q_one(
        "SELECT applied, reason, resolved_lot_id "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_applied",
        log_row is not None and bool(log_row[0]),
        evidence=(
            f"shelf_event_log row must have applied=true; got {log_row!r}"
        ),
    )
