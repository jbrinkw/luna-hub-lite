"""Scenario: live_weight_sync payload fidelity (Pi -> outbox -> cloud).

Regression pinned (2026-04-29): Pi lots.current_weight_g was populated,
but emitted live_weight_sync payload carried observed_weight_g=NULL, so
cloud stock_lots.last_observed_weight_g stayed stale.

This scenario drives the real WeightSyncPoller against a mirrored cloud lot,
drains via CloudWorker, then asserts cloud-side observation columns match the
Pi weight field-by-field with no NULL drift.
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
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


class _ManualClock:
    def monotonic(self) -> float:
        return 0.0


@scenario("live_weight_sync_payload_fidelity")
def _live_weight_sync_payload_fidelity(ctx: HarnessContext) -> None:
    from server.cloud.weight_sync_poller import WeightSyncPoller

    # 1) Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(name="Live-weight test", net_weight_g=500.0)
    cloud_lot_id = ctx.seed_stock_lot(product_id=product_id, qty_containers=1.0)

    # 2) Mirror product+lot on Pi with known current_weight_g.
    #    Pi-local `lots.lot_id` is a DIFFERENT UUID from the cloud's
    #    `stock_lots.lot_id` for the same physical lot — that's the
    #    production reality. The poller resolves the cloud lot_id via
    #    the Pi's `cloud_lots` mirror, which we seed alongside `lots`.
    import uuid as _uuid

    pi_local_lot_id = str(_uuid.uuid4())
    assert pi_local_lot_id != cloud_lot_id
    pi_weight_g = 187.625
    pi_conn = ctx.pi_sqlite
    with pi_conn:
        pi_conn.execute(
            """
            INSERT INTO products (
                product_id, barcode, name, net_weight_g, gross_weight_g,
                unit_type, container_type, certified
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (product_id, "HRN-LWS", "Live-weight test", 500.0, 500.0, "solid", "jar", 1),
        )
        pi_conn.execute(
            """
            INSERT INTO lots (
                lot_id, product_id, status, current_weight_g,
                initial_weight_g, total_consumed_g, shelf_id
            ) VALUES (?, ?, 'on_shelf', ?, ?, 0.0, 'live_shelf')
            """,
            (pi_local_lot_id, product_id, pi_weight_g, pi_weight_g),
        )
        # Mirror the cloud lot into the Pi's `cloud_lots` table so the
        # poller can resolve cloud_lot_id via the product_id JOIN.
        pi_conn.execute(
            """
            INSERT INTO cloud_lots (
                lot_id, product_id, qty_containers,
                created_at, updated_at
            ) VALUES (?, ?, 1.0, ?, ?)
            """,
            (cloud_lot_id, product_id, _now_iso(), _now_iso()),
        )
    lot_id = cloud_lot_id  # what cloud-side asserts query against

    # 3) Fire the relevant Pi action: poller tick.
    poller = WeightSyncPoller(ctx.pi_emitter, pi_conn, clock=_ManualClock())
    emitted = poller.tick_once()
    ctx.check(
        "poller_emitted_once",
        emitted == 1,
        evidence=f"expected one live_weight_sync emit, got {emitted}",
    )

    # 4) Assert outbox payload before drain (payload-fidelity boundary).
    row = pi_conn.execute(
        "SELECT payload_json FROM cloud_outbox ORDER BY outbox_id DESC LIMIT 1"
    ).fetchone()
    payload = row[0] if row else None
    ctx.check(
        "outbox_payload_exists",
        payload is not None,
        evidence="expected one outbox row from weight_sync poller",
    )
    if payload is None:
        return
    import json as _json

    body = _json.loads(payload)
    ctx.check(
        "outbox_payload_observed_weight_non_null",
        body.get("observed_weight_g") is not None,
        evidence=f"payload={body!r}",
    )
    ctx.check(
        "outbox_payload_observed_weight_matches_pi",
        abs(float(body.get("observed_weight_g", -1)) - pi_weight_g) < 1e-6,
        evidence=(
            f"expected observed_weight_g={pi_weight_g}, "
            f"got {body.get('observed_weight_g')!r}"
        ),
    )

    # 5) Drain to cloud.
    ctx.pi_worker.tick()
    pending_after = pi_conn.execute(
        "SELECT COUNT(*) FROM cloud_outbox WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check("outbox_drained", pending_after == 0, evidence=f"pending={pending_after}")

    # 6) Cloud DB fidelity assertions.
    cloud_lot = ctx.q_one(
        "SELECT last_observed_weight_g::text, last_observed_at::text "
        "FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "cloud_last_observed_weight_non_null",
        cloud_lot is not None and cloud_lot[0] is not None,
        evidence=f"cloud_lot={cloud_lot!r}",
    )
    ctx.check(
        "cloud_last_observed_weight_matches_pi",
        cloud_lot is not None and abs(float(cloud_lot[0]) - pi_weight_g) < 1e-6,
        evidence=f"expected cloud weight={pi_weight_g}, got {cloud_lot!r}",
    )
    ctx.check(
        "cloud_last_observed_at_set",
        cloud_lot is not None and cloud_lot[1] is not None,
        evidence=f"cloud_lot={cloud_lot!r}",
    )

    # 7) Event-log payload also carries the explicit observed_weight_g field.
    log_row = ctx.q_one(
        "SELECT payload->>'event_kind', payload->>'pi_lot_id', "
        "payload->>'observed_weight_g' "
        "FROM chefbyte.shelf_event_log "
        "WHERE user_id = %s ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "cloud_event_log_kind_and_lot_match",
        log_row is not None and log_row[0] == "live_weight_sync" and log_row[1] == lot_id,
        evidence=f"log_row={log_row!r}",
    )
    ctx.check(
        "cloud_event_log_observed_weight_non_null",
        log_row is not None and log_row[2] is not None,
        evidence=f"log_row={log_row!r}",
    )
