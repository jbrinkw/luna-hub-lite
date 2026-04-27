"""Scenario: catch-all empty-container placement → cloud ``discarded``.

Empty-container detection (2026-04-27)
--------------------------------------
When the user picks a tracked beverage off the live-shelf, drinks it
down, and then sets the empty bottle on the catch-all (scale-02), the
Pi recognises the placed weight is within ±5% of one container's full
mass (``tare + net``) of the product's tare alone and emits a
``discarded`` event for the matched lot. The earlier consumption was
already logged separately when the user actually drank from the
bottle (e.g. via live_scale weight changes during the session) — this
event is the "I am acknowledging the container is empty and logging it
out of inventory" signal.

Cloud-side semantics for ``discarded`` (migration
``20260427020000_shelf_event_discarded.sql``):

  * ``stock_lots.qty_containers`` zeroed.
  * ``stock_lots.in_flight_since`` cleared.
  * ``last_update_source = 'manual_discard'``.
  * NO ``food_logs`` row written (this is the load-bearing assertion
    — consumption was already logged elsewhere).

Walk-through
------------
1. Seed cloud: user + device + a certified Gatorade product with
   tare=25g + net=575g (full container = 600g, ±5% window = ±30g
   centered on the tare). Seed an on-shelf stock_lot with qty=0.5
   so the cloud has something to mutate.
2. Mirror the product + an ``in_flight`` lot into Pi SQLite — the
   user has previously picked up this bottle from the live-shelf,
   so its status mid-event is in_flight.
3. Drive the Pi handler's ``_apply_lot_update_from_classification``
   for a catch-all ADD with delta_g = tare + 5g (= 30g, well inside
   the 30g window).
4. Drain the outbox.
5. Assert:
     * Cloud lot ``qty_containers = 0`` + ``in_flight_since IS NULL``.
     * Cloud lot ``last_update_source = 'manual_discard'``.
     * NO food_logs row for the test user.
     * shelf_event_log carries ONE ``discarded`` row, applied=true,
       with the matched lot's product_id.
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


def _now_iso(offset_s: float = 0.0) -> str:
    t = _dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=offset_s)
    return t.isoformat(timespec="milliseconds").replace("+00:00", "Z")


@scenario("catch_all_empty_container_logout")
def _catch_all_empty_container_logout(ctx: HarnessContext) -> None:
    from server.handlers.scale_events import ScaleHandler  # noqa: E402
    from server.shelves import DEFAULT_REGISTRY  # noqa: E402
    from server.storage import repo as storage_repo  # noqa: E402
    from server.storage.models import LotIn, ProductIn, ScaleEventIn  # noqa: E402

    # 1. Seed cloud state.
    ctx.seed_cloud_user()
    ctx.seed_device()
    tare_g = 25.0
    net_g = 575.0
    full_g = tare_g + net_g  # 600g
    cloud_product_id = ctx.seed_product(
        name="Empty-container Gatorade",
        net_weight_g=net_g,
        servings_per_container=1.0,
    )
    # seed_product doesn't accept tare_weight_g — patch it inline so the
    # cloud's certified-product invariants pass and the Pi's mirror has
    # something to read once we bump the value across.
    with ctx.db.cursor() as cur:
        cur.execute(
            """
            UPDATE chefbyte.products
               SET tare_weight_g = %s,
                   gross_weight_g = %s,
                   container_type = 'bottle',
                   unit_type = 'liquid',
                   certified = true
             WHERE product_id = %s
            """,
            (tare_g, full_g, cloud_product_id),
        )
    cloud_lot_id = ctx.seed_stock_lot(
        product_id=cloud_product_id,
        qty_containers=0.5,
    )
    ctx.check(
        "cloud_seeded",
        True,
        evidence=(
            f"product (tare={tare_g}g net={net_g}g) + on-shelf lot "
            f"qty=0.5 ready (lot={cloud_lot_id[:8]})"
        ),
    )

    # 2. Mirror into Pi SQLite. We reuse the cloud product_id so the
    # cloud emit's product_id maps to a known cloud row.
    pi_conn = ctx.pi_sqlite
    storage_repo.create_product(
        pi_conn,
        ProductIn(
            barcode="HRN-EMPTY",
            name="Empty-container Gatorade",
            net_weight_g=net_g,
            gross_weight_g=full_g,
            tare_weight_g=tare_g,
            unit_type="liquid",
            container_type="bottle",
            certified=1,
        ),
    )
    # Repo helper mints its own UUID — overwrite the row with the cloud
    # product_id so the Pi/cloud lookups match.
    with pi_conn:
        pi_conn.execute(
            "UPDATE products SET product_id = ? WHERE name = 'Empty-container Gatorade'",
            (cloud_product_id,),
        )
    # Mirror as in_flight (user picked the bottle off the live-shelf
    # earlier in the session). pickup_weight_g = full container mass.
    pi_lot_in = storage_repo.create_lot(
        pi_conn,
        LotIn(
            product_id=cloud_product_id,
            status="in_flight",
            current_weight_g=full_g,
            initial_weight_g=full_g,
            pickup_weight_g=full_g,
            in_flight_since=_now_iso(-60.0),
            shelf_id="catch_all",
        ),
    )
    pi_lot_id = pi_lot_in.lot_id

    # 3. Build the Pi handler. We don't need a camera daemon here —
    # the empty-container check fires in the apply path (after the
    # classifier resolved the product) and doesn't depend on frame
    # capture.
    class _NullCandidateSource:
        def get_on_shelf_lots(self, shelf_id=None):
            return []

        def get_recently_out_lots(self, window_seconds, shelf_id=None):
            return []

        def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
            return []

        def get_certified_not_on_shelf(self):
            return []

    import threading as _th

    events_root = ctx.tmp_dir / "events"
    events_root.mkdir(exist_ok=True)
    handler = ScaleHandler(
        conn=pi_conn,
        db_lock=_th.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=dict(DEFAULT_REGISTRY),
        cloud_emitter=ctx.pi_emitter,
        cloud_client=ctx.pi_cloud_client,
    )

    # 4. Open a catch-all session + record an ADD event with placed
    # weight = tare + 5g (= 30g, inside the 30g window). Then call the
    # apply path with a synthesised classification pointing at the
    # in-flight lot we just minted — same shape the production
    # classifier path produces after a successful pick.
    session_id = storage_repo.open_session(
        pi_conn, _now_iso(), initial_weight_g=0.0, shelf_id="catch_all",
    ).session_id
    placed_g = tare_g + 5.0
    event_ts = _now_iso()
    event = storage_repo.record_scale_event(
        pi_conn,
        ScaleEventIn(
            ts=event_ts,
            delta_g=placed_g,
            before_weight_g=0.0,
            after_weight_g=placed_g,
            direction="add",
            session_id=session_id,
            classifier_status="pending",
            shelf_id="catch_all",
        ),
    )
    handler._apply_lot_update_from_classification(
        direction="add",
        classification={
            "item_id": pi_lot_id,
            "action": "added",
            "confidence": 0.95,
            "multi_match": [],
            "candidate_pool_used": [{"candidate_id": pi_lot_id}],
        },
        event_ts=event_ts,
        delta_g=placed_g,
        session_id=session_id,
        event_id=event.event_id,
        shelf_id="catch_all",
    )

    # 5. Pi-local lot must be deleted by the empty-container path
    # (mirrors the manual_discard local DELETE semantics).
    pi_lot_after = storage_repo.get_lot(pi_conn, pi_lot_id)
    ctx.check(
        "pi_lot_deleted",
        pi_lot_after is None,
        evidence=(
            f"empty-container hit must DELETE the local lot row; "
            f"got {pi_lot_after!r}"
        ),
    )

    # 6. Outbox pre-drain — exactly one discarded event for the matched
    # product, kind='catch_all'.
    pre_drain = pi_conn.execute(
        "SELECT json_extract(payload_json, '$.event_kind'), "
        "       json_extract(payload_json, '$.kind'), "
        "       json_extract(payload_json, '$.product_id'), "
        "       json_extract(payload_json, '$.scale_id'), "
        "       json_extract(payload_json, '$.pi_event_id') "
        "  FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0 "
        " ORDER BY outbox_id ASC"
    ).fetchall()
    pre_kinds = [r[0] for r in pre_drain]
    ctx.check(
        "outbox_has_exactly_one_discarded",
        pre_kinds == ["discarded"],
        evidence=f"expected outbox=['discarded']; got {pre_kinds!r}",
    )
    if pre_drain:
        ctx.check(
            "outbox_kind_catch_all",
            pre_drain[0][1] == "catch_all",
            evidence=(
                f"empty-container emit must use kind='catch_all' (not "
                f"'live_shelf'); got payload={pre_drain[0]!r}"
            ),
        )
        ctx.check(
            "outbox_product_id_matches_lot",
            pre_drain[0][2] == cloud_product_id,
            evidence=(
                f"emit must reference the matched lot's product_id; "
                f"got {pre_drain[0][2]!r}, expected {cloud_product_id!r}"
            ),
        )
        ctx.check(
            "outbox_scale_id_scale02",
            pre_drain[0][3] == "scale-02",
            evidence=(
                f"empty-container emit must use scale-02 (catch-all); "
                f"got scale_id={pre_drain[0][3]!r}"
            ),
        )

    # 7. Drain to cloud.
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

    # 8. Cloud lot state assertions.
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
            f"empty-container discarded must zero qty_containers; "
            f"got lot row={after!r}"
        ),
    )
    ctx.check(
        "cloud_in_flight_cleared",
        after is not None and after[1] is None and after[2] is None,
        evidence=(
            f"discarded must clear in_flight_since + pickup_event_id; "
            f"got lot row={after!r}"
        ),
    )
    ctx.check(
        "cloud_last_update_source_manual_discard",
        after is not None and after[3] == "manual_discard",
        evidence=(
            f"last_update_source must be 'manual_discard' so audits "
            f"distinguish discard from consume/refill; got lot row={after!r}"
        ),
    )

    # 9. Load-bearing assertion: NO food_logs row was written. The
    # empty-container event is NOT a consumed event — the consumption
    # was logged earlier when the user actually drank from the bottle.
    food_log_count = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.food_logs WHERE user_id = %s",
        (ctx.user_id,),
    )[0]
    ctx.check(
        "no_food_logs_written",
        food_log_count == 0,
        evidence=(
            f"empty-container discarded MUST NOT write food_logs; got "
            f"{food_log_count} row(s) for user {ctx.user_id}. If >0, the "
            f"discarded branch is leaking into the consumed/depleted INSERT."
        ),
    )

    # 10. shelf_event_log: one discarded row, applied=true.
    log_rows = ctx.q_all(
        "SELECT payload->>'event_kind', applied, reason, "
        "       payload->>'product_id' "
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
            and log_rows[0][3] == cloud_product_id
        ),
        evidence=(
            f"shelf_event_log must carry exactly one applied "
            f"'discarded' row referencing the matched lot's product_id; "
            f"got rows={log_rows!r}"
        ),
    )
