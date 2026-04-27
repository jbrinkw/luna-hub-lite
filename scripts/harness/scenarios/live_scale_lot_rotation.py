"""Scenario: live_scale auto-rotation when paired lot reaches qty=0.

Validates the 2026-04-27 lot-level scale_pairings refactor end-to-end:

  1. Seed two lots A + B of the same product (A is FEFO winner).
  2. Pair scale-03 to product, with pairing.lot_id pinned to lot A.
  3. Drive a Pi single-item consumed event whose delta zeroes the
     paired lot.
  4. Drain the Pi outbox.
  5. Assert cloud invariants:
        * lot A qty_containers == 0
        * lot B qty_containers untouched
        * scale_pairings.lot_id rotated from A → B
        * shelf_event_log.reason ends with ':rotated'

Mutation guard: revert
``private.rotate_pairing_after_depletion`` to a no-op (or remove the
call from apply_shelf_event) and this scenario fails on the rotation
assertion.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(
        timespec="milliseconds"
    ).replace("+00:00", "Z")


@scenario("live_scale_lot_rotation")
def _live_scale_lot_rotation(ctx: HarnessContext) -> None:
    # 1. Seed.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    product_id = ctx.seed_product(
        name="Lot rotation test product",
        net_weight_g=net_weight_g,
    )

    # Two lots — A is the FEFO winner (earlier expiry), B is the next.
    # The pairing pins to A; consumption drains A; rotation should
    # advance to B automatically.
    lot_a = ctx.seed_stock_lot(product_id=product_id, qty_containers=1.0)
    lot_b = ctx.seed_stock_lot(product_id=product_id, qty_containers=1.0)

    # Stamp expires_on so the rotation FEFO ordering is deterministic.
    # (seed_stock_lot doesn't accept expires_on — push it directly.)
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.stock_lots SET expires_on = %s, last_update_source = %s "
            " WHERE lot_id = %s",
            ("2026-05-15", "live_scale", lot_a),
        )
        cur.execute(
            "UPDATE chefbyte.stock_lots SET expires_on = %s, last_update_source = %s "
            " WHERE lot_id = %s",
            ("2026-06-15", "live_scale", lot_b),
        )

    # Pair scale-03 to product, pinned to lot A.
    scale_id = "scale-03"
    pairing_id = ctx.seed_pairing(
        scale_id=scale_id,
        kind="live_scale",
        product_id=product_id,
    )
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.scale_pairings SET lot_id = %s WHERE pairing_id = %s",
            (lot_a, pairing_id),
        )

    baseline = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_a,),
    )
    ctx.check(
        "baseline_lot_a_qty_one",
        baseline is not None and float(baseline[0] or 0) == 1.0,
        evidence=f"lot_a baseline={baseline!r}",
    )

    pairing_baseline = ctx.q_one(
        "SELECT lot_id::text FROM chefbyte.scale_pairings WHERE pairing_id = %s",
        (pairing_id,),
    )
    ctx.check(
        "baseline_pairing_pinned_to_lot_a",
        pairing_baseline is not None and pairing_baseline[0] == lot_a,
        evidence=f"pairing.lot_id baseline={pairing_baseline!r}, expected lot_a={lot_a}",
    )

    # 2. Drive a consumed event sufficient to zero out lot A.
    # delta=-net_weight zeroes 1.0 ctn of a 500g product.
    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": scale_id,
        "event_seq": 1,
        "delta_g": -net_weight_g,
        "before_weight_g": net_weight_g,
        "after_weight_g": 0.0,
    })
    ctx.check(
        "pi_accepted_event",
        status == 200 and isinstance(resp, dict),
        evidence=f"status={status}, resp={resp!r}",
    )

    # 3. Drain.
    ctx.pi_worker.tick()
    pending = ctx.pi_sqlite.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "outbox_drained",
        pending == 0,
        evidence=f"pending_after_drain={pending}",
    )

    # 4. Cloud assertions.
    after_a = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_a,),
    )
    ctx.check(
        "lot_a_zeroed",
        after_a is not None and float(after_a[0] or 0) == 0.0,
        evidence=(
            f"expected lot A qty=0 after consumed event. Got {after_a!r}. "
            f"If non-zero, the depleted/consumed branch did not zero the "
            f"pinned lot — apply_shelf_event may not be honouring "
            f"scale_pairings.lot_id."
        ),
    )

    after_b = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_b,),
    )
    ctx.check(
        "lot_b_untouched",
        after_b is not None and float(after_b[0] or 0) == 1.0,
        evidence=(
            f"lot B should NOT have been touched. Got {after_b!r}. "
            f"If lot B is decremented, apply_shelf_event picked the "
            f"FEFO winner (B is later expiry but the pairing pinned A) "
            f"or rotated and decremented in the same call."
        ),
    )

    pairing_after = ctx.q_one(
        "SELECT lot_id::text FROM chefbyte.scale_pairings WHERE pairing_id = %s",
        (pairing_id,),
    )
    ctx.check(
        "pairing_rotated_to_lot_b",
        pairing_after is not None and pairing_after[0] == lot_b,
        evidence=(
            f"expected pairing.lot_id == lot_b ({lot_b}) after rotation. "
            f"Got {pairing_after!r}. If still lot_a, "
            f"rotate_pairing_after_depletion didn't run / failed to find "
            f"the next FEFO candidate."
        ),
    )

    log_row = ctx.q_one(
        "SELECT reason FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_reason_marked_rotated",
        log_row is not None
        and isinstance(log_row[0], str)
        and log_row[0].endswith(":rotated"),
        evidence=(
            f"expected shelf_event_log.reason ending in ':rotated'. "
            f"Got {log_row!r}. Audit-row format is the documented "
            f"contract — drift breaks operator-facing tooling."
        ),
    )
