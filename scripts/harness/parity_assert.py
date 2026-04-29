#!/usr/bin/env python3
"""Pi <-> Cloud parity assertion (lens L2).

Drives a fixture seed against both the Pi-local SQLite database and
the cloud Postgres, runs the named scenario hook, then DIFFs shared
fields per table-pair. Catches the class of bug that produced the
"160.4 g Pi vs 1.6 ctn cloud" sync gap.

Usage::

    python3 scripts/harness/parity_assert.py <scenario>
    python3 scripts/harness/parity_assert.py --list
    python3 scripts/harness/parity_assert.py self-test    # smoke

Output: ``.verify/parity_assert.json`` + a markdown delta report.

The script is split into two layers:

* **Schema map** — declares table-pairs + shared-field mappings. This
  is the data the audit reviewer cares about; extending it adds
  coverage. Each entry maps Pi-side ``(table, columns)`` -> Cloud-side
  ``(table, columns)`` with optional value coercers (``g`` -> ``ctn``).

* **Engine** — fixture seed + scenario callback + diff runner. Each
  scenario is a callable ``(pi_conn, cloud_conn, ctx)`` -> None. The
  built-in ``self-test`` scenario seeds a deliberately-asymmetric
  product fixture and verifies the diff engine reports it.

Connections
-----------
By default the engine connects to the same endpoints the harness uses
(``HARNESS_DB_URL`` env var for Postgres). When neither a real Pi DB
nor a real cloud DB is available, ``self-test`` runs in pure-SQLite
sandbox mode by spinning up an in-memory mock cloud (a second SQLite
DB with the cloud column shape) — this is what CI exercises.

Running the engine end-to-end against the real harness loop is wired
through the existing scenario orchestrator; this CLI is the
out-of-orchestrator entrypoint that lets a developer reproduce a
diff in isolation.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[2]
ARTIFACT_DIR = REPO_ROOT / ".verify"
ARTIFACT = ARTIFACT_DIR / "parity_assert.json"
ARTIFACT_MD = ARTIFACT_DIR / "parity_assert.md"


# ---------------------------------------------------------------------------
# Schema map. Extend as more parity contracts come online.
# ---------------------------------------------------------------------------


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
                return None  # ambiguous; downstream treats as "skip"
            return round(float(v) / float(net_weight_g), 3)
        if self.coerce == "weight_grams":
            return round(float(v), 3)
        raise ValueError(f"Unknown coerce mode: {self.coerce}")


@dataclass(frozen=True)
class TablePair:
    name: str  # logical name for the report
    pi_table: str
    cloud_table: str
    key_pi: tuple[str, ...]
    key_cloud: tuple[str, ...]
    fields: tuple[FieldPair, ...]


# Pi tables on the left, cloud tables on the right. Every field MUST
# appear in both schemas — the test cross-references the actual
# columns. Add new pairs as parity surfaces are claimed by the audit.

# ---------------------------------------------------------------------------
# Invariant: catch-all namespace isolation.
# ---------------------------------------------------------------------------
#
# The catch-all pool builder keys candidates by *cloud lot_id*, so the
# classifier's ``item_id`` for a catch-all event IS a cloud ``lot_id``.
# ``_dispatch_catch_all_add`` must translate that lot_id → product_id via
# the ``cloud_lots`` mirror BEFORE building the emit payload.  If it ever
# passes the raw ``item_id`` (= lot_id) to the emitter as ``product_id``,
# the cloud ``apply_shelf_event`` RPC will return applied=false
# ("product not found").
#
# Invariant (2026-04-29 regression):
#   ∀ row r in cloud_lots: r.lot_id ∉ { s.product_id | s ∈ cloud_stock_lots }
#
# If this fires it means one of:
#   (a) The dispatcher sent a lot_id as product_id and the cloud
#       incorrectly stored it — unlikely given server-side validation.
#   (b) The Pi mirror has a row whose lot_id field accidentally contains
#       the same UUID that another lot's product_id uses — a UUID
#       namespace collision worth investigating.
#
# The invariant is cheap (two in-memory sets) and runs as part of the
# normal _run engine alongside the diff-pair checks.


def assert_catch_all_namespace_invariant(
    pi_conn: sqlite3.Connection,
    cloud_conn: Any,
) -> list["FieldDelta"]:
    """Return a FieldDelta for every cloud_lots.lot_id found as a
    product_id in cloud stock_lots.

    In correct operation this list is ALWAYS empty.  A non-empty result
    means a lot_id was used where a product_id was expected — the bug
    class from 2026-04-29.

    Works in both sandbox mode (sqlite cloud_conn) and real-Postgres mode.
    """
    # Read Pi cloud_lots mirror rows (lot_id, product_id).
    cloud_lots_pi_rows = _read_pi_rows(pi_conn, "cloud_lots")
    if not cloud_lots_pi_rows:
        return []

    # Read cloud stock_lots (lot_id, product_id).
    cloud_stock_rows = _read_cloud_rows(cloud_conn, "chefbyte.stock_lots")

    # Build set of product_ids that appear in cloud stock_lots.
    cloud_product_ids: set[str] = set()
    for r in cloud_stock_rows:
        pid = r.get("product_id") if isinstance(r, dict) else r["product_id"]
        if pid is not None:
            cloud_product_ids.add(str(pid))

    deltas: list["FieldDelta"] = []
    for row in cloud_lots_pi_rows:
        lot_id = str(row["lot_id"])
        product_id = str(row["product_id"]) if row["product_id"] is not None else None
        if lot_id in cloud_product_ids:
            deltas.append(
                FieldDelta(
                    table="catch_all_namespace",
                    key={"lot_id": lot_id},
                    field="product_id",
                    pi_value=lot_id,
                    cloud_value=f"product_id={product_id}",
                    description=(
                        f"cloud_lots.lot_id={lot_id!r} appears as a product_id in "
                        "cloud stock_lots — lot_id/product_id UUID namespace conflation "
                        "(2026-04-29 regression). The catch-all dispatcher must extract "
                        "product_id from cloud_lots.product_id, NOT pass the lot_id."
                    ),
                )
            )
    return deltas


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
            # Pi tracks weight; cloud tracks containers. The coercer
            # converts the Pi weight to "ctn" via the linked product's
            # net_weight_g — the canonical formula the live-shelf
            # cloud-sync uses.
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
            FieldPair("shelf_id", "kind"),  # Pi calls it shelf_id; cloud calls it kind
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


# ---------------------------------------------------------------------------
# Diff engine
# ---------------------------------------------------------------------------


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


def _read_cloud_rows(conn, table: str) -> list[dict]:
    if conn is None:
        return []
    if isinstance(conn, sqlite3.Connection):
        # Sandbox mode: cloud tables live in a separate sqlite DB, with
        # the table name munged ("chefbyte.products" -> "chefbyte_products").
        munged = table.replace(".", "_")
        cur = conn.cursor()
        try:
            cur.execute(f"SELECT * FROM {munged}")
        except sqlite3.OperationalError:
            return []
        return [dict(r) for r in cur.fetchall()]
    # Real psycopg2 connection.
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
    """Return per-field deltas for ``pair``."""
    pi_rows = _read_pi_rows(pi_conn, pair.pi_table)
    cloud_rows = _read_cloud_rows(cloud_conn, pair.cloud_table)
    pi_index: dict[tuple, sqlite3.Row] = {
        tuple(r[k] for k in pair.key_pi): r for r in pi_rows
    }
    cloud_index: dict[tuple, dict] = {
        tuple(r[k] for k in pair.key_cloud): r for r in cloud_rows
    }
    deltas: list[FieldDelta] = []
    for key, pi_row in sorted(pi_index.items(), key=lambda kv: tuple(str(x) for x in kv[0])):
        if key not in cloud_index:
            deltas.append(
                FieldDelta(
                    table=pair.name,
                    key={pair.key_pi[i]: key[i] for i in range(len(key))},
                    field="<row>",
                    pi_value="present",
                    cloud_value="absent",
                    description="row exists on Pi but not in cloud",
                )
            )
            continue
        cloud_row = cloud_index[key]
        # net_weight_g for g_to_ctn coercion: prefer the Pi row's own
        # product_id (lots have it directly).
        nw = None
        if "product_id" in pi_row.keys():
            nw = net_weight_by_pid.get(pi_row["product_id"])
        for fp in pair.fields:
            pi_v_raw = pi_row[fp.pi_field] if fp.pi_field in pi_row.keys() else None
            cloud_v_raw = cloud_row.get(fp.cloud_field)
            pi_v = fp.coerce_pi(pi_v_raw, net_weight_g=nw)
            # Cloud values are stored as-is (no coercion — they're the
            # canonical reference units).
            if pi_v != cloud_v_raw:
                # Allow numeric tolerance for float comparisons.
                if (
                    isinstance(pi_v, (int, float))
                    and isinstance(cloud_v_raw, (int, float))
                    and abs(float(pi_v) - float(cloud_v_raw)) < 1e-3
                ):
                    continue
                deltas.append(
                    FieldDelta(
                        table=pair.name,
                        key={pair.key_pi[i]: key[i] for i in range(len(key))},
                        field=fp.pi_field,
                        pi_value=pi_v,
                        cloud_value=cloud_v_raw,
                        description=(
                            f"Pi `{fp.pi_field}` ({pi_v_raw!r} via {fp.coerce}) "
                            f"!= cloud `{fp.cloud_field}` ({cloud_v_raw!r})"
                        ),
                    )
                )
    for key in sorted(set(cloud_index) - set(pi_index), key=lambda x: tuple(str(v) for v in x)):
        deltas.append(
            FieldDelta(
                table=pair.name,
                key={pair.key_cloud[i]: key[i] for i in range(len(key))},
                field="<row>",
                pi_value="absent",
                cloud_value="present",
                description="row exists in cloud but not on Pi",
            )
        )
    return deltas


# ---------------------------------------------------------------------------
# Sandbox: in-memory paired SQLite DBs we use for the self-test.
# ---------------------------------------------------------------------------


def _make_sandbox() -> tuple[sqlite3.Connection, sqlite3.Connection]:
    pi = sqlite3.connect(":memory:")
    pi.row_factory = sqlite3.Row
    pi.executescript(
        """
        CREATE TABLE products (
            product_id TEXT PRIMARY KEY,
            name TEXT, brand TEXT,
            net_weight_g REAL,
            servings_per_container REAL,
            calories_per_serving REAL,
            certified INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE lots (
            lot_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL,
            current_weight_g REAL,
            status TEXT
        );
        CREATE TABLE scale_pairings (
            device_id TEXT PRIMARY KEY,
            shelf_id TEXT,
            product_id TEXT,
            lot_id TEXT
        );
        CREATE TABLE usage_log (
            usage_id TEXT PRIMARY KEY,
            product_id TEXT,
            consumed_g REAL,
            kind TEXT
        );
        CREATE TABLE review_queue (
            review_id TEXT PRIMARY KEY,
            kind TEXT,
            status TEXT
        );
        -- Pi mirror of cloud stock_lots, keyed by cloud lot_id.
        -- Used by the catch_all_namespace invariant.
        CREATE TABLE cloud_lots (
            lot_id TEXT PRIMARY KEY,
            product_id TEXT NOT NULL
        );
        """
    )
    cloud = sqlite3.connect(":memory:")
    cloud.row_factory = sqlite3.Row
    cloud.executescript(
        """
        CREATE TABLE chefbyte_products (
            product_id TEXT PRIMARY KEY,
            name TEXT, brand TEXT,
            net_weight_g REAL,
            servings_per_container REAL,
            calories_per_serving REAL,
            certified INTEGER NOT NULL DEFAULT 0,
            deleted_at TEXT
        );
        CREATE TABLE chefbyte_stock_lots (
            lot_id TEXT PRIMARY KEY,
            product_id TEXT,
            qty_containers REAL,
            status TEXT
        );
        CREATE TABLE chefbyte_scale_pairings (
            device_id TEXT PRIMARY KEY,
            kind TEXT,
            product_id TEXT,
            lot_id TEXT
        );
        CREATE TABLE chefbyte_food_logs (
            food_log_id TEXT PRIMARY KEY,
            product_id TEXT,
            consumed_g REAL,
            usage_kind TEXT
        );
        CREATE TABLE chefbyte_review_queue (
            review_id TEXT PRIMARY KEY,
            kind TEXT,
            status TEXT
        );
        """
    )
    return pi, cloud


# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------


SCENARIOS: dict[str, Callable[[sqlite3.Connection, Any], None]] = {}


def scenario(name: str) -> Callable:
    def deco(fn: Callable[[sqlite3.Connection, Any], None]) -> Callable:
        SCENARIOS[name] = fn
        return fn
    return deco


@scenario("namespace-invariant")
def _scenario_namespace_invariant(pi_conn: sqlite3.Connection, cloud_conn: Any) -> None:
    """Seed a deliberately conflated fixture: a cloud_lots row whose
    ``lot_id`` appears as a ``product_id`` in cloud stock_lots.

    This simulates the 2026-04-29 regression where the catch-all dispatcher
    passed the classifier's ``item_id`` (= cloud lot_id) directly as
    ``product_id`` to ``emit_catch_all_first_measurement``.

    The invariant check MUST flag this — exit code 1 is the correct outcome
    when running this scenario, just as exit 1 is correct for ``self-test``.
    """
    # Three deliberately distinct UUIDs (mirrors test_catch_all_state_machine.py).
    CLOUD_LOT_UUID    = "cccccccc-0000-0000-0000-000000000003"
    CLOUD_PRODUCT_UUID = "bbbbbbbb-0000-0000-0000-000000000002"

    # Pi cloud_lots mirror: lot_id=CLOUD_LOT_UUID, product_id=CLOUD_PRODUCT_UUID.
    pi_conn.execute(
        "INSERT INTO cloud_lots(lot_id, product_id) VALUES (?, ?)",
        (CLOUD_LOT_UUID, CLOUD_PRODUCT_UUID),
    )
    pi_conn.commit()

    # Conflated cloud row: product_id == CLOUD_LOT_UUID (the bug — lot_id
    # was used where product_id was expected).
    if isinstance(cloud_conn, sqlite3.Connection):
        cloud_conn.execute(
            "INSERT INTO chefbyte_stock_lots(lot_id, product_id, qty_containers, status) "
            "VALUES (?, ?, ?, ?)",
            ("lot-cloud-1", CLOUD_LOT_UUID, 0.5, "on_shelf"),
        )
        cloud_conn.commit()
    # For real Postgres we don't mutate production data — the invariant
    # relies on the Pi mirror having a lot_id that matches a cloud product_id,
    # which would only happen if a real conflation event had occurred.


@scenario("self-test")
def _scenario_self_test(pi_conn: sqlite3.Connection, cloud_conn: Any) -> None:
    """Seed an asymmetric product fixture and let diff_pair flag it.

    Designed so the engine reports >=1 finding when wiring is correct.
    Used by the meta-test to assert the engine catches a real drift,
    not just absence of data.
    """
    pi_conn.execute(
        "INSERT INTO products(product_id, name, net_weight_g, certified, "
        "                     servings_per_container, calories_per_serving) "
        "VALUES ('p1','Chicken Thigh', 500.0, 1, 4.0, 200.0)"
    )
    pi_conn.execute(
        "INSERT INTO lots(lot_id, product_id, current_weight_g, status) "
        "VALUES ('lot1','p1', 250.0, 'on_shelf')"
    )
    pi_conn.commit()

    # Cloud has a SLIGHTLY different value for net_weight_g on the
    # SAME product — this mirrors the bug class L10 catches.
    cloud_conn.execute(
        "INSERT INTO chefbyte_products(product_id, name, net_weight_g, certified, "
        "                              servings_per_container, calories_per_serving) "
        "VALUES ('p1','Chicken Thigh', 510.0, 1, 4.0, 200.0)"
    )
    # And the cloud lot reflects the wrong qty_containers (the famous
    # 1.6-ctn-vs-160.4-g style bug — cloud says 0.4 ctn, Pi math says
    # 250/500 = 0.5 ctn).
    cloud_conn.execute(
        "INSERT INTO chefbyte_stock_lots(lot_id, product_id, qty_containers, status) "
        "VALUES ('lot1','p1', 0.4, 'on_shelf')"
    )
    cloud_conn.commit()


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def _run(scenario_name: str, sandbox: bool, *, quiet: bool = False) -> int:
    if scenario_name not in SCENARIOS:
        print(
            f"unknown scenario: {scenario_name!r}\navailable: {sorted(SCENARIOS)}",
            file=sys.stderr,
        )
        return 2

    if sandbox:
        pi_conn, cloud_conn = _make_sandbox()
    else:
        # Real-mode connections — only available when the harness is up.
        pi_db = os.environ.get("HARNESS_PI_DB", "")
        if not pi_db:
            print("HARNESS_PI_DB env var required for non-sandbox mode", file=sys.stderr)
            return 2
        pi_conn = sqlite3.connect(pi_db)
        pi_conn.row_factory = sqlite3.Row
        try:
            import psycopg2
            import psycopg2.extras  # noqa: F401
        except ImportError:
            print("psycopg2 not available — falling back to sandbox", file=sys.stderr)
            return 2
        dsn = os.environ.get(
            "HARNESS_DB_URL",
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        )
        cloud_conn = psycopg2.connect(dsn)

    SCENARIOS[scenario_name](pi_conn, cloud_conn)

    nw = _net_weight_lookup(pi_conn)
    deltas: list[FieldDelta] = []
    per_table: dict[str, list[FieldDelta]] = {}
    for pair in TABLE_PAIRS:
        pair_deltas = diff_pair(pair, pi_conn, cloud_conn, net_weight_by_pid=nw)
        per_table[pair.name] = pair_deltas
        deltas.extend(pair_deltas)

    # Catch-all namespace invariant: lot_id must never appear as product_id.
    ns_deltas = assert_catch_all_namespace_invariant(pi_conn, cloud_conn)
    per_table["catch_all_namespace"] = ns_deltas
    deltas.extend(ns_deltas)

    deltas.sort(key=lambda d: (d.table, json.dumps(d.key, sort_keys=True), d.field))

    artifact = {
        "gate": "parity_assert",
        "lens": "L2",
        "scenario": scenario_name,
        "ok": not deltas,
        "stats": {
            "table_pairs": len(TABLE_PAIRS),
            "deltas_total": len(deltas),
            "by_table": {t: len(v) for t, v in sorted(per_table.items())},
        },
        "findings": [d.as_dict() for d in deltas],
    }

    ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)
    ARTIFACT.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    md_lines = [
        f"# Parity Assert (Lens L2) — `{scenario_name}`",
        "",
        f"Total deltas: **{len(deltas)}**",
        "",
    ]
    for tname in sorted(per_table):
        td = per_table[tname]
        md_lines.append(f"## `{tname}` ({len(td)})")
        if not td:
            md_lines.append("- _no deltas_")
            md_lines.append("")
            continue
        for d in td:
            md_lines.append(
                f"- key={json.dumps(d.key, sort_keys=True)} field=`{d.field}` "
                f"pi=`{d.pi_value}` cloud=`{d.cloud_value}` — {d.description}"
            )
        md_lines.append("")
    ARTIFACT_MD.write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    if not quiet:
        print(json.dumps(artifact["stats"], indent=2, sort_keys=True))
        print(f"Wrote {ARTIFACT.relative_to(REPO_ROOT)} ({len(deltas)} deltas)")

    return 0 if not deltas else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="parity-assert", description=__doc__)
    ap.add_argument("scenario", nargs="?", default=None)
    ap.add_argument("--list", action="store_true", help="List scenarios")
    ap.add_argument(
        "--sandbox",
        action="store_true",
        help="Use in-memory SQLite sandbox (default for self-test)",
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    if args.list:
        for s in sorted(SCENARIOS):
            print(s)
        return 0
    if not args.scenario:
        ap.error("scenario name required (or pass --list)")
    # Both self-test and namespace-invariant are pure-sandbox scenarios:
    # they seed synthetic fixtures and never need a real Pi DB or Postgres.
    sandbox = args.sandbox or args.scenario in ("self-test", "namespace-invariant")
    return _run(args.scenario, sandbox=sandbox, quiet=args.quiet)


if __name__ == "__main__":
    sys.exit(main())
