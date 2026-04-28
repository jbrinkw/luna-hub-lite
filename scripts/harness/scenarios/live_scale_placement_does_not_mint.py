"""Scenario: live_scale (single_track) placement events NEVER mint a lot.

CONTEXT (2026-04-28):
  Tonight's bug: user scanned a gallon of milk → wizard inserted a
  stock_lots row with qty_containers=1.0. User placed bottle on
  scale-03. Pi emitted live_scale `refilled`. Cloud's
  resolve_add_to_shelf_lot promoted the wizard lot AND added the
  placed mass → qty became 1.972 instead of staying at 1.0.

This scenario validates the no-mint rule end-to-end (Pi → outbox →
cloud apply):

  1. Seed a wizard-created lot at qty=1.0 + a paired live_scale on
     scale-03 (pairing.lot_id pinned to the lot).
  2. Drive a Pi single-item placement event (delta=net_weight, scale
     starts at 0, ends at net_weight = 1 container).
  3. Drain Pi outbox.
  4. Assert lot qty == 1.000 (SET, not 2.0 ADD).
  5. Assert NO new stock_lots row was created (count_after == count_before).
  6. Drive a SECOND placement event of the same magnitude. Idempotent
     by client_event_id but ALSO idempotent in semantics — qty stays
     at 1.000, count_after still equals count_before.

Mutation guard: revert migration 20260428060000 (or remove the early
reject from resolve_add_to_shelf_lot) → step 4 fails with qty=2.0 and
the fingerprint message in the evidence string.
"""

from __future__ import annotations

import datetime as _dt
import sys
import uuid
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


