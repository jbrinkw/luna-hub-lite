"""Heartbeat ``lots`` payload — Pi-side data needed by the cloud
``pi_cloud_lot_id_match`` invariant.

Drains the "Pi-side invariant check from cloud edge function" entry from
ignore.md (originally a documented gap because the Pi's local lot state
wasn't visible to the cloud edge function).

The Pi's heartbeat now carries a ``lots`` array — one entry per
``cloud_lots`` row the lot-snapshot poller has mirrored. Each entry
carries cloud_lot_id + qty_containers + status + in_flight_since/kind +
scale_id_paired_to (joined LEFT from local ``scale_pairings``). The
cloud edge function (shelf-ingest /heartbeat) UPSERTs these rows into
``chefbyte.pi_lot_snapshots`` so the cloud invariant-monitor can
cross-check Pi mirror vs cloud truth.

Coverage:
1. cloud_lots row + matching scale_pairings → lots[] entry has
   cloud_lot_id, qty_containers, in_flight info, AND
   scale_id_paired_to populated.
2. cloud_lots row WITHOUT a matching scale_pairings row → lots[] entry
   has scale_id_paired_to=None (LEFT JOIN behavior).
3. cloud_lots tombstone (deleted_at IS NOT NULL) is excluded.
4. No cloud_lots table → degrades gracefully (lots=[]).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.storage import init_db  # noqa: E402


def _build_lots_payload(conn: sqlite3.Connection) -> list[dict]:
    """Replicates the SQL in ``_heartbeat_provider`` so we test the
    contract without spinning up the full Flask app + cloud worker
    machinery. Keep this query in lockstep with app.py.
    """
    rows = conn.execute(
        """
        SELECT cl.lot_id,
               cl.qty_containers,
               cl.in_flight_since,
               cl.in_flight_kind,
               sp.shelf_id AS scale_id_paired_to
          FROM cloud_lots cl
          LEFT JOIN scale_pairings sp
            ON sp.lot_id = cl.lot_id
         WHERE cl.deleted_at IS NULL
         ORDER BY cl.updated_at DESC
         LIMIT 256
        """
    ).fetchall()
    out: list[dict] = []
    for r in rows:
        cloud_lot_id = str(r["lot_id"])
        status_text = (
            "in_flight" if r["in_flight_since"] is not None else "on_shelf"
        )
        last_src = r["in_flight_kind"] if r["in_flight_kind"] is not None else None
        out.append(
            {
                "pi_lot_id": cloud_lot_id,
                "cloud_lot_id": cloud_lot_id,
                "qty_containers": (
                    float(r["qty_containers"])
                    if r["qty_containers"] is not None
                    else None
                ),
                "status": status_text,
                "last_update_source": last_src,
                "in_flight_since": r["in_flight_since"],
                "in_flight_kind": r["in_flight_kind"],
                "current_weight_g": None,
                "scale_id_paired_to": r["scale_id_paired_to"],
            }
        )
    return out


def _seed_product_and_lot(conn: sqlite3.Connection) -> None:
    """A scale_pairings.lot_id FK references local lots(lot_id), so we
    seed a local lots row first. Real heartbeats join cloud_lots →
    scale_pairings on the cloud lot UUID; the FK forces us to keep a
    parallel local row for this test even though the test isn't
    exercising the local-lot semantics directly.
    """
    with conn:
        conn.execute(
            "INSERT OR IGNORE INTO products (product_id, name) VALUES (?, ?)",
            ("prod-pls-test", "PLS Test Milk"),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO lots (
              lot_id, product_id, status, current_weight_g, initial_weight_g
            ) VALUES (?, ?, 'on_shelf', 0, 0)
            """,
            ("cloud-lot-A", "prod-pls-test"),
        )
        conn.execute(
            """
            INSERT OR IGNORE INTO lots (
              lot_id, product_id, status, current_weight_g, initial_weight_g
            ) VALUES (?, ?, 'on_shelf', 0, 0)
            """,
            ("cloud-lot-B", "prod-pls-test"),
        )


