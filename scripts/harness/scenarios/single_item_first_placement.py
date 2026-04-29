"""Scenario: single-item first placement on scale-03 paired to product.

Pins the 2026-04-29 single_track-never-mints contract (commit ddde56d /
migration 20260429010000_live_scale_never_mints_v2.sql).

User-facing rule
----------------
"Single track scale should never mint a new item — it should either pull
from existing non-tracked inventory or just ignore whatever event it has."

Bug it prevents (originally hit at the kitchen on 2026-04-29)
-------------------------------------------------------------
User scans a gallon of milk → cloud has qty=1 lot. User places that
gallon on the live_scale paired to milk. PRE-fix: the cloud `refilled`
branch minted a SECOND lot from the placement weight → qty=2. POST-fix:
the live_scale ADD branch never mints — it claims an existing lot if
one matches the paired product, or no-ops with applied=true and reason
'live_scale_no_lot_no_op' when no lot exists.

Harness verification (this scenario covers the no-prior-lot case)
-----------------------------------------------------------------
  1. Seed user + device + product (net_weight_g=1000), pair scale-03
     to the product, no ``stock_lots`` rows for it (the "first
     placement before any scan" case).
  2. Fire a +1000g scale_event via ``ScaleHandler.handle_scale_event``
     — the on-Pi ingress, same as the ESP firing.
  3. Tick ``pi_worker.tick()`` once to drain the outbox into the real
     cloud edge function.
  4. Assert NO stock_lots row was created (the no-mint guarantee), and
     that ``shelf_event_log`` has applied=true / reason='live_scale_no_lot_no_op'
     / resolved_lot_id IS NULL.

If this scenario starts seeing a minted lot, something has re-broken
the single_track-never-mints rule. The user already lost trust in this
exact flow once tonight; the harness pin keeps it from happening again.
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

    # 4. Cloud-side state: per the 2026-04-29 single_track-never-mints
    # design (commit ddde56d, migration 20260429010000), live_scale ADD
    # events MUST NEVER mint a new stock_lots row. With no existing lot
    # at all, the apply branch acks the event (applied=true) but creates
    # nothing. Reason: 'live_scale_no_lot_no_op'.
    #
    # User-facing rule: "single track scale should never mint a new
    # item — it should either pull from existing non-tracked inventory
    # or just ignore". On a first placement with no prior inventory,
    # there's nothing to pull → ignore.
    post = ctx.q_all(
        "SELECT lot_id, qty_containers::text "
        "  FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "cloud_no_lot_minted",
        len(post) == 0,
        evidence=(
            f"single_track-never-mints: expected 0 stock_lots rows after "
            f"first-placement refill event; got {len(post)} rows {post!r}. "
            f"If this fires, the no-mint guarantee is broken."
        ),
    )

    # shelf_event_log row reflects applied=true with the no-op reason.
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
    ctx.check(
        "shelf_event_log_no_op_reason",
        log_row is not None and log_row[1] == 'live_scale_no_lot_no_op',
        evidence=(
            f"expected reason='live_scale_no_lot_no_op'; got {log_row[1]!r}"
            if log_row else f"got log_row={log_row!r}"
        ),
    )
    ctx.check(
        "shelf_event_log_no_resolved_lot",
        log_row is not None and log_row[2] is None,
        evidence=(
            f"expected resolved_lot_id IS NULL on no-op; got {log_row[2]!r}"
            if log_row else f"got log_row={log_row!r}"
        ),
    )
