"""Harness orchestrator — wires up real Pi code + real local Supabase.

Design choices (driven by docs/VERIFY.md §"Gate: Harness"):

1. **Supabase**: assumes `supabase start` is already running (the harness
   checks via HTTP healthcheck; does not start or stop it — amortizes
   startup cost across scenarios). Fails fast with a clear error if not.

2. **Pi Flask subprocess**: optional. Each scenario can choose to spin up
   the Flask app (`hardware/live-shelf/server/app.py::create_app`) in an
   **in-process** mode for determinism. We do NOT run a separate HTTP
   subprocess by default — VERIFY.md §"Scenario contract" #2 explicitly
   says "drive the Pi via direct Python calls (e.g., handle_scale_event)
   not simulated HTTP from outside". We honor that.

3. **Deterministic drainer**: `CloudWorker.tick()` already exists as a
   public method. Scenarios call it synchronously to flush outbox rows
   into the cloud edge function. No background thread, no sleeps.

4. **Per-scenario isolation**: each scenario gets a fresh Pi SQLite DB
   (`:memory:` or tmpdir), a fresh cloud user (unique email), and its
   own import_key → device row. Teardown wipes the cloud user via
   service-role `DELETE FROM auth.users`.

5. **Scenario decorator**: `@scenario("name")` registers the function
   with the module-level registry. run.py imports each scenario file
   then iterates the registry.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
import json
import logging
import os
import secrets
import sqlite3
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import psycopg2
import psycopg2.extras
import requests

# Locate repo paths + live-shelf server module.
REPO_ROOT = Path(__file__).resolve().parents[2]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
SERVER_DIR = LIVE_SHELF_DIR / "server"

# Add the live-shelf parent so `from server.*` imports resolve. Tests in
# the Pi test suite use the same trick (see tests/test_heartbeat_regression).
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))

from server.cloud.client import CloudClient  # noqa: E402
from server.cloud.integration import CloudEventEmitter  # noqa: E402
from server.cloud.livetrack_poller import LiveTrackPoller  # noqa: E402
from server.cloud.lot_snapshot_poller import LotSnapshotPoller  # noqa: E402
from server.cloud.product_sync_poller import ProductSyncPoller  # noqa: E402
from server.cloud.worker import CloudWorker  # noqa: E402
from server.handlers.scale_events import ScaleHandler  # noqa: E402
from server.storage import init_db  # noqa: E402

log = logging.getLogger("harness")

# ---------------------------------------------------------------------------
# Supabase endpoint configuration
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("HARNESS_SUPABASE_URL", "http://127.0.0.1:54321")
SUPABASE_DB_URL = os.environ.get(
    "HARNESS_DB_URL",
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
)
# Local supabase anon/service-role keys are well-known (printed by
# `supabase start`). The hardcoded defaults below are the public
# localhost values baked into the supabase CLI — safe to commit.
SUPABASE_ANON_KEY = os.environ.get(
    "HARNESS_SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9."
    "CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0",
)
SUPABASE_SERVICE_ROLE_KEY = os.environ.get(
    "HARNESS_SUPABASE_SERVICE_ROLE_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0."
    "EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
)
# shelf-ingest base URL that the Pi's CloudClient expects
# (<url>/functions/v1/shelf-ingest). CloudClient strips the last path
# segment to find sibling functions like livetrack-session.
SHELF_INGEST_URL = f"{SUPABASE_URL}/functions/v1/shelf-ingest"

# ---------------------------------------------------------------------------
# Scenario registry + decorator
# ---------------------------------------------------------------------------


@dataclass
class Check:
    name: str
    ok: bool
    evidence: str = ""


@dataclass
class ScenarioResult:
    name: str
    ok: bool
    duration_ms: float
    checks: List[Check] = field(default_factory=list)
    failures: List[Dict[str, str]] = field(default_factory=list)


ScenarioFn = Callable[["HarnessContext"], None]

_REGISTRY: Dict[str, ScenarioFn] = {}


def scenario(name: str) -> Callable[[ScenarioFn], ScenarioFn]:
    """Register a scenario by name. Use as `@scenario("foo")` on a function
    that accepts a `HarnessContext` and performs asserts via `ctx.check(...)`.
    """

    def _wrap(fn: ScenarioFn) -> ScenarioFn:
        if name in _REGISTRY:
            raise RuntimeError(f"duplicate scenario name: {name}")
        _REGISTRY[name] = fn
        return fn

    return _wrap


def registered_scenarios() -> Dict[str, ScenarioFn]:
    return dict(_REGISTRY)


# ---------------------------------------------------------------------------
# HarnessContext — the per-scenario handle
# ---------------------------------------------------------------------------


class ScenarioFailure(Exception):
    """Raised by ctx.check(..., ok=False) to short-circuit a scenario.

    We still record the failed check before raising so the JSON artifact
    captures the first failure reason.
    """


class HarnessContext:
    """Per-scenario orchestration handle.

    Each scenario receives a fresh instance. It provides:
      - `db`: psycopg2 connection to the local Supabase Postgres
        (service-role, RLS bypassed).
      - `user_id`, `device_id`, `import_key`: unique-per-scenario cloud
        seed state.
      - `pi_sqlite`: Pi-side SQLite connection, initialized + clean.
      - `pi_cloud_client`: CloudClient pointed at the local edge fn,
        authenticated with this scenario's import_key.
      - `pi_emitter`: CloudEventEmitter bound to the Pi SQLite conn.
      - `pi_worker`: CloudWorker with `.tick()` for deterministic drain.
      - `pi_scale_handler`: ScaleHandler wired for direct-call driving.
      - `pi_livetrack_poller`: LiveTrackPoller for heartbeat→session flow.
      - `check(name, ok, evidence)`: records an assertion. ok=False
        raises ScenarioFailure to stop the scenario.

    Scenarios run ENTIRELY in-process (no HTTP from test → Pi) so the
    logic path is deterministic: `handle_heartbeat(...)` is a direct
    Python call that internally POSTs to the local edge function via
    the CloudClient.
    """

    def __init__(self, *, name: str, tmp_dir: Path):
        self.name = name
        self.tmp_dir = tmp_dir
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

        self._checks: List[Check] = []
        self._failures: List[Dict[str, str]] = []

        # Cloud seed state — populated by _seed_cloud().
        self.user_id: Optional[str] = None
        self.device_id: Optional[str] = None
        self.import_key: Optional[str] = None
        self.import_key_hash: Optional[str] = None
        self.email: Optional[str] = None

        # DB connection (service role).
        self.db: psycopg2.extensions.connection = psycopg2.connect(SUPABASE_DB_URL)
        self.db.autocommit = True

        # Pi-side objects — lazy.
        self._pi_sqlite: Optional[sqlite3.Connection] = None
        self._pi_cloud_client: Optional[CloudClient] = None
        self._pi_emitter: Optional[CloudEventEmitter] = None
        self._pi_worker: Optional[CloudWorker] = None
        self._pi_scale_handler: Optional[ScaleHandler] = None
        self._pi_livetrack_poller: Optional[LiveTrackPoller] = None
        self._pi_product_sync_poller: Optional[ProductSyncPoller] = None
        self._pi_lot_snapshot_poller: Optional[LotSnapshotPoller] = None
        self._pi_db_lock = threading.RLock()

    # ------------------------------------------------------------------
    # Assertion API
    # ------------------------------------------------------------------

    def check(self, name: str, ok: bool, evidence: str = "") -> None:
        """Record a check result. Raises ScenarioFailure on first failure."""
        self._checks.append(Check(name=name, ok=bool(ok), evidence=str(evidence)))
        if not ok:
            self._failures.append(
                {"check": name, "message": evidence or "check failed"}
            )
            raise ScenarioFailure(f"{self.name}: {name} FAILED — {evidence}")

    @property
    def checks(self) -> List[Check]:
        return list(self._checks)

    @property
    def failures(self) -> List[Dict[str, str]]:
        return list(self._failures)

    # ------------------------------------------------------------------
    # Cloud seeding — unique-per-scenario user / device / import key
    # ------------------------------------------------------------------

    def seed_cloud_user(
        self,
        *,
        timezone: str = "UTC",
        day_start_hour: int = 0,
    ) -> str:
        """Create a fresh auth.users row + hub.profile. Returns user_id.

        Email is generated from the scenario name + random suffix so
        concurrent scenarios cannot collide.
        """
        suffix = secrets.token_hex(4)
        self.email = f"harness-{self.name}-{suffix}@local.test".replace("_", "-")
        with self.db.cursor() as cur:
            # Insert a user via Supabase Auth admin path (raw SQL — this
            # is a local test DB, RLS bypassed).
            self.user_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO auth.users (
                    id, instance_id, email, encrypted_password,
                    email_confirmed_at, created_at, updated_at,
                    aud, role, raw_app_meta_data, raw_user_meta_data
                ) VALUES (
                    %s, '00000000-0000-0000-0000-000000000000', %s,
                    crypt('test-password-harness', gen_salt('bf')),
                    now(), now(), now(),
                    'authenticated', 'authenticated', '{}', '{}'
                )
                """,
                (self.user_id, self.email),
            )
            # hub.profiles — apply_shelf_event reads timezone + day_start_hour.
            cur.execute(
                """
                INSERT INTO hub.profiles (user_id, timezone, day_start_hour)
                VALUES (%s, %s, %s)
                ON CONFLICT (user_id) DO UPDATE
                   SET timezone = EXCLUDED.timezone,
                       day_start_hour = EXCLUDED.day_start_hour
                """,
                (self.user_id, timezone, day_start_hour),
            )
            # chefbyte.locations — apply_shelf_event's added/refilled branch
            # insists on at least one location for first-lot creation.
            cur.execute(
                """
                INSERT INTO chefbyte.locations (user_id, name)
                VALUES (%s, 'Fridge')
                """,
                (self.user_id,),
            )
        return self.user_id

    def seed_device(
        self,
        *,
        device_name: str = "harness-pi",
        is_active: bool = True,
    ) -> str:
        """Create a live_shelf_devices row + hashed import key. Returns device_id."""
        assert self.user_id, "seed_cloud_user must be called first"
        self.import_key = "hk-" + secrets.token_hex(16)
        self.import_key_hash = hashlib.sha256(
            self.import_key.encode("utf-8")
        ).hexdigest()
        with self.db.cursor() as cur:
            self.device_id = str(uuid.uuid4())
            cur.execute(
                """
                INSERT INTO chefbyte.live_shelf_devices (
                    device_id, user_id, device_name, import_key_hash, is_active
                ) VALUES (%s, %s, %s, %s, %s)
                """,
                (
                    self.device_id,
                    self.user_id,
                    device_name,
                    self.import_key_hash,
                    is_active,
                ),
            )
        return self.device_id

    def seed_product(
        self,
        *,
        name: str = "Test Product",
        net_weight_g: float = 500.0,
        servings_per_container: float = 1.0,
        calories_per_serving: float = 100.0,
        carbs_per_serving: float = 10.0,
        protein_per_serving: float = 5.0,
        fat_per_serving: float = 2.0,
        barcode: Optional[str] = None,
    ) -> str:
        """Insert a chefbyte.products row. Returns product_id."""
        assert self.user_id, "seed_cloud_user must be called first"
        pid = str(uuid.uuid4())
        with self.db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chefbyte.products (
                    product_id, user_id, name, barcode,
                    net_weight_g, servings_per_container,
                    calories_per_serving, carbs_per_serving,
                    protein_per_serving, fat_per_serving,
                    unit_type
                ) VALUES (
                    %s, %s, %s, %s,
                    %s, %s,
                    %s, %s, %s, %s,
                    'solid'
                )
                """,
                (
                    pid,
                    self.user_id,
                    name,
                    barcode,
                    net_weight_g,
                    servings_per_container,
                    calories_per_serving,
                    carbs_per_serving,
                    protein_per_serving,
                    fat_per_serving,
                ),
            )
        return pid

    def seed_pairing(
        self,
        *,
        scale_id: str,
        kind: str = "live_shelf",
        product_id: Optional[str] = None,
    ) -> str:
        """Insert a scale_pairings row. Returns pairing_id."""
        assert self.user_id and self.device_id
        pid = str(uuid.uuid4())
        with self.db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chefbyte.scale_pairings (
                    pairing_id, user_id, device_id, scale_id, kind, product_id
                ) VALUES (%s, %s, %s, %s, %s, %s)
                """,
                (pid, self.user_id, self.device_id, scale_id, kind, product_id),
            )
        return pid

    def seed_stock_lot(
        self,
        *,
        product_id: str,
        qty_containers: float = 1.0,
        in_flight_since: Optional[str] = None,
        pickup_event_id: Optional[str] = None,
        expires_on: Optional[str] = None,
    ) -> str:
        """Insert a chefbyte.stock_lots row. Returns lot_id.

        ``expires_on`` is optional — when omitted, the row inserts with
        a NULL expires_on. The chefbyte.stock_lots_merge_key unique
        index treats NULL as ``9999-12-31`` via COALESCE, so two lots
        for the same (user, product, location) with NULL expires_on
        collide. Scenarios that need multiple lots for one product
        (e.g. live_scale_lot_rotation testing FEFO rotation) MUST pass
        distinct expires_on values per lot.
        """
        assert self.user_id
        lot_id = str(uuid.uuid4())
        with self.db.cursor() as cur:
            cur.execute(
                "SELECT location_id FROM chefbyte.locations WHERE user_id = %s LIMIT 1",
                (self.user_id,),
            )
            row = cur.fetchone()
            loc_id = row[0] if row else None
            cur.execute(
                """
                INSERT INTO chefbyte.stock_lots (
                    lot_id, user_id, product_id, location_id,
                    qty_containers, in_flight_since, pickup_event_id,
                    expires_on
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    lot_id,
                    self.user_id,
                    product_id,
                    loc_id,
                    qty_containers,
                    in_flight_since,
                    pickup_event_id,
                    expires_on,
                ),
            )
        return lot_id

    def seed_livetrack_session(
        self,
        *,
        state: str = "waiting_scale",
        barcode: Optional[str] = None,
        product_id: Optional[str] = None,
        scale_id: Optional[str] = "scale-02",
    ) -> str:
        """Insert a livetrack_import_sessions row. Returns session_id.

        ``scale_id`` defaults to ``scale-02`` (the legacy catch-all
        target the wizard always used pre-2026-04-27 scoping refactor).
        Pass an explicit value to test per-scale suppression scenarios.
        Pass ``None`` to test the legacy null-scale_id rows.
        """
        assert self.user_id and self.device_id
        sid = str(uuid.uuid4())
        with self.db.cursor() as cur:
            cur.execute(
                """
                INSERT INTO chefbyte.livetrack_import_sessions (
                    session_id, user_id, device_id, scale_id, state,
                    current_barcode, current_product_id
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (sid, self.user_id, self.device_id, scale_id, state, barcode, product_id),
            )
        return sid

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    def q_one(self, sql: str, params: tuple = ()) -> Optional[tuple]:
        with self.db.cursor() as cur:
            cur.execute(sql, params)
            return cur.fetchone()

    def q_all(self, sql: str, params: tuple = ()) -> List[tuple]:
        with self.db.cursor() as cur:
            cur.execute(sql, params)
            return list(cur.fetchall())

    # ------------------------------------------------------------------
    # Pi-side object factories (lazy)
    # ------------------------------------------------------------------

    @property
    def pi_sqlite(self) -> sqlite3.Connection:
        if self._pi_sqlite is None:
            db_path = self.tmp_dir / "pi.sqlite3"
            if db_path.exists():
                db_path.unlink()
            self._pi_sqlite = init_db(str(db_path))
        return self._pi_sqlite

    @property
    def pi_cloud_client(self) -> CloudClient:
        if self._pi_cloud_client is None:
            assert self.import_key, "seed_device must be called first"
            self._pi_cloud_client = CloudClient(SHELF_INGEST_URL, self.import_key)
        return self._pi_cloud_client

    @property
    def pi_emitter(self) -> CloudEventEmitter:
        if self._pi_emitter is None:
            self._pi_emitter = CloudEventEmitter(self.pi_sqlite, enabled=True)
        return self._pi_emitter

    @property
    def pi_worker(self) -> CloudWorker:
        """CloudWorker wired for deterministic `.tick()` driving.

        The heartbeat body is minimal — the scenarios that care about
        heartbeat content construct a custom worker themselves. Default
        body carries only what's required by the edge fn validator.
        """
        if self._pi_worker is None:
            conn = self.pi_sqlite

            def _factory():
                return conn

            def _heartbeat_provider():
                return {
                    "pending_review_count": 0,
                    "outbox_pending_count": 0,
                    "outbox_permanent_failures": 0,
                    "scales": [],
                }

            self._pi_worker = CloudWorker(
                client=self.pi_cloud_client,
                conn_factory=_factory,
                heartbeat_provider=_heartbeat_provider,
                poll_interval_s=60.0,  # irrelevant — we tick manually
            )
        return self._pi_worker

    @property
    def pi_livetrack_poller(self) -> LiveTrackPoller:
        if self._pi_livetrack_poller is None:
            self._pi_livetrack_poller = LiveTrackPoller(
                cloud_client=self.pi_cloud_client,
                camera=None,  # AI-tare branch skipped in harness
            )
        return self._pi_livetrack_poller

    @property
    def pi_product_sync_poller(self) -> ProductSyncPoller:
        if self._pi_product_sync_poller is None:
            state_path = self.tmp_dir / "last_product_sync.json"
            self._pi_product_sync_poller = ProductSyncPoller(
                client=self.pi_cloud_client,
                conn=self.pi_sqlite,
                state_path=state_path,
                db_lock=self._pi_db_lock,
            )
        return self._pi_product_sync_poller

    @property
    def pi_lot_snapshot_poller(self) -> LotSnapshotPoller:
        """Lazily-constructed lot-snapshot poller wired to this scenario's
        Pi SQLite + CloudClient. Scenarios call ``tick_once()`` manually.
        """
        if self._pi_lot_snapshot_poller is None:
            state_path = self.tmp_dir / "last_lot_sync.json"
            self._pi_lot_snapshot_poller = LotSnapshotPoller(
                client=self.pi_cloud_client,
                conn=self.pi_sqlite,
                state_path=state_path,
                db_lock=self._pi_db_lock,
            )
        return self._pi_lot_snapshot_poller

    def build_pi_scale_handler(
        self,
        *,
        catch_all_enabled: bool = True,
        events_root: Optional[Path] = None,
    ) -> ScaleHandler:
        """Construct a ScaleHandler wired to this context's Pi objects.

        We can't always cache this because scenarios may need different
        catch_all_enabled flags. Call once and re-use within a scenario.
        """
        if events_root is None:
            events_root = self.tmp_dir / "events"
            events_root.mkdir(exist_ok=True)

        class _NullCandidateSource:
            def get_on_shelf_lots(self):
                return []

            def get_recently_out_lots(self, window_seconds):
                return []

            def get_certified_not_on_shelf(self):
                return []

        # Minimal shelf registry so the catch-all device_id resolves.
        # The registry is a {shelf_id: ShelfConfig} dict per server/shelves.py.
        from server.shelves import DEFAULT_REGISTRY

        if catch_all_enabled:
            shelf_registry = dict(DEFAULT_REGISTRY)
        else:
            shelf_registry = None

        handler = ScaleHandler(
            conn=self.pi_sqlite,
            db_lock=self._pi_db_lock,
            camera=None,
            candidate_source=_NullCandidateSource(),
            events_root=events_root,
            delta_threshold_g=5.0,
            lookback_seconds=2.0,
            recently_out_window_seconds=86_400,
            classifier_client=None,
            catch_all_enabled=catch_all_enabled,
            shelf_registry_override=shelf_registry,
            cloud_emitter=self.pi_emitter,
            cloud_client=self.pi_cloud_client,
        )
        # Wire the livetrack poller so heartbeat + scale-event interception
        # can read the session snapshot. Pi's scale_events.py looks for
        # ``self._livetrack_poller`` as an attribute.
        handler._livetrack_poller = self.pi_livetrack_poller
        self._pi_scale_handler = handler
        return handler

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------

    def teardown(self) -> None:
        """Delete the test cloud user (cascades to devices, sessions, lots)."""
        if self.user_id:
            try:
                with self.db.cursor() as cur:
                    cur.execute(
                        "DELETE FROM auth.users WHERE id = %s", (self.user_id,)
                    )
            except Exception:  # noqa: BLE001 — teardown best-effort
                log.warning(
                    "teardown: delete auth.users failed for %s", self.user_id,
                    exc_info=True,
                )
        if self._pi_sqlite is not None:
            try:
                self._pi_sqlite.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            self.db.close()
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# Supabase healthcheck
# ---------------------------------------------------------------------------


class SupabaseUnreachable(RuntimeError):
    """Raised by ensure_supabase_running when the local stack isn't up."""


def ensure_supabase_running(timeout_s: float = 5.0) -> None:
    """Verify `supabase start` is already running.

    We do NOT start it — startup takes 30-60s and should be amortized
    across scenarios by leaving it running between invocations. The
    harness fails fast with actionable error if it's not reachable.
    """
    # 1. Postgres reachable?
    try:
        with psycopg2.connect(SUPABASE_DB_URL, connect_timeout=int(timeout_s)):
            pass
    except Exception as exc:  # noqa: BLE001
        raise SupabaseUnreachable(
            f"cannot connect to local postgres at {SUPABASE_DB_URL}: {exc}\n"
            f"Run `supabase start` (from repo root) before `pnpm harness`."
        ) from exc

    # 2. Edge function reachable? (Auth will fail — we just want a 401
    #    so we know the router is up.)
    try:
        resp = requests.post(
            f"{SHELF_INGEST_URL}/heartbeat",
            json={},
            headers={"x-api-key": "harness-probe", "content-type": "application/json"},
            timeout=timeout_s,
        )
    except requests.RequestException as exc:
        raise SupabaseUnreachable(
            f"edge function at {SHELF_INGEST_URL} unreachable: {exc}\n"
            f"Ensure `supabase start` completed + functions are served."
        ) from exc
    # 401 = router up, auth rejected probe key (expected). 5xx = function
    # not deployed / crashed.
    if resp.status_code >= 500:
        raise SupabaseUnreachable(
            f"edge function at {SHELF_INGEST_URL} returned {resp.status_code}: "
            f"{resp.text[:200]}"
        )
