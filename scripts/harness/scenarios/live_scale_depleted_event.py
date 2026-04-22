"""Scenario: single-item live_scale ``depleted`` event zeros cloud qty.

EMIT→HANDLE matrix coverage (2026-04-27)
----------------------------------------
``depleted`` is one of the five cloud ``VALID_EVENT_KINDS`` but had
no end-to-end harness scenario before this file landed. The kind is
emitted exclusively by ``CloudEventEmitter.emit_single_item_event``
when the after-weight on a live_scale rig drops to within the noise
floor (bottle drained to empty, user took the last serving off the
shelf, etc.). The cloud's ``apply_shelf_event`` depleted branch
forces ``qty_containers=0`` unconditionally — unlike ``consumed``
which subtracts ``delta_g / net_weight_g`` and can under-shoot by
rounding. Pinning the full flow here guards both the Pi short-circuit
dispatch in ``handle_scale_event`` and the cloud branch.

Walk-through
------------
1. Seed cloud user + device + product (net_weight_g=500) + paired
   single-item scale ``scale-depleted`` + one stock_lot with
   qty_containers=1.0.
2. Drive a scale event on the Pi with ``after_weight_g`` inside the
   consumption noise floor (≤2g). The handler's
   ``shelf_id == 'single_item'`` short-circuit converts this into an
   ``emit_single_item_event(depleted=True)`` call.
3. Drain the outbox.
4. Assert cloud stock_lots.qty_containers == 0 and one
   shelf_event_log row with ``payload->>'event_kind' = 'depleted'``.
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


@scenario("live_scale_depleted_event")
def _live_scale_depleted_event(ctx: HarnessContext) -> None:
    # 1. Seed.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 500.0
    product_id = ctx.seed_product(
        name="Depleted-event test",
        net_weight_g=net_weight_g,
    )
    # Pi's shelf registry maps scale-03 → live_scale (see server/shelves.py).
    # The scenario must use a device_id the registry recognises or the
    # handler rejects the event with "unknown device_id".
    scale_id = "scale-03"
    ctx.seed_pairing(
        scale_id=scale_id,
        kind="live_scale",
        product_id=product_id,
    )
    lot_id = ctx.seed_stock_lot(
        product_id=product_id,
        qty_containers=1.0,
    )
    baseline = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "baseline_qty_is_one",
        baseline is not None and float(baseline[0] or 0) == 1.0,
        evidence=f"baseline={baseline!r}",
    )

    # 2. Drive a scale event with after=0g, before=net_weight. This
    # trips the single-item short-circuit's ``depleted=True`` branch
    # because after_weight_g (0g) is within the consumption noise floor.
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
        "pi_accepted_depleted",
        status == 200
        and isinstance(resp, dict)
        and resp.get("depleted") is True,
        evidence=(
            f"expected Pi handler to return depleted=True in the single-"
            f"item short-circuit. Got status={status}, resp={resp!r}. If "
            f"depleted is False, the handler classified this as consumed "
            f"(not depleted) — the cloud depleted branch won't fire."
        ),
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
    after = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "cloud_qty_forced_to_zero",
        after is not None and float(after[0] or 0) == 0.0,
        evidence=(
            f"depleted must zero qty_containers regardless of delta — "
            f"got lot={after!r}. If qty is non-zero, the cloud took the "
            f"consumed branch instead (and potentially the decrement was "
            f"rounded off)."
        ),
    )

    log_row = ctx.q_one(
        "SELECT payload->>'event_kind', applied "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_depleted_applied",
        log_row is not None
        and log_row[0] == "depleted"
        and bool(log_row[1]),
        evidence=(
            f"expected shelf_event_log row with event_kind='depleted' "
            f"and applied=true. Got {log_row!r}"
        ),
    )
