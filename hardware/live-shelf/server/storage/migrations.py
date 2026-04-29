"""Schema bootstrap.

`apply_migrations(conn)` reads `schema.sql` and applies it in a single
transaction — but only if the core tables do not yet exist. Running it a
second time against the same DB is a no-op.

Kept intentionally tiny: the demo does not need a full-blown migration
framework. If the schema ever changes, add a numbered file here and a
`schema_version` table lookup.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

log = logging.getLogger(__name__)

_SCHEMA_PATH = Path(__file__).with_name("schema.sql")

# All tables declared in schema.sql. If any of these is missing we treat the
# DB as fresh and apply the schema; otherwise we leave it alone.
_CORE_TABLES = (
    "products",
    "product_reference_images",
    "lots",
    "sessions",
    "scale_events",
    "session_resolutions",
    "review_queue",
    "app_state",
)


def _existing_tables(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {r[0] for r in rows}


def _apply_column_additions(conn: sqlite3.Connection) -> None:
    """Idempotent ALTER TABLE additions for schema evolutions that need to
    reach DBs which were already initialized before the column existed.

    Mirrors the tiny-by-design philosophy above: no version table, just
    ``PRAGMA table_info`` probes followed by an ``ADD COLUMN`` when the
    column is missing. Safe to call on every open. New columns should be
    nullable or carry a DEFAULT so existing rows remain valid.
    """
    # In-flight tracker column additions on ``lots`` (IN_FLIGHT_TRACKER_PLAN.md §3.1).
    with conn:
        lot_cols = [r[1] for r in conn.execute("PRAGMA table_info(lots)")]
        if "in_flight_since" not in lot_cols:
            conn.execute("ALTER TABLE lots ADD COLUMN in_flight_since TEXT")
        if "pickup_weight_g" not in lot_cols:
            conn.execute("ALTER TABLE lots ADD COLUMN pickup_weight_g REAL")
        if "pickup_event_id" not in lot_cols:
            conn.execute("ALTER TABLE lots ADD COLUMN pickup_event_id TEXT")
        if "pickup_session_id" not in lot_cols:
            conn.execute("ALTER TABLE lots ADD COLUMN pickup_session_id TEXT")
        # Catch-all tracker: shelf discriminator (CATCH_ALL_SCALE_PLAN.md §4.1).
        # ALTER TABLE ADD COLUMN can't include a CHECK, so the CHECK is
        # applied in the rebuild block further down. The DEFAULT backfills
        # every existing row to 'live_shelf'.
        if "shelf_id" not in lot_cols:
            conn.execute(
                "ALTER TABLE lots ADD COLUMN shelf_id TEXT NOT NULL "
                "DEFAULT 'live_shelf'"
            )
        # Index for the sweeper's TTL reaper scan.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lots_in_flight_since "
            "ON lots(in_flight_since)"
        )
        # Per-shelf registry query: common lookup on (shelf_id, status).
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_lots_shelf_status "
            "ON lots(shelf_id, status)"
        )

    # Sessions + scale_events: add shelf_id column (CATCH_ALL_SCALE_PLAN.md §4.1).
    # Like lots, the CHECK is applied via the rebuild block. ADD COLUMN
    # with a DEFAULT back-fills existing rows to 'live_shelf'.
    with conn:
        sess_cols = [r[1] for r in conn.execute("PRAGMA table_info(sessions)")]
        if "shelf_id" not in sess_cols:
            conn.execute(
                "ALTER TABLE sessions ADD COLUMN shelf_id TEXT NOT NULL "
                "DEFAULT 'live_shelf'"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_shelf ON sessions(shelf_id)"
        )

    with conn:
        se_cols = [r[1] for r in conn.execute("PRAGMA table_info(scale_events)")]
        if "shelf_id" not in se_cols:
            conn.execute(
                "ALTER TABLE scale_events ADD COLUMN shelf_id TEXT NOT NULL "
                "DEFAULT 'live_shelf'"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scale_events_shelf "
            "ON scale_events(shelf_id)"
        )

    # App state: per-shelf open-session pointer for the catch-all scale
    # (CATCH_ALL_SCALE_PLAN.md §4.2). Live-shelf stays on
    # current_session_id for backward compat. Guarded by a table-exists
    # check so old test fixtures that don't seed app_state still work.
    with conn:
        as_cols = [r[1] for r in conn.execute("PRAGMA table_info(app_state)")]
        if as_cols and "current_catch_all_session_id" not in as_cols:
            conn.execute(
                "ALTER TABLE app_state ADD COLUMN "
                "current_catch_all_session_id TEXT"
            )

    with conn:
        cols = [
            r[1]
            for r in conn.execute("PRAGMA table_info(scale_events)")
        ]
        if "device_id" not in cols:
            conn.execute("ALTER TABLE scale_events ADD COLUMN device_id TEXT")
        # pi_received_ts — the Pi's wall-clock at event ingress. Authoritative
        # timestamp for frame-lookup, because the ESP's ``ts`` field has a
        # random sub-second component (``millis() % 1000`` at emit time;
        # only the integer seconds come from NTP). All camera frames are
        # timestamped from the Pi's NTP-synced clock, so the picker must
        # cross-reference events into that same clock domain. Without
        # this, two events fired 2s apart on the wall clock can look 0s or
        # 1s apart in ESP ts — and the picker walks back into neighbour-
        # event territory. Old rows pre-migration have NULL here; the
        # handler falls back to ``ts`` for them.
        if "pi_received_ts" not in cols:
            conn.execute(
                "ALTER TABLE scale_events ADD COLUMN pi_received_ts TEXT"
            )

    # Products: macro + description columns. Matches the cloud
    # ``chefbyte.products`` shape so ``upsert_product_from_cloud`` can
    # write-through the fields the cloud /intake edge fn returns without
    # dropping them. Nullable so existing rows stay valid.
    with conn:
        prod_cols = [r[1] for r in conn.execute("PRAGMA table_info(products)")]
        if "calories_per_serving" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN calories_per_serving REAL"
            )
        if "carbs_per_serving" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN carbs_per_serving REAL"
            )
        if "protein_per_serving" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN protein_per_serving REAL"
            )
        if "fat_per_serving" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN fat_per_serving REAL"
            )
        if "description" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN description TEXT"
            )
        # Soft-delete tombstone mirrored from cloud. Nullable, defaults to
        # NULL (live). Hard-deleting the local row would break the lots
        # table's ``product_id REFERENCES products`` FK (no cascade), so
        # we mark + filter in list/candidate queries instead. The cloud
        # poller writes this from the /catalog payload's deleted_at field.
        if "deleted_at" not in prod_cols:
            conn.execute(
                "ALTER TABLE products ADD COLUMN deleted_at TEXT"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_products_deleted_at "
            "ON products(deleted_at)"
        )

    # Usage log (USAGE_LOG_PLAN.md §3). Long-lived DBs predate this table.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS usage_log (
              usage_id            TEXT PRIMARY KEY,
              lot_id              TEXT,
              product_id          TEXT NOT NULL,
              product_name        TEXT NOT NULL,
              product_brand       TEXT,
              container_type      TEXT,
              consumed_g          REAL NOT NULL,
              pickup_weight_g     REAL,
              return_weight_g     REAL,
              kind                TEXT NOT NULL CHECK(kind IN (
                'in_flight_return',
                'in_flight_ttl_expired',
                'in_flight_replaced_new_item',
                'reconciler_use_return',
                'single_item_consumed'
              )),
              session_id          TEXT,
              pickup_event_id     TEXT,
              return_event_id     TEXT,
              occurred_at         TEXT NOT NULL,
              created_at          TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_log_occurred_at "
            "ON usage_log(occurred_at)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_log_product "
            "ON usage_log(product_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_log_session "
            "ON usage_log(session_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_usage_log_lot "
            "ON usage_log(lot_id)"
        )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_pickup_dedup "
            "ON usage_log(pickup_event_id) WHERE pickup_event_id IS NOT NULL"
        )
    # Usage_log second dedup index — keys on (return_event_id, lot_id, kind)
    # so the self-heal/backfill re-emission path can't slip past the
    # pickup-side guard (UX_AUDIT R2 F2). Existing duplicate rows are
    # consolidated below before creating the unique index, otherwise the
    # CREATE itself would fail on the live DB. See _consolidate_usage_log_dupes.
    _consolidate_usage_log_dupes(conn)
    with conn:
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_return_dedup "
            "ON usage_log(return_event_id, lot_id, kind) "
            "WHERE return_event_id IS NOT NULL"
        )

    # Usage log CHECK rebuild: add 'single_item_consumed' on existing DBs
    # that predate the single-item tracker. Same rebuild-preserving-rows
    # pattern as the lots / sessions / scale_events shelf_id rebuilds.
    ul_ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='usage_log'"
    ).fetchone()
    ul_ddl = (ul_ddl_row[0] if ul_ddl_row else "") or ""
    if ul_ddl_row and "'single_item_consumed'" not in ul_ddl:
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                conn.execute("DROP TABLE IF EXISTS usage_log_new")
                conn.execute(
                    """
                    CREATE TABLE usage_log_new (
                        usage_id            TEXT PRIMARY KEY,
                        lot_id              TEXT,
                        product_id          TEXT NOT NULL,
                        product_name        TEXT NOT NULL,
                        product_brand       TEXT,
                        container_type      TEXT,
                        consumed_g          REAL NOT NULL,
                        pickup_weight_g     REAL,
                        return_weight_g     REAL,
                        kind                TEXT NOT NULL CHECK(kind IN (
                            'in_flight_return',
                            'in_flight_ttl_expired',
                            'in_flight_replaced_new_item',
                            'reconciler_use_return',
                            'single_item_consumed'
                        )),
                        session_id          TEXT,
                        pickup_event_id     TEXT,
                        return_event_id     TEXT,
                        occurred_at         TEXT NOT NULL,
                        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                conn.execute(
                    "INSERT INTO usage_log_new SELECT "
                    "usage_id, lot_id, product_id, product_name, product_brand, "
                    "container_type, consumed_g, pickup_weight_g, return_weight_g, "
                    "kind, session_id, pickup_event_id, return_event_id, "
                    "occurred_at, created_at FROM usage_log"
                )
                conn.execute("DROP TABLE usage_log")
                conn.execute("ALTER TABLE usage_log_new RENAME TO usage_log")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_usage_log_occurred_at "
                    "ON usage_log(occurred_at)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_usage_log_product "
                    "ON usage_log(product_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_usage_log_session "
                    "ON usage_log(session_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_usage_log_lot "
                    "ON usage_log(lot_id)"
                )
                conn.execute(
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_pickup_dedup "
                    "ON usage_log(pickup_event_id) WHERE pickup_event_id IS NOT NULL"
                )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")
        # Same return-side dedup index installed on the rebuilt
        # table. Consolidate duplicates before creating because
        # SQLite refuses CREATE UNIQUE INDEX when violations exist.
        _consolidate_usage_log_dupes(conn)
        with conn:
            conn.execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_log_return_dedup "
                "ON usage_log(return_event_id, lot_id, kind) "
                "WHERE return_event_id IS NOT NULL"
            )

    # Scale pairings table (single-item tracker). Long-lived DBs predate it.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scale_pairings (
              device_id           TEXT PRIMARY KEY,
              shelf_id            TEXT NOT NULL CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
              product_id          TEXT,
              lot_id              TEXT,
              first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
              last_heartbeat_ts   TEXT,
              notes               TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scale_pairings_shelf "
            "ON scale_pairings(shelf_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scale_pairings_product "
            "ON scale_pairings(product_id)"
        )

        # Drop legacy FK on scale_pairings.lot_id → lots(lot_id) (2026-04-29).
        # Long-lived DBs initially created from schema.sql have:
        #   lot_id TEXT REFERENCES lots(lot_id) ON DELETE SET NULL
        # but live_scale (single_item) lots are NEVER inserted into the Pi's
        # `lots` table — the live_scale event handler emits cloud consumption
        # events directly without lifecycle. When the cloud assigns
        # scale_pairings.lot_id for a live_scale row and the Pi tries to
        # mirror it via pairings_sync_poller, the FK fires and the upsert
        # raises sqlite3.IntegrityError. The Pi's lot_id stays NULL forever
        # and the weight_sync_poller has no way to attribute weight to a
        # cloud lot.
        #
        # Fix: rebuild scale_pairings without the FK on lot_id. The
        # device_id PK + shelf_id CHECK + indexes are preserved.
        sp_ddl_row = conn.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type='table' AND name='scale_pairings'"
        ).fetchone()
        sp_ddl = (sp_ddl_row[0] or "") if sp_ddl_row else ""
        if "REFERENCES lots(lot_id)" in sp_ddl:
            conn.execute("PRAGMA foreign_keys = OFF")
            try:
                conn.execute("DROP TABLE IF EXISTS scale_pairings_new")
                conn.execute(
                    """
                    CREATE TABLE scale_pairings_new (
                      device_id           TEXT PRIMARY KEY,
                      shelf_id            TEXT NOT NULL CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
                      product_id          TEXT REFERENCES products(product_id) ON DELETE SET NULL,
                      lot_id              TEXT,
                      first_seen_at       TEXT NOT NULL DEFAULT (datetime('now')),
                      last_heartbeat_ts   TEXT,
                      notes               TEXT
                    )
                    """
                )
                conn.execute(
                    """
                    INSERT INTO scale_pairings_new (
                      device_id, shelf_id, product_id, lot_id,
                      first_seen_at, last_heartbeat_ts, notes
                    )
                    SELECT
                      device_id, shelf_id, product_id, lot_id,
                      first_seen_at, last_heartbeat_ts, notes
                      FROM scale_pairings
                    """
                )
                conn.execute("DROP TABLE scale_pairings")
                conn.execute(
                    "ALTER TABLE scale_pairings_new RENAME TO scale_pairings"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_scale_pairings_shelf "
                    "ON scale_pairings(shelf_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_scale_pairings_product "
                    "ON scale_pairings(product_id)"
                )
            finally:
                conn.execute("PRAGMA foreign_keys = ON")

    # Lifecycle observability tables — long-lived DBs predate these.
    # ``CREATE TABLE IF NOT EXISTS`` makes this idempotent. Indexes use
    # the same IF NOT EXISTS pattern.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS event_lifecycle (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              event_id        TEXT NOT NULL,
              ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              actor           TEXT NOT NULL,
              reason_code     TEXT NOT NULL,
              payload_json    TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_event_lifecycle_event "
            "ON event_lifecycle(event_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_event_lifecycle_reason_ts "
            "ON event_lifecycle(reason_code, ts)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS session_lifecycle (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              session_id      TEXT NOT NULL,
              ts              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              actor           TEXT NOT NULL,
              reason_code     TEXT NOT NULL,
              payload_json    TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_lifecycle_session "
            "ON session_lifecycle(session_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_session_lifecycle_reason_ts "
            "ON session_lifecycle(reason_code, ts)"
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS system_health (
              id                       INTEGER PRIMARY KEY AUTOINCREMENT,
              ts                       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              scale_weight_g           REAL,
              pending_events           INTEGER,
              classifying_events       INTEGER,
              failed_events            INTEGER,
              pending_reviews          INTEGER,
              on_shelf_lot_count       INTEGER,
              on_shelf_weight_sum_g    REAL,
              closed_deque_size        INTEGER,
              anthropic_calls_total    INTEGER,
              anthropic_errors_total   INTEGER
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_system_health_ts "
            "ON system_health(ts)"
        )

    # Tare-arm singleton (CATCH_ALL_TARE_CAPTURE_PLAN.md §3). One-row
    # table keyed id=1: at most one product is armed for tare capture
    # at any time. Re-arming on a different product is an
    # INSERT OR REPLACE at id=1. Rows past ``expires_at`` stay in place
    # until the next arm overwrites them or ``clear_stale_tare_arm``
    # runs on startup — the scale-event interceptor consults
    # ``expires_at > now`` so stale rows don't fire.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tare_arm (
              id                 INTEGER PRIMARY KEY CHECK(id = 1),
              product_id         TEXT NOT NULL REFERENCES products(product_id) ON DELETE CASCADE,
              device_id          TEXT NOT NULL DEFAULT 'scale-02',
              armed_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
              expires_at         TEXT NOT NULL,
              min_weight_g       REAL NOT NULL DEFAULT 5.0,
              max_weight_g       REAL NOT NULL DEFAULT 5000.0,
              last_error         TEXT
            )
            """
        )

    # Cloud outbox (PROD_MIGRATION_PLAN.md §Phase 2). Long-lived DBs
    # predate this table — guard with IF NOT EXISTS so we land the
    # table + partial index on existing installs.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_outbox (
              outbox_id             INTEGER PRIMARY KEY AUTOINCREMENT,
              client_event_id       TEXT NOT NULL UNIQUE,
              payload_json          TEXT NOT NULL,
              enqueued_at           TEXT NOT NULL DEFAULT (datetime('now')),
              sent_at               TEXT,
              attempts              INTEGER NOT NULL DEFAULT 0,
              last_error            TEXT,
              failed_permanently    INTEGER NOT NULL DEFAULT 0
            )
            """
        )
        # Add failed_permanently on long-lived DBs that predate the
        # column. ADD COLUMN is idempotent behind a PRAGMA probe.
        ob_cols = [r[1] for r in conn.execute("PRAGMA table_info(cloud_outbox)")]
        if "failed_permanently" not in ob_cols:
            conn.execute(
                "ALTER TABLE cloud_outbox ADD COLUMN "
                "failed_permanently INTEGER NOT NULL DEFAULT 0"
            )
        # Drop the old ``(sent_at)`` shape if an older Pi DB has it —
        # the new ``(outbox_id)`` form lets SQLite serve the worker's
        # ``WHERE sent_at IS NULL AND failed_permanently = 0
        # ORDER BY outbox_id ASC`` scan from the index without a sort
        # step. Idempotent: fresh DBs just create the new index;
        # existing DBs drop + recreate.
        conn.execute("DROP INDEX IF EXISTS cloud_outbox_pending_idx")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS cloud_outbox_pending_idx "
            "ON cloud_outbox (outbox_id) "
            "WHERE sent_at IS NULL AND failed_permanently = 0"
        )
        # Sync-audit finding #14: triage queries that filter by
        # event_kind (e.g. /admin/dead-letter UI grouping by kind, or
        # back-fill scans filtering for ``in_flight_*`` patterns)
        # currently full-scan payload_json strings. Add an expression
        # index on json_extract(payload_json, '$.event_kind') so those
        # filters use the index directly. Cheap on insert: SQLite
        # evaluates json_extract once per row at write time. Idempotent.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_outbox_event_kind "
            "ON cloud_outbox(json_extract(payload_json, '$.event_kind'))"
        )

    # Intake DLQ (AUDIT_FINDINGS_PHASE1 L8/HIGH closed). Long-lived DBs
    # predate this table — guard with IF NOT EXISTS so we land the
    # table + indexes on existing installs.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS intake_pending (
              intake_id             INTEGER PRIMARY KEY AUTOINCREMENT,
              client_intake_id      TEXT NOT NULL UNIQUE,
              payload_json          TEXT NOT NULL,
              enqueued_at           TEXT NOT NULL DEFAULT (datetime('now')),
              resolved_at           TEXT,
              attempts              INTEGER NOT NULL DEFAULT 0,
              last_error            TEXT,
              status                INTEGER NOT NULL DEFAULT 0
                                      CHECK(status IN (0, 1, 2)),
              product_id            TEXT
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS intake_pending_pending_idx "
            "ON intake_pending (intake_id) WHERE status = 0"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS intake_pending_status_idx "
            "ON intake_pending (status)"
        )

    # --- CHECK-constraint evolution for ``lots.status`` ---------------------
    # Add 'in_flight' to the lot status enum + the paired in-flight-columns
    # invariant CHECK (IN_FLIGHT_TRACKER_PLAN.md §11 + audit M1).
    # SQLite can't ALTER CHECK constraints in place, so we probe the DDL
    # and rebuild the table preserving all rows + indexes when EITHER of:
    #   (a) the 'in_flight' literal is missing from the status enum, or
    #   (b) the audit M1 CHECK pair is missing.
    # The second condition catches the case where 'in_flight' already got
    # added in a prior migration but the paired CHECK wasn't yet present.
    # Foreign keys are temporarily disabled because lots.lot_id is
    # referenced by session_resolutions.
    lots_ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='lots'"
    ).fetchone()
    lots_ddl = (lots_ddl_row[0] if lots_ddl_row else "") or ""
    _needs_in_flight_literal = "'in_flight'" not in lots_ddl
    _needs_pair_check = "status = 'in_flight'" not in lots_ddl
    # Catch-all: rebuild if the shelf_id CHECK is absent. The column
    # itself was already added via ADD COLUMN earlier in this function,
    # but the CHECK constraint on its enum values can only be applied
    # via a table rebuild.
    _needs_shelf_id_check = "shelf_id IN ('live_shelf','catch_all','single_item')" not in lots_ddl
    if lots_ddl_row and (
        _needs_in_flight_literal or _needs_pair_check or _needs_shelf_id_check
    ):
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                conn.execute("DROP TABLE IF EXISTS lots_new")
                conn.execute(
                    """
                    CREATE TABLE lots_new (
                        lot_id              TEXT PRIMARY KEY,
                        product_id          TEXT NOT NULL REFERENCES products(product_id),
                        status              TEXT NOT NULL CHECK(status IN ('on_shelf','in_flight','out','depleted','relocated','lost')),
                        current_weight_g    REAL,
                        initial_weight_g    REAL,
                        total_consumed_g    REAL NOT NULL DEFAULT 0,
                        placed_at           TEXT NOT NULL DEFAULT (datetime('now')),
                        last_seen_at        TEXT NOT NULL DEFAULT (datetime('now')),
                        last_out_at         TEXT,
                        notes               TEXT,
                        in_flight_since     TEXT,
                        pickup_weight_g     REAL,
                        pickup_event_id     TEXT,
                        pickup_session_id   TEXT,
                        shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item')),
                        -- Mirror the invariant declared in schema.sql: keep
                        -- status and in_flight_since in sync so rogue flips
                        -- that touch only one column are rejected at the DB.
                        CHECK((status = 'in_flight') = (in_flight_since IS NOT NULL))
                    )
                    """
                )
                old_lot_cols = {
                    r[1] for r in conn.execute("PRAGMA table_info(lots)")
                }
                # Project each new-schema column from the old table if it
                # exists, else NULL. total_consumed_g carries a DEFAULT 0 on
                # the new schema so NULL would violate it — coerce to 0.
                def _col(name: str, default: str = "NULL") -> str:
                    return name if name in old_lot_cols else default
                select_cols = [
                    "lot_id", "product_id", "status",
                    _col("current_weight_g"),
                    _col("initial_weight_g"),
                    _col("total_consumed_g", "0"),
                    _col("placed_at", "datetime('now')"),
                    _col("last_seen_at", "datetime('now')"),
                    _col("last_out_at"),
                    _col("notes"),
                    _col("in_flight_since"),
                    _col("pickup_weight_g"),
                    _col("pickup_event_id"),
                    _col("pickup_session_id"),
                    _col("shelf_id", "'live_shelf'"),
                ]
                conn.execute(
                    f"INSERT INTO lots_new SELECT {', '.join(select_cols)} FROM lots"
                )
                conn.execute("DROP TABLE lots")
                conn.execute("ALTER TABLE lots_new RENAME TO lots")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(status)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_lots_product ON lots(product_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_lots_in_flight_since "
                    "ON lots(in_flight_since)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_lots_shelf_status "
                    "ON lots(shelf_id, status)"
                )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

    # --- CHECK-constraint evolution for ``session_resolutions.pattern`` -----
    # Add the four new in-flight patterns. Same rebuild dance as above.
    sr_ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_resolutions'"
    ).fetchone()
    if sr_ddl_row and "'in_flight_pickup'" not in (sr_ddl_row[0] or ""):
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                conn.execute("DROP TABLE IF EXISTS session_resolutions_new")
                conn.execute(
                    """
                    CREATE TABLE session_resolutions_new (
                        resolution_id       TEXT PRIMARY KEY,
                        session_id          TEXT NOT NULL REFERENCES sessions(session_id),
                        lot_id              TEXT REFERENCES lots(lot_id),
                        pattern             TEXT NOT NULL CHECK(pattern IN (
                            'use_return_no_consumption','use_return_consumed','topped_up',
                            'consumed_or_removed','new_arrival','swap_out','swap_in',
                            'relocation','unknown','no_op',
                            'in_flight_pickup','in_flight_return',
                            'in_flight_replaced_new_item','in_flight_ttl_expired'
                        )),
                        consumed_g          REAL,
                        confidence          REAL,
                        add_event_id        TEXT REFERENCES scale_events(event_id),
                        remove_event_id     TEXT REFERENCES scale_events(event_id),
                        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                    )
                    """
                )
                old_sr_cols = {
                    r[1] for r in conn.execute(
                        "PRAGMA table_info(session_resolutions)"
                    )
                }
                def _sr_col(name: str, default: str = "NULL") -> str:
                    return name if name in old_sr_cols else default
                sr_select = [
                    "resolution_id", "session_id",
                    _sr_col("lot_id"),
                    _sr_col("pattern", "'no_op'"),
                    _sr_col("consumed_g"),
                    _sr_col("confidence"),
                    _sr_col("add_event_id"),
                    _sr_col("remove_event_id"),
                    _sr_col("created_at", "datetime('now')"),
                ]
                conn.execute(
                    f"INSERT INTO session_resolutions_new SELECT "
                    f"{', '.join(sr_select)} FROM session_resolutions"
                )
                conn.execute("DROP TABLE session_resolutions")
                conn.execute(
                    "ALTER TABLE session_resolutions_new RENAME TO session_resolutions"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_resolutions_session "
                    "ON session_resolutions(session_id)"
                )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

    # CHECK-constraint evolution: add 'classifying' to classifier_status.
    # SQLite can't ALTER CHECK constraints in place, so we probe the DDL
    # and, if the new value is missing, rebuild the table preserving all
    # rows + indexes. Foreign keys are temporarily disabled for the swap
    # because other tables (session_resolutions, review_queue) reference
    # scale_events.event_id and would block the DROP.
    ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='scale_events'"
    ).fetchone()
    se_ddl = (ddl_row[0] if ddl_row else "") or ""
    _se_needs_classifying = "'classifying'" not in se_ddl
    # Catch-all: rebuild to pick up the shelf_id CHECK (the column itself
    # was ADD-COLUMN'd earlier; only the enum CHECK needs a rebuild).
    _se_needs_shelf_check = "shelf_id IN ('live_shelf','catch_all','single_item')" not in se_ddl
    if ddl_row and (_se_needs_classifying or _se_needs_shelf_check):
        # PRAGMA foreign_keys can only be toggled outside a transaction.
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                # Rebuild table with the expanded CHECK. Copy all rows,
                # drop old, rename new. Indexes are recreated from
                # schema.sql on fresh installs; we recreate the ones we
                # care about here.
                conn.execute("DROP TABLE IF EXISTS scale_events_new")
                conn.execute(
                    """
                    CREATE TABLE scale_events_new (
                        event_id            TEXT PRIMARY KEY,
                        session_id          TEXT REFERENCES sessions(session_id),
                        ts                  TEXT NOT NULL,
                        device_id           TEXT,
                        delta_g             REAL NOT NULL,
                        before_weight_g     REAL NOT NULL,
                        after_weight_g      REAL NOT NULL,
                        direction           TEXT NOT NULL CHECK(direction IN ('add','remove','noise')),
                        before_frame_path   TEXT,
                        after_frame_path    TEXT,
                        classification      TEXT,
                        classifier_status   TEXT CHECK(classifier_status IN ('pending','classifying','classified','review','failed')),
                        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
                        shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
                    )
                    """
                )
                # Carry forward whatever columns overlap. Defensive NULL
                # fallback for every column so a minimal test fixture (or
                # a very old DB) missing some field still migrates cleanly.
                old_cols = {
                    r[1] for r in conn.execute("PRAGMA table_info(scale_events)")
                }
                def _se_col(name: str, default: str = "NULL") -> str:
                    return name if name in old_cols else default
                select_cols = [
                    "event_id", "session_id", "ts",
                    _se_col("device_id"),
                    "delta_g", "before_weight_g", "after_weight_g", "direction",
                    _se_col("before_frame_path"),
                    _se_col("after_frame_path"),
                    _se_col("classification"),
                    _se_col("classifier_status"),
                    _se_col("created_at", "datetime('now')"),
                    _se_col("shelf_id", "'live_shelf'"),
                ]
                conn.execute(
                    f"INSERT INTO scale_events_new SELECT "
                    f"{', '.join(select_cols)} FROM scale_events"
                )
                conn.execute("DROP TABLE scale_events")
                conn.execute("ALTER TABLE scale_events_new RENAME TO scale_events")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_scale_events_session ON scale_events(session_id)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_scale_events_ts ON scale_events(ts)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_scale_events_shelf "
                    "ON scale_events(shelf_id)"
                )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

    # --- CHECK-constraint evolution for ``sessions.shelf_id`` ---------------
    # Sessions has no existing CHECK to evolve, so we only rebuild when
    # the shelf_id enum CHECK is missing (the column itself was already
    # ADD-COLUMN'd earlier with a 'live_shelf' default backfilling
    # existing rows). Rebuild preserves all rows + indexes.
    sess_ddl_row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'"
    ).fetchone()
    sess_ddl = (sess_ddl_row[0] if sess_ddl_row else "") or ""
    if sess_ddl_row and "shelf_id IN ('live_shelf','catch_all','single_item')" not in sess_ddl:
        conn.execute("PRAGMA foreign_keys = OFF")
        try:
            with conn:
                conn.execute("DROP TABLE IF EXISTS sessions_new")
                conn.execute(
                    """
                    CREATE TABLE sessions_new (
                        session_id          TEXT PRIMARY KEY,
                        started_at          TEXT NOT NULL,
                        ended_at            TEXT,
                        initial_shelf_weight_g REAL,
                        final_shelf_weight_g   REAL,
                        reconciled          INTEGER NOT NULL DEFAULT 0,
                        reconciled_at       TEXT,
                        shelf_id            TEXT NOT NULL DEFAULT 'live_shelf' CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))
                    )
                    """
                )
                old_sess_cols = {
                    r[1] for r in conn.execute("PRAGMA table_info(sessions)")
                }
                def _sess_col(name: str, default: str = "NULL") -> str:
                    return name if name in old_sess_cols else default
                sess_select = [
                    "session_id", "started_at",
                    _sess_col("ended_at"),
                    _sess_col("initial_shelf_weight_g"),
                    _sess_col("final_shelf_weight_g"),
                    _sess_col("reconciled", "0"),
                    _sess_col("reconciled_at"),
                    _sess_col("shelf_id", "'live_shelf'"),
                ]
                conn.execute(
                    f"INSERT INTO sessions_new SELECT "
                    f"{', '.join(sess_select)} FROM sessions"
                )
                conn.execute("DROP TABLE sessions")
                conn.execute("ALTER TABLE sessions_new RENAME TO sessions")
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sessions_ended ON sessions(ended_at)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS idx_sessions_shelf ON sessions(shelf_id)"
                )
        finally:
            conn.execute("PRAGMA foreign_keys = ON")

    # --- Invariant 7 (cloud batch 20260424090000): one OPEN session per -----
    # shelf. Pre-scan closes extras (newest started_at wins; losers get
    # ended_at = started_at + 1s, reconciled = 1 so the reconciler
    # ignores them). Then we land a partial unique index. Idempotent.
    with conn:
        dup_rows = conn.execute(
            """
            SELECT shelf_id, COUNT(*) AS c
              FROM sessions
             WHERE ended_at IS NULL
             GROUP BY shelf_id
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        if dup_rows:
            conn.execute(
                """
                WITH ranked AS (
                  SELECT session_id,
                         shelf_id,
                         started_at,
                         ROW_NUMBER() OVER (
                           PARTITION BY shelf_id
                           ORDER BY started_at DESC, session_id DESC
                         ) AS rn
                    FROM sessions
                   WHERE ended_at IS NULL
                )
                UPDATE sessions
                   SET ended_at = (
                         SELECT datetime(ranked.started_at, '+1 second')
                           FROM ranked
                          WHERE ranked.session_id = sessions.session_id
                       ),
                       reconciled = 1,
                       reconciled_at = datetime('now')
                 WHERE session_id IN (
                         SELECT session_id FROM ranked WHERE rn > 1
                       )
                """
            )
            total_closed = sum((row[1] - 1) for row in dup_rows)
            log.warning(
                "migrations: invariant 7 pre-scan closed %d stray open sessions "
                "across %d shelf_ids (kept newest per shelf)",
                total_closed, len(dup_rows),
            )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_shelf "
            "ON sessions(shelf_id) WHERE ended_at IS NULL"
        )

    # --- Cloud lot snapshot mirror (LOT_SNAPSHOT_RECONCILE). -----------------
    # The ``lots`` table is keyed by Pi-minted UUIDs and has semantics
    # tied to live-shelf physical state (on_shelf / in_flight /
    # current_weight_g). Cloud ``chefbyte.stock_lots`` is keyed by
    # cloud-minted UUIDs and tracks quantity-in-containers. The two are
    # NOT 1:1 — merging them risks contaminating the reconciler's live
    # model with cloud state that doesn't round-trip through the
    # physical lot lifecycle.
    #
    # ``cloud_lots`` is a separate mirror of cloud's stock_lots for this
    # user, populated by the lot-snapshot poller. Shape matches the
    # cloud endpoint's projection 1:1 so the poller writes-through
    # without mapping. The ``updated_at`` watermark column is the same
    # cloud timestamp that drives the delta query. No FKs — the Pi's
    # products table may or may not have the referenced product_id
    # cached at any given moment; the poller tolerates the drift.
    with conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cloud_lots (
              lot_id              TEXT PRIMARY KEY,
              product_id          TEXT NOT NULL,
              location_id         TEXT,
              qty_containers      REAL NOT NULL DEFAULT 0,
              expires_on          TEXT,
              in_flight_since     TEXT,
              in_flight_kind      TEXT,
              pickup_event_id     TEXT,
              created_at          TEXT,
              updated_at          TEXT NOT NULL,
              deleted_at          TEXT,
              synced_at           TEXT NOT NULL DEFAULT (datetime('now'))
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_lots_product "
            "ON cloud_lots(product_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_lots_updated_at "
            "ON cloud_lots(updated_at)"
        )
        # Catch-all delta-capture (2026-04-27): the new candidate-pool
        # builder filters cloud_lots by in_flight_kind='catch_all' and
        # by FEFO on created_at. Idempotent ALTER TABLE for DBs that
        # were created before these columns existed.
        cl_cols = [r[1] for r in conn.execute("PRAGMA table_info(cloud_lots)")]
        if "in_flight_kind" not in cl_cols:
            conn.execute(
                "ALTER TABLE cloud_lots ADD COLUMN in_flight_kind TEXT"
            )
        if "created_at" not in cl_cols:
            conn.execute(
                "ALTER TABLE cloud_lots ADD COLUMN created_at TEXT"
            )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_lots_in_flight_kind "
            "ON cloud_lots(in_flight_kind) WHERE in_flight_kind IS NOT NULL"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_cloud_lots_created_at "
            "ON cloud_lots(created_at)"
        )

    # --- Invariant 8 note (cloud batch 20260424090000): ----------------------
    # The ``tare_arm`` table already enforces a STRONGER invariant via
    # ``CHECK(id = 1)`` — it is a true singleton, at most one row ever,
    # regardless of device_id / scale_id. The spec's proposed partial
    # unique on (device_id, scale_id) WHERE disarmed_at IS NULL does
    # not apply because neither ``scale_id`` nor ``disarmed_at``
    # columns exist in this schema; a re-arm is an INSERT OR REPLACE
    # into the singleton. No migration is needed.


def _consolidate_usage_log_dupes(conn: sqlite3.Connection) -> int:
    """Collapse pre-existing usage_log duplicates to one row per logical event.

    Background: the live Pi accumulated N rows that share
    ``(return_event_id, lot_id, kind)`` because the self-heal scanner
    + history backfill re-emit the same return on every restart. The
    pickup-side unique index didn't catch this vector — those re-emits
    each carry a fresh pickup_event_id (or NULL via the reaper path).
    See ``UX_AUDIT_PI_LIVESHELF_R2.md`` Finding 2.

    The clean path (chosen over a soft-delete column): physically delete
    the duplicate rows, keeping the earliest ``usage_id`` per group as
    the survivor. The earliest row carries the most authentic created_at
    timestamp + the original pickup_event_id, so picking it as the
    survivor preserves the truthful trail.

    Idempotent: when no duplicates exist (fresh DBs, or post-fix DBs
    that already ran this once) the SELECT returns nothing and the
    DELETE is a no-op.

    Returns the number of rows physically deleted (0 on a clean DB).
    """
    try:
        rows = conn.execute(
            """
            SELECT MIN(usage_id) AS keep, COUNT(*) AS n,
                   return_event_id, lot_id, kind
              FROM usage_log
             WHERE return_event_id IS NOT NULL
             GROUP BY return_event_id, lot_id, kind
            HAVING COUNT(*) > 1
            """
        ).fetchall()
    except sqlite3.OperationalError:  # table missing on a fresh DB
        return 0
    if not rows:
        return 0

    deleted_total = 0
    with conn:
        for row in rows:
            cur = conn.execute(
                """
                DELETE FROM usage_log
                 WHERE return_event_id = ?
                   AND lot_id IS ?
                   AND kind = ?
                   AND usage_id != ?
                """,
                (row["return_event_id"], row["lot_id"],
                 row["kind"], row["keep"]),
            )
            deleted_total += cur.rowcount or 0
    if deleted_total > 0:
        log.warning(
            "migrations: consolidated %d duplicate usage_log row(s) "
            "across %d (return_event_id, lot_id, kind) group(s); "
            "see UX_AUDIT_PI_LIVESHELF_R2.md Finding 2",
            deleted_total, len(rows),
        )
    return deleted_total


def _backfill_usage_log(conn: sqlite3.Connection) -> int:
    """One-shot backfill of ``usage_log`` from existing
    ``session_resolutions`` (USAGE_LOG_PLAN.md §7).

    Per-row idempotency is provided by the ``INSERT OR IGNORE`` paired
    with the unique partial index ``idx_usage_log_pickup_dedup`` on
    ``pickup_event_id``. A previous "empty-table fast-exit" guard was
    removed because it permanently skipped historical backfill the
    moment any live emission wrote the first usage_log row — so a DB
    that hadn't yet been migrated would never pick up history once
    live emission started. The INSERT is cheap when there's nothing
    new to add (unique index absorbs every repeat), so running it on
    every open is safe.

    Returns the number of rows inserted.
    """
    # Pull historical in-flight resolutions and the reconciler's legacy
    # use_return_consumed. Join to lots + products for denormalised copy.
    # occurred_at prefers the resolution's return event ts, falling back
    # to the resolution's own created_at.
    inserted = 0
    with conn:
        cur = conn.execute(
            """
            INSERT OR IGNORE INTO usage_log (
                usage_id, lot_id, product_id, product_name,
                product_brand, container_type, consumed_g,
                pickup_weight_g, return_weight_g, kind,
                session_id, pickup_event_id, return_event_id,
                occurred_at
            )
            SELECT
                lower(hex(randomblob(16))),
                sr.lot_id,
                l.product_id,
                p.name,
                p.brand,
                p.container_type,
                CASE
                    WHEN sr.pattern IN (
                        'in_flight_ttl_expired',
                        'in_flight_replaced_new_item'
                    ) THEN COALESCE(sr.consumed_g, l.pickup_weight_g, 0.0)
                    ELSE COALESCE(sr.consumed_g, 0.0)
                END,
                l.pickup_weight_g,
                NULL,
                CASE sr.pattern
                    WHEN 'in_flight_return' THEN 'in_flight_return'
                    WHEN 'in_flight_ttl_expired' THEN 'in_flight_ttl_expired'
                    WHEN 'in_flight_replaced_new_item' THEN 'in_flight_replaced_new_item'
                    WHEN 'use_return_consumed' THEN 'reconciler_use_return'
                END,
                sr.session_id,
                sr.remove_event_id,
                sr.add_event_id,
                COALESCE(
                    (SELECT ts FROM scale_events WHERE event_id = sr.add_event_id),
                    (SELECT ts FROM scale_events WHERE event_id = sr.remove_event_id),
                    sr.created_at
                )
              FROM session_resolutions sr
              JOIN lots l     ON l.lot_id = sr.lot_id
              JOIN products p ON p.product_id = l.product_id
             WHERE sr.pattern IN (
                'in_flight_return',
                'in_flight_ttl_expired',
                'in_flight_replaced_new_item',
                'use_return_consumed'
             )
            """
        )
        inserted = cur.rowcount or 0
    # Diagnostic: the TTL/replacement backfill rows use
    # ``COALESCE(sr.consumed_g, l.pickup_weight_g, 0.0)``. If BOTH
    # columns are NULL (old DB missing sr.consumed_g and lot never
    # recorded pickup_weight_g) the row silently lands with
    # consumed_g=0 — a real consumption event lost to history. Warn so
    # operators can investigate historical data gaps rather than
    # discover them months later via an unexplained aggregate drop.
    try:
        zero_row = conn.execute(
            """
            SELECT COUNT(*) AS c
              FROM usage_log
             WHERE consumed_g = 0
               AND kind IN (
                   'in_flight_ttl_expired',
                   'in_flight_replaced_new_item'
               )
            """
        ).fetchone()
        zero_count = int(zero_row["c"] if zero_row is not None else 0)
        if zero_count > 0:
            log.warning(
                "migrations: %d backfilled usage_log rows have consumed_g=0 "
                "for TTL-expired/replaced in-flight events (both "
                "sr.consumed_g and lots.pickup_weight_g were NULL); "
                "lifetime totals may understate historical consumption",
                zero_count,
            )
    except Exception:  # pragma: no cover - defensive
        log.warning(
            "migrations: consumed_g=0 diagnostic query failed",
            exc_info=True,
        )
    return inserted


def apply_migrations(conn: sqlite3.Connection) -> bool:
    """Apply the schema if the DB is fresh.

    Returns True if migrations were applied, False if the DB was already
    initialized (no-op). Safe to call repeatedly.
    """
    existing = _existing_tables(conn)
    if all(t in existing for t in _CORE_TABLES):
        # Even on already-initialized DBs we still run the column-addition
        # pass so evolutions land on long-lived on-disk DBs.
        _apply_column_additions(conn)
        # One-shot backfill from any historical session_resolutions into
        # usage_log. No-op once populated.
        try:
            inserted = _backfill_usage_log(conn)
            if inserted > 0:
                import logging as _logging
                _logging.getLogger(__name__).info(
                    "migrations: backfilled %d usage_log rows from history",
                    inserted,
                )
        except Exception:  # pragma: no cover - defensive
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "migrations: usage_log backfill raised", exc_info=True,
            )
        return False

    # Partially-initialized DBs are not expected for the demo. If *some* but
    # not *all* of the core tables exist we still proceed with the full
    # CREATE, which will fail noisily on the first duplicate — the right
    # behavior because something is wrong upstream.
    sql = _SCHEMA_PATH.read_text(encoding="utf-8")
    with conn:  # commits on exit / rolls back on exception
        conn.executescript(sql)
    _apply_column_additions(conn)
    return True


def _enable_wal(conn: sqlite3.Connection) -> None:
    """Enable WAL journaling + a busy timeout on the connection.

    The Pi runs Flask (threaded request handler), the cloud worker, the
    reconciler, the classifier worker, and the lifecycle/health sweepers
    all on a single shared ``sqlite3.Connection``. Even with the shared
    ``db_lock`` guarding writes at the application layer, SQLite's
    default ``rollback journal`` mode serializes writers at the file
    level — which means any lock held for longer than a tick of
    ``sqlite_busy_timeout_ms`` (default 0) causes a concurrent writer
    to raise ``OperationalError: database is locked``. That exception
    gets swallowed by the cloud emitter's ``except Exception`` and the
    event silently disappears.

    WAL (Write-Ahead Logging) swaps the journal for an append-only log
    that readers can traverse without blocking writers. Combined with a
    5-second busy timeout, concurrent threads can push writes through
    without the application layer seeing ``database is locked``.

    Two pragmas to read back + log for diagnostics. WAL can fail to
    enable on some filesystems (NFS, some tmpfs setups); we log the
    actual values rather than assume success.

    In-memory DBs (``:memory:``) don't support WAL — the pragma is a
    silent no-op there. We detect and log so tests don't emit a WARNING.
    """
    # ``journal_mode`` returns the effective mode after the set.
    row = conn.execute("PRAGMA journal_mode=WAL").fetchone()
    actual_mode = row[0] if row else None
    # busy_timeout returns the value set. Units: milliseconds.
    row = conn.execute("PRAGMA busy_timeout=5000").fetchone()
    actual_timeout = row[0] if row else None
    if str(actual_mode).lower() == "wal":
        log.info(
            "storage: WAL mode enabled (journal_mode=%s, busy_timeout=%sms)",
            actual_mode, actual_timeout,
        )
    else:
        # :memory: falls back to "memory"; that's expected for tests.
        log.info(
            "storage: journal_mode=%s, busy_timeout=%sms "
            "(WAL not available — likely :memory: or unsupported fs)",
            actual_mode, actual_timeout,
        )


def init_db(path: str) -> sqlite3.Connection:
    """Open a SQLite connection, enable foreign keys + WAL, apply migrations.

    `path` may be `:memory:` for tests.
    """
    # ``check_same_thread=False`` lets the capture thread (which fires the
    # brightness callback) and the reconciler worker thread reuse the same
    # connection as the Flask request threads. Bundle H guards all DB
    # mutations with a process-wide ``threading.Lock`` so there is no
    # concurrent-writer hazard despite the relaxed safety.
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    # WAL + busy_timeout — must happen BEFORE the first transaction so
    # the mode change can't race a concurrent writer. See _enable_wal.
    _enable_wal(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    apply_migrations(conn)
    return conn
