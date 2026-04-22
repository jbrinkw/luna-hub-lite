"""Scenario: in-flight lot reunited via ``in_flight_return`` event.

Bug class
---------
When the Pi's live-shelf detects a REMOVE and the classifier identifies
a lot, the Pi transitions the lot to ``status='in_flight'`` locally and
emits an ``in_flight_pickup`` cloud event that stamps
``stock_lots.in_flight_since``. Later, when the user puts the container
BACK (not a full new placement — same bottle coming home), the Pi fires
an ``in_flight_return`` event.

The regression this scenario pins: an ``in_flight_return`` must
  1. clear ``in_flight_since`` + ``pickup_event_id`` on the matching lot
  2. NOT decrement ``qty_containers`` (the consumed event, if any, owns
     that)
  3. NOT mint a new lot (the whole point of the reunite flow is "this is
     the same container you saw leave")

A broken handler that either left ``in_flight_since`` set, or inserted
a second ``stock_lots`` row for the same product, would fail the asserts
below.

See migration ``20260425080000_shelf_event_in_flight_pickup.sql`` for
the cloud-side branch.

Walk-through
------------
1. Seed cloud user + device + product + ONE stock_lot with
   ``in_flight_since`` stamped (simulating a prior pickup the Pi
   already emitted).
2. Fire an ``in_flight_return`` event via the CloudEventEmitter
   (bypass ``handle_scale_event`` — the Pi emits this directly from
   its reconciler when a reunite is detected; ``handle_scale_event``'s
   classifier pipeline is out of scope here).
3. Tick the cloud worker once to drain.
4. Assert:
   * Still exactly one lot for the product.
   * ``in_flight_since`` is now NULL on that lot.
   * ``qty_containers`` unchanged from the seeded value.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")

REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


@scenario("live_shelf_reunite")
def _live_shelf_reunite(ctx: HarnessContext) -> None:
    # 1. Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(
        name="Reunite test product",
        net_weight_g=750.0,
    )
    # Seed the lot as already in-flight — ``in_flight_since`` is
    # non-null, as if the Pi emitted the pickup an hour ago.
    in_flight_since = _now_iso(offset_s=-3600)
    lot_id = ctx.seed_stock_lot(
        product_id=product_id,
        qty_containers=1.0,
        in_flight_since=in_flight_since,
    )
    ctx.check(
        "seeded_in_flight_lot",
        True,
        evidence=f"lot_id={lot_id[:8]} in_flight_since={in_flight_since}",
    )

    # Capture the baseline qty so we can assert it's unchanged after
    # the return event.
    baseline = ctx.q_one(
        "SELECT qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "baseline_in_flight_set",
        baseline is not None and baseline[1] is not None,
        evidence=f"baseline={baseline!r}",
    )

    # 2. Emit the in_flight_return event directly via the CloudEventEmitter
    # → outbox. This is what ``reconciler/adapter.py`` does when the
    # reconciler sees a reunite resolution.
    client_event_id = ctx.pi_emitter._enqueue({
        "scale_id": "scale-01",
        "kind": "live_shelf",
        "event_kind": "in_flight_return",
        "product_id": product_id,
        "delta_g": 0.0,  # return events don't mutate qty
        "occurred_at": _now_iso(),
    })
    ctx.check(
        "outbox_enqueued",
        client_event_id is not None and len(client_event_id) > 0,
        evidence=f"client_event_id={client_event_id!r}",
    )

    # 3. Drain.
    ctx.pi_worker.tick()

    pending = ctx.pi_sqlite.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    if pending != 0:
        row = ctx.pi_sqlite.execute(
            "SELECT attempts, last_error, failed_permanently "
            "  FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
        ).fetchone()
        ctx.check(
            "outbox_drained",
            False,
            evidence=(
                f"outbox still has {pending} pending rows after tick; "
                f"last row state: {dict(row) if row else row!r}"
            ),
        )
    ctx.check(
        "outbox_drained",
        pending == 0,
        evidence=f"pending_after_drain={pending}",
    )

    # 4. Assertions on cloud state.
    lots = ctx.q_all(
        "SELECT lot_id::text, qty_containers::text, in_flight_since::text "
        "  FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "still_exactly_one_lot",
        len(lots) == 1,
        evidence=(
            f"in_flight_return must NOT mint a new lot — the whole "
            f"point of reunite is 'same container'. Got {len(lots)} "
            f"lots for product: {lots!r}"
        ),
    )
    if lots:
        only_lot = lots[0]
        ctx.check(
            "in_flight_since_cleared",
            only_lot[2] is None,
            evidence=(
                f"in_flight_since must be NULL after in_flight_return; "
                f"got lot={only_lot!r}"
            ),
        )
        ctx.check(
            "qty_unchanged",
            float(only_lot[1] or 0) == float(baseline[0] or 0),
            evidence=(
                f"in_flight_return must not mutate qty_containers "
                f"(consumed event owns that). "
                f"baseline_qty={baseline[0]!r} post_qty={only_lot[1]!r}"
            ),
        )

    # Event log reflects applied=true with the cleared reason.
    log_row = ctx.q_one(
        "SELECT applied, reason "
        "  FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_applied",
        log_row is not None and bool(log_row[0]),
        evidence=f"shelf_event_log row={log_row!r}",
    )