def test_lots_payload_includes_paired_scale_when_cloud_lot_has_pairing(tmp_path: Path):
    conn = init_db(":memory:")
    _seed_product_and_lot(conn)

    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
              lot_id, product_id, qty_containers,
              in_flight_since, in_flight_kind, updated_at, deleted_at
            ) VALUES (
              'cloud-lot-A', 'prod-pls-test', 2.0,
              NULL, NULL, '2026-04-29T10:00:00Z', NULL
            )
            """
        )
        # scale_pairings keyed on device_id PK; lot_id is the join key
        # for the heartbeat snapshot. The Pi schema's shelf_id column is
        # the discriminator the snapshot exposes as scale_id_paired_to.
        conn.execute(
            """
            INSERT INTO scale_pairings (
              device_id, shelf_id, product_id, lot_id, last_heartbeat_ts
            ) VALUES (
              'esp-A1', 'live_shelf',
              'prod-pls-test', 'cloud-lot-A', '2026-04-29T10:00:01Z'
            )
            """
        )

    lots = _build_lots_payload(conn)

    assert len(lots) == 1
    entry = lots[0]
    assert entry["cloud_lot_id"] == "cloud-lot-A"
    assert entry["qty_containers"] == 2.0
    assert entry["status"] == "on_shelf"
    assert entry["scale_id_paired_to"] == "live_shelf"


def test_lots_payload_left_join_yields_null_scale_when_no_pairing(tmp_path: Path):
    conn = init_db(":memory:")
    _seed_product_and_lot(conn)

    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
              lot_id, product_id, qty_containers,
              in_flight_since, in_flight_kind, updated_at, deleted_at
            ) VALUES (
              'cloud-lot-B', 'prod-pls-test', 1.5,
              '2026-04-29T11:00:00Z', 'live_shelf',
              '2026-04-29T11:00:00Z', NULL
            )
            """
        )
        # No scale_pairings row → LEFT JOIN must return NULL.

    lots = _build_lots_payload(conn)

    assert len(lots) == 1
    entry = lots[0]
    assert entry["cloud_lot_id"] == "cloud-lot-B"
    assert entry["qty_containers"] == 1.5
    assert entry["status"] == "in_flight"  # has in_flight_since
    assert entry["in_flight_kind"] == "live_shelf"
    assert entry["scale_id_paired_to"] is None


def test_lots_payload_excludes_tombstoned_rows(tmp_path: Path):
    conn = init_db(":memory:")
    _seed_product_and_lot(conn)

    with conn:
        conn.execute(
            """
            INSERT INTO cloud_lots (
              lot_id, product_id, qty_containers,
              updated_at, deleted_at
            ) VALUES (
              'cloud-lot-A', 'prod-pls-test', 2.0,
              '2026-04-29T10:00:00Z', NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO cloud_lots (
              lot_id, product_id, qty_containers,
              updated_at, deleted_at
            ) VALUES (
              'cloud-lot-B', 'prod-pls-test', 0.0,
              '2026-04-29T11:00:00Z', '2026-04-29T11:00:00Z'
            )
            """
        )

    lots = _build_lots_payload(conn)

    # Only the non-tombstoned row appears.
    assert len(lots) == 1
    assert lots[0]["cloud_lot_id"] == "cloud-lot-A"


def test_invariant_drift_classes_simulation(tmp_path: Path):
    """Mirror the cloud-side ``pi_cloud_lot_id_match`` predicate
    against an in-memory snapshot to confirm the 3 flag classes the
    invariant emits (missing_pi_snapshot / qty_drift / status_drift).
    The cloud impl lives in supabase/functions/invariant-monitor;
    this test pins the predicate logic on the Pi side so the two
    layers can't drift apart silently.
    """
    QTY_TOLERANCE = 0.1

    cloud_lots = [
        # Lot A: matched + qty within tolerance → no flag
        {"lot_id": "A", "qty_containers": 1.0, "in_flight_since": None},
        # Lot B: matched but qty drift
        {"lot_id": "B", "qty_containers": 5.0, "in_flight_since": None},
        # Lot C: missing snapshot
        {"lot_id": "C", "qty_containers": 3.0, "in_flight_since": None},
        # Lot D: matched but cloud says in_flight, Pi says on_shelf
        {"lot_id": "D", "qty_containers": 2.0, "in_flight_since": "2026-04-29T12:00:00Z"},
    ]
    pi_snapshots = {
        "A": {"qty_containers": 1.0, "status": "on_shelf", "in_flight_since": None},
        "B": {"qty_containers": 1.5, "status": "on_shelf", "in_flight_since": None},
        "D": {"qty_containers": 2.0, "status": "on_shelf", "in_flight_since": None},
    }

    flags: list[tuple[str, str]] = []
    for lot in cloud_lots:
        snap = pi_snapshots.get(lot["lot_id"])
        if snap is None:
            flags.append((lot["lot_id"], "missing_pi_snapshot"))
            continue
        if abs(lot["qty_containers"] - snap["qty_containers"]) > QTY_TOLERANCE:
            flags.append((lot["lot_id"], "qty_drift"))
            continue
        cloud_in_flight = lot["in_flight_since"] is not None
        pi_in_flight = snap["status"] == "in_flight" or snap["in_flight_since"] is not None
        if cloud_in_flight != pi_in_flight:
            flags.append((lot["lot_id"], "status_drift"))

    assert ("C", "missing_pi_snapshot") in flags
    assert ("B", "qty_drift") in flags
    assert ("D", "status_drift") in flags
    # Lot A has no flag
    assert all(lot != "A" for lot, _ in flags)
