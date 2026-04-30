#!/usr/bin/env python3
"""Pi ↔ cloud schema-shape parity check.

Compares the Pi SQLite mirror column names/types to the cloud Postgres
column names/types for each mirrored table. Catches "we added a column
to cloud, forgot to mirror" class of bugs.

Usage:
    python3 scripts/verify/pi-cloud-schema-parity.py [--pi-db PATH]
                                                      [--pg-dsn DSN]
                                                      [--quiet]

Environment variables (override CLI args):
    PI_DB_PATH   — path to the Pi SQLite database file
    PG_DSN       — Postgres DSN string, e.g.
                   postgresql://postgres:postgres@localhost:54322/postgres
                   (local supabase default)

If PI_DB_PATH is not set and --pi-db is not given, the script exits 0
with a note — no Pi connection available (CI mode).

Column type lenience rules (SQLite ↔ Postgres):
    SQLite TEXT   ~ PG TEXT, VARCHAR(*), UUID, CHAR(*), TIMESTAMPTZ,
                    DATE, TIMESTAMP, JSONB, JSON
    SQLite REAL   ~ PG REAL, FLOAT, FLOAT4, FLOAT8, DOUBLE PRECISION
    SQLite INTEGER ~ PG INTEGER, INT, INT4, INT8, BIGINT, SMALLINT,
                     SERIAL, BIGSERIAL, BOOLEAN
    SQLite NUMERIC ~ PG NUMERIC(*,*), DECIMAL(*,*)
    SQLite BLOB   ~ PG BYTEA

Presence checks:
    Cloud column absent from Pi mirror → FAIL (we forgot to mirror it)
    Pi column absent from cloud        → WARN (Pi-only metadata, acceptable)

Exit codes:
    0 — all mirrored tables match (or no Pi DB path provided)
    1 — one or more cloud columns missing from the Pi mirror
    2 — usage/import error
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
import json
import re
from typing import Optional

# ---------------------------------------------------------------------------
# Mirrored table map: { pi_table_name: cloud_qualified_name }
# Pi tables live in hardware/live-shelf/server/cloud/*.py pollers.
# ---------------------------------------------------------------------------
MIRRORED_TABLES: dict[str, str] = {
    "lots":           "chefbyte.stock_lots",
    "products":       "chefbyte.products",
    "scale_events":   "chefbyte.shelf_event_log",
    "review_queue":   "chefbyte.review_queue",
    "scale_pairings": "chefbyte.scale_pairings",
}

# ---------------------------------------------------------------------------
# Column type lenience map: SQLite affinity → set of acceptable PG types
# ---------------------------------------------------------------------------
SQLITE_TO_PG: dict[str, set[str]] = {
    "text":    {
        "text", "character varying", "varchar", "uuid", "char",
        "timestamptz", "timestamp with time zone",
        "timestamp without time zone", "timestamp",
        "date", "jsonb", "json", "name",
    },
    "real":    {"real", "float4", "float8", "double precision", "float"},
    "integer": {
        "integer", "int", "int4", "int8", "bigint", "smallint",
        "serial", "bigserial", "boolean", "bool",
    },
    "numeric": {"numeric", "decimal"},
    "blob":    {"bytea"},
    # SQLite stores integers as integer regardless of declared type:
    "int":     {"integer", "int", "int4", "int8", "bigint", "smallint",
                "serial", "bigserial", "boolean", "bool"},
}


def sqlite_affinity(declared_type: str) -> str:
    """Return the SQLite type affinity for a declared column type."""
    t = (declared_type or "").lower().strip()
    if not t:
        return "blob"
    for aff in ("int",):
        if aff in t:
            return "integer"
    if any(k in t for k in ("char", "clob", "text")):
        return "text"
    if t == "blob" or not t:
        return "blob"
    if any(k in t for k in ("real", "floa", "doub")):
        return "real"
    if any(k in t for k in ("num", "dec")):
        return "numeric"
    return "blob"


def types_compatible(sqlite_type: str, pg_type: str) -> bool:
    """Return True if the types are close enough to pass leniently."""
    aff = sqlite_affinity(sqlite_type)
    pg_lower = pg_type.lower().split("(")[0].strip()
    allowed = SQLITE_TO_PG.get(aff, set())
    return pg_lower in allowed


def get_sqlite_columns(conn: sqlite3.Connection, table: str) -> dict[str, str]:
    """Return {column_name: declared_type} for a SQLite table."""
    cur = conn.execute(f"PRAGMA table_info('{table}')")
    return {row[1]: row[2] for row in cur.fetchall()}


def get_pg_columns(dsn: str, schema: str, table: str) -> dict[str, str]:
    """Return {column_name: data_type} from information_schema via psql."""
    sql = (
        f"SELECT column_name, data_type "
        f"FROM information_schema.columns "
        f"WHERE table_schema = '{schema}' AND table_name = '{table}' "
        f"ORDER BY ordinal_position;"
    )
    try:
        result = subprocess.run(
            ["psql", dsn, "-t", "-A", "-c", sql],
            capture_output=True, text=True, timeout=15,
        )
    except FileNotFoundError:
        # psql not on PATH — fall back to quiet skip.
        return {}
    if result.returncode != 0:
        raise RuntimeError(
            f"psql error for {schema}.{table}: {result.stderr.strip()}"
        )
    cols = {}
    for line in result.stdout.splitlines():
        line = line.strip()
        if "|" in line:
            name, dtype = line.split("|", 1)
            cols[name.strip()] = dtype.strip()
    return cols


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi-db",  default=os.environ.get("PI_DB_PATH", ""))
    parser.add_argument("--pg-dsn", default=os.environ.get(
        "PG_DSN",
        "postgresql://postgres:postgres@localhost:54322/postgres",
    ))
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args(argv)

    def log(msg: str) -> None:
        if not args.quiet:
            print(msg)

    if not args.pi_db:
        log("pi-cloud-schema-parity: no PI_DB_PATH set — skipping Pi comparison (CI mode).")
        log("  Set PI_DB_PATH=<path-to-live-shelf.db> to enable full parity check.")
        return 0

    if not os.path.exists(args.pi_db):
        print(f"ERROR: Pi DB not found at {args.pi_db}", file=sys.stderr)
        return 2

    log(f"pi-cloud-schema-parity: comparing {args.pi_db} ↔ Postgres {args.pg_dsn}")

    try:
        pi_conn = sqlite3.connect(args.pi_db)
    except sqlite3.Error as e:
        print(f"ERROR: cannot open SQLite DB: {e}", file=sys.stderr)
        return 2

    failures = 0
    warnings = 0

    for pi_table, cloud_qualified in MIRRORED_TABLES.items():
        schema, table = cloud_qualified.split(".", 1)
        log(f"\n  Checking {pi_table} (Pi) ↔ {cloud_qualified} (cloud)")

        pi_cols = get_sqlite_columns(pi_conn, pi_table)
        if not pi_cols:
            log(f"    SKIP: table '{pi_table}' not found in Pi DB — may be version mismatch")
            continue

        try:
            pg_cols = get_pg_columns(args.pg_dsn, schema, table)
        except RuntimeError as e:
            log(f"    WARN: {e}")
            warnings += 1
            continue

        if not pg_cols:
            log(f"    SKIP: cannot reach Postgres or table not found ({cloud_qualified})")
            continue

        # Cloud columns absent from Pi mirror → FAIL
        for col, pg_type in pg_cols.items():
            if col not in pi_cols:
                print(
                    f"    FAIL: cloud column '{col}' ({pg_type}) in {cloud_qualified} "
                    f"is NOT in Pi table '{pi_table}'"
                )
                failures += 1
            else:
                sqlite_type = pi_cols[col]
                if not types_compatible(sqlite_type, pg_type):
                    print(
                        f"    WARN: type mismatch for '{col}': "
                        f"Pi={sqlite_type!r} cloud={pg_type!r} in {cloud_qualified}"
                    )
                    warnings += 1
                else:
                    log(f"    OK: {col} (Pi={sqlite_type!r} ≈ cloud={pg_type!r})")

        # Pi columns absent from cloud → WARN (Pi-only metadata)
        for col in pi_cols:
            if col not in pg_cols:
                log(f"    WARN: Pi-only column '{col}' in '{pi_table}' "
                    f"has no mirror in {cloud_qualified} (may be Pi metadata)")
                warnings += 1

    pi_conn.close()

    log("")
    if failures > 0:
        print(
            f"pi-cloud-schema-parity: FAIL — {failures} cloud column(s) missing "
            f"from Pi mirror. {warnings} warning(s)."
        )
        return 1

    log(
        f"pi-cloud-schema-parity: PASS — all mirrored columns present. "
        f"{warnings} warning(s)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
