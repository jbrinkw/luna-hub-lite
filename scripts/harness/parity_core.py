"""Shared parity engine -- imported by parity_assert.py and parity_export.py.

Contains TABLE_PAIRS (schema map), data types (FieldPair, TablePair,
FieldDelta), and engine helpers (diff_pair, _read_pi_rows, _read_cloud_rows,
_net_weight_lookup, assert_catch_all_namespace_invariant).

NEGATIVE-TWIN-PROOF:
  Remove FieldPair("current_weight_g", "qty_containers") from
  TABLE_PAIRS[stock_lots].fields -> witness/lot-id-bridge stops detecting
  the seeded mismatch. Verify:
    python3 scripts/harness/parity_assert.py witness/lot-id-bridge
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class FieldPair:
    pi_field: str
    cloud_field: str
    coerce: str = "identity"  # "identity" | "g_to_ctn" | "weight_grams"

    def coerce_pi(self, v: Any, *, net_weight_g: float | None = None) -> Any:
        if v is None:
            return None
        if self.coerce == "identity":
            return v
        if self.coerce == "g_to_ctn":
            if net_weight_g is None or net_weight_g <= 0:
                return None
            return round(float(v) / float(net_weight_g), 3)
        if self.coerce == "weight_grams":
            return round(float(v), 3)
        raise ValueError(f"Unknown coerce mode: {self.coerce}")


@dataclass(frozen=True)
class TablePair:
    name: str
    pi_table: str
    cloud_table: str
    key_pi: tuple[str, ...]
    key_cloud: tuple[str, ...]
    fields: tuple[FieldPair, ...]


TABLE_PAIRS: tuple[TablePair, ...] = (
    TablePair(
        name="products",
        pi_table="products",
        cloud_table="chefbyte.products",
        key_pi=("product_id",),
        key_cloud=("product_id",),
        fields=(
            FieldPair("name", "name"),
            FieldPair("brand", "brand"),
            FieldPair("net_weight_g", "net_weight_g", coerce="weight_grams"),
            FieldPair("servings_per_container", "servings_per_container"),
            FieldPair("calories_per_serving", "calories_per_serving"),
            FieldPair("certified", "certified"),
            FieldPair("deleted_at", "deleted_at"),
        ),
    ),
    TablePair(
        name="stock_lots",
        pi_table="lots",
        cloud_table="chefbyte.stock_lots",
        key_pi=("lot_id",),
        key_cloud=("lot_id",),
        fields=(
            FieldPair("current_weight_g", "qty_containers", coerce="g_to_ctn"),
            FieldPair("status", "status"),
        ),
    ),
    TablePair(
        name="scale_pairings",
        pi_table="scale_pairings",
        cloud_table="chefbyte.scale_pairings",
        key_pi=("device_id",),
        key_cloud=("device_id",),
        fields=(
            FieldPair("product_id", "product_id"),
            FieldPair("lot_id", "lot_id"),
            FieldPair("shelf_id", "kind"),
        ),
    ),
    TablePair(
        name="food_logs",
        pi_table="usage_log",
        cloud_table="chefbyte.food_logs",
        key_pi=("usage_id",),
        key_cloud=("food_log_id",),
        fields=(
            FieldPair("product_id", "product_id"),
            FieldPair("consumed_g", "consumed_g", coerce="weight_grams"),
            FieldPair("kind", "usage_kind"),
        ),
    ),
    TablePair(
        name="review_queue",
        pi_table="review_queue",
        cloud_table="chefbyte.review_queue",
        key_pi=("review_id",),
        key_cloud=("review_id",),
        fields=(
            FieldPair("kind", "kind"),
            FieldPair("status", "status"),
        ),
    ),
)


@dataclass
class FieldDelta:
    table: str
    key: dict[str, Any]
    field: str
    pi_value: Any
    cloud_value: Any
    description: str

    def as_dict(self) -> dict:
        return asdict(self)


def _read_pi_rows(conn: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
    cur = conn.cursor()
    try:
        cur.execute(f"SELECT * FROM {table}")
    except sqlite3.OperationalError:
        return []
    return cur.fetchall()


def _read_cloud_rows(conn: Any, table: str) -> list[dict]:
    if conn is None:
        return []
    if isinstance(conn, sqlite3.Connection):
        munged = table.replace(".", "_")
        cur = conn.cursor()
        try:
            cur.execute(f"SELECT * FROM {munged}")
        except sqlite3.OperationalError:
            return []
        return [dict(r) for r in cur.fetchall()]
    with conn.cursor() as cur:
        cur.execute(f"SELECT * FROM {table}")
        cols = [c.name for c in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def _net_weight_lookup(pi_conn: sqlite3.Connection) -> dict[str, float]:
    out: dict[str, float] = {}
    for r in _read_pi_rows(pi_conn, "products"):
        if r["net_weight_g"] is not None:
            out[r["product_id"]] = float(r["net_weight_g"])
    return out


def diff_pair(
    pair: TablePair,
    pi_conn: sqlite3.Connection,
    cloud_conn: Any,
    *,
    net_weight_by_pid: dict[str, float],
) -> list[FieldDelta]:
    pi_rows = _read_pi_rows(pi_conn, pair.pi_table)
    cloud_rows = _read_cloud_rows(cloud_conn, pair.cloud_table)
    pi_index: dict[tuple, sqlite3.Row] = {
        tuple(r[k] for k in pair.key_pi): r for r in pi_rows
    }
    cloud_index: dict[tuple, dict] = {
        tuple(r[k] for k in pair.key_cloud): r for r in cloud_rows
    }
    deltas: list[FieldDelta] = []
    for key, pi_row in sorted(
        pi_index.items(), key=lambda kv: tuple(str(x) for x in kv[0])
    ):
        if key not in cloud_index:
            deltas.append(FieldDelta(
                table=pair.name,
                key={pair.key_pi[i]: key[i] for i in range(len(key))},
                field="<row>",
                pi_value="present",
                cloud_value="absent",
                description="row exists on Pi but not in cloud",
            ))
            continue
        cloud_row = cloud_index[key]
        nw = None
        if "product_id" in pi_row.keys():
            nw = net_weight_by_pid.get(pi_row["product_id"])
        for fp in pair.fields:
            pi_v_raw = pi_row[fp.pi_field] if fp.pi_field in pi_row.keys() else None
            cloud_v_raw = cloud_row.get(fp.cloud_field)
            pi_v = fp.coerce_pi(pi_v_raw, net_weight_g=nw)
            if pi_v != cloud_v_raw:
                if (
                    isinstance(pi_v, (int, float))
                    and isinstance(cloud_v_raw, (int, float))
                    and abs(float(pi_v) - float(cloud_v_raw)) < 1e-3
                ):
                    continue
                deltas.append(FieldDelta(
                    table=pair.name,
                    key={pair.key_pi[i]: key[i] for i in range(len(key))},
                    field=fp.pi_field,
                    pi_value=pi_v,
                    cloud_value=cloud_v_raw,
                    description=(
                        f"Pi `{fp.pi_field}` ({pi_v_raw!r} via {fp.coerce}) "
                        f"!= cloud `{fp.cloud_field}` ({cloud_v_raw!r})"
                    ),
                ))
    for key in sorted(
        set(cloud_index) - set(pi_index),
        key=lambda x: tuple(str(v) for v in x),
    ):
        deltas.append(FieldDelta(
            table=pair.name,
            key={pair.key_cloud[i]: key[i] for i in range(len(key))},
            field="<row>",
            pi_value="absent",
            cloud_value="present",
            description="row exists in cloud but not on Pi",
        ))
    return deltas


def assert_catch_all_namespace_invariant(
    pi_conn: sqlite3.Connection,
    cloud_conn: Any,
) -> list[FieldDelta]:
    """Return a FieldDelta for every cloud_lots.lot_id found as product_id
    in cloud stock_lots. Empty list = correct operation."""
    cloud_lots_pi_rows = _read_pi_rows(pi_conn, "cloud_lots")
    if not cloud_lots_pi_rows:
        return []
    cloud_stock_rows = _read_cloud_rows(cloud_conn, "chefbyte.stock_lots")
    cloud_product_ids: set[str] = set()
    for r in cloud_stock_rows:
        pid = r.get("product_id") if isinstance(r, dict) else r["product_id"]
        if pid is not None:
            cloud_product_ids.add(str(pid))
    deltas: list[FieldDelta] = []
    for row in cloud_lots_pi_rows:
        lot_id = str(row["lot_id"])
        product_id = str(row["product_id"]) if row["product_id"] is not None else None
        if lot_id in cloud_product_ids:
            deltas.append(FieldDelta(
                table="catch_all_namespace",
                key={"lot_id": lot_id},
                field="product_id",
                pi_value=lot_id,
                cloud_value=f"product_id={product_id}",
                description=(
                    f"cloud_lots.lot_id={lot_id!r} appears as product_id in "
                    "cloud stock_lots -- lot_id/product_id UUID namespace conflation "
                    "(2026-04-29 regression)."
                ),
            ))
    return deltas