@scenario("live_scale_placement_does_not_mint")
def _live_scale_placement_does_not_mint(ctx: HarnessContext) -> None:
    # 1. Seed.
    ctx.seed_cloud_user()
    ctx.seed_device()
    net_weight_g = 3785.410   # gallon-of-milk-shaped product
    product_id = ctx.seed_product(
        name="No-mint test whole milk",
        net_weight_g=net_weight_g,
    )

    # Wizard-created lot at qty=1.0. last_update_source intentionally
    # left at default (NULL / 'manual') — this is the shape the
    # promote_untracked_lot bug exploited.
    lot_id = ctx.seed_stock_lot(
        product_id=product_id,
        qty_containers=1.0,
        expires_on="2027-12-31",
    )

    # Pair scale-03 to product, pinned to the wizard lot.
    scale_id = "scale-03"
    pairing_id = ctx.seed_pairing(
        scale_id=scale_id,
        kind="live_scale",
        product_id=product_id,
    )
    with ctx.db.cursor() as cur:
        cur.execute(
            "UPDATE chefbyte.scale_pairings SET lot_id = %s WHERE pairing_id = %s",
            (lot_id, pairing_id),
        )

    baseline = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "baseline_lot_qty_one",
        baseline is not None and float(baseline[0] or 0) == 1.0,
        evidence=f"baseline lot qty={baseline!r}, expected 1.0",
    )

    count_before = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "baseline_one_lot_for_product",
        count_before is not None and int(count_before[0]) == 1,
        evidence=f"baseline lot count={count_before!r}, expected 1",
    )

    # 2. First placement: 0g → 3785.41g (a fresh full bottle).
    handler = ctx.build_pi_scale_handler(catch_all_enabled=True)
    resp1, status1 = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": scale_id,
        "event_seq": 1,
        "delta_g": net_weight_g,
        "before_weight_g": 0.0,
        "after_weight_g": net_weight_g,
    })
    ctx.check(
        "pi_accepted_placement_event_1",
        status1 == 200 and isinstance(resp1, dict)
        and resp1.get("event_kind") == "refilled",
        evidence=f"status={status1}, resp={resp1!r}",
    )

    # 3. Drain.
    ctx.pi_worker.tick()
    pending1 = ctx.pi_sqlite.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "outbox_drained_1",
        pending1 == 0,
        evidence=f"pending_after_drain_1={pending1}",
    )

    # 4. Cloud assertions.
    after1 = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "lot_qty_set_not_added_after_first_placement",
        after1 is not None and float(after1[0] or 0) == 1.0,
        evidence=(
            f"expected lot qty=1.0 after first placement (SET semantics). "
            f"Got {after1!r}. A value of 2.0 means the cloud applied ADD "
            f"semantics (today's bug fingerprint). A value of 0.972 means "
            f"the SET path divided by the wrong denominator."
        ),
    )

    count_after_1 = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "no_new_lot_minted_after_first_placement",
        count_after_1 is not None
        and int(count_after_1[0]) == int(count_before[0]),
        evidence=(
            f"expected lot count unchanged after first placement. "
            f"before={count_before!r}, after={count_after_1!r}. A higher "
            f"count means single_track minted a lot — the no-mint rule "
            f"is broken (single_track_minted_a_lot)."
        ),
    )

    # 5. Second placement of the same magnitude (different
    # client_event_id so it's NOT just a retry). Real-world: user
    # picked the bottle up + put it back down again. qty must stay at
    # 1.0 — SET semantics make repeated placements idempotent.
    resp2, status2 = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": scale_id,
        "event_seq": 2,
        "delta_g": net_weight_g,
        # Simulating "scale was tared after first place" — start from
        # 0 again. Whether it's a true 0→full or full→full doesn't
        # matter for SET semantics.
        "before_weight_g": 0.0,
        "after_weight_g": net_weight_g,
    })
    ctx.check(
        "pi_accepted_placement_event_2",
        status2 == 200 and isinstance(resp2, dict)
        and resp2.get("event_kind") == "refilled",
        evidence=f"status={status2}, resp={resp2!r}",
    )

    ctx.pi_worker.tick()
    pending2 = ctx.pi_sqlite.execute(
        "SELECT COUNT(*) FROM cloud_outbox "
        " WHERE sent_at IS NULL AND failed_permanently = 0"
    ).fetchone()[0]
    ctx.check(
        "outbox_drained_2",
        pending2 == 0,
        evidence=f"pending_after_drain_2={pending2}",
    )

    after2 = ctx.q_one(
        "SELECT qty_containers::text FROM chefbyte.stock_lots WHERE lot_id = %s",
        (lot_id,),
    )
    ctx.check(
        "lot_qty_still_one_after_second_placement",
        after2 is not None and float(after2[0] or 0) == 1.0,
        evidence=(
            f"expected lot qty=1.0 after second placement (SET is "
            f"idempotent). Got {after2!r}. A value > 1.0 means the "
            f"cloud is accumulating per-event instead of setting."
        ),
    )

    count_after_2 = ctx.q_one(
        "SELECT COUNT(*) FROM chefbyte.stock_lots "
        " WHERE user_id = %s AND product_id = %s",
        (ctx.user_id, product_id),
    )
    ctx.check(
        "no_new_lot_minted_after_second_placement",
        count_after_2 is not None
        and int(count_after_2[0]) == int(count_before[0]),
        evidence=(
            f"expected lot count unchanged after second placement. "
            f"before={count_before!r}, after={count_after_2!r}."
        ),
    )

    # 6. Audit row check — last cloud event's reason should match the
    # SET semantics fingerprint, not the legacy 'promoted_untracked_lot'.
    log_row = ctx.q_one(
        "SELECT reason FROM chefbyte.shelf_event_log "
        " WHERE user_id = %s "
        " ORDER BY created_at DESC LIMIT 1",
        (ctx.user_id,),
    )
    ctx.check(
        "shelf_event_log_reason_uses_set_semantics",
        log_row is not None
        and isinstance(log_row[0], str)
        and (
            log_row[0].startswith("live_scale_set_qty")
            or log_row[0].startswith("live_scale_claimed_and_set")
        ),
        evidence=(
            f"expected shelf_event_log.reason to start with "
            f"live_scale_set_qty or live_scale_claimed_and_set "
            f"(SET-semantics audit string). Got {log_row!r}. A value of "
            f"'promoted_untracked_lot' means the legacy ADD path is "
            f"still active for live_scale events — the no-mint fix "
            f"isn't applied."
        ),
    )
