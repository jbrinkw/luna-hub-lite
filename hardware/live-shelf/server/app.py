"""Flask entry point for the Live Shelf demo (Bundle H).

Responsibilities:

1. Load config (env + config.json).
2. Apply v4l2 locked camera settings.
3. Open SQLite, run migrations.
4. Spin up the camera daemon (capture thread + ring buffer + brightness).
5. Instantiate all adapters (storage → protocols for D/E/F/G).
6. Register the brightness callback + scale handler.
7. Register all Flask blueprints (intake, web HTML, web API, scale,
   live.mjpg).
8. Start Flask on 0.0.0.0:8000.
9. SIGINT → stop camera thread, commit DB, exit cleanly.
"""

from __future__ import annotations

import argparse
import logging
import os
import shutil
import signal
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flask import Flask, Response

from . import adapters
from .camera import mjpeg
from .camera.daemon import CameraDaemon, DaemonConfig, now_iso_utc_ms
from .camera import session_capture
from .camera.locked_settings import apply_locked_settings
from .cloud import CloudClient, CloudWorker, LiveTrackPoller
from .cloud.integration import (
    CloudEventEmitter,
    backfill_missing_outbox_events,
    null_emitter,
)
from .config import (
    AppConfig,
    apply_config_patch,
    ensure_data_dirs,
    load_config,
)
from .handlers.brightness import BrightnessHandler
from .handlers.scale_events import ScaleHandler, make_scale_bp
from .handlers.weight import WeightHandler
from .intake import (
    create_blueprint as create_intake_bp,
    sync_products_from_cloud,
    upsert_product_from_cloud,
)
from .reconciler.reconcile import reconcile_session
from .storage import init_db as open_storage_db
from .storage import lifecycle as lifecycle_storage
from .storage import repo as storage_repo
from .storage.lifecycle import ReasonCode
from .web import make_api_bp, make_html_bp
from .web.debug_routes import make_debug_bp

log = logging.getLogger(__name__)


class AppBundle:
    """Collection of long-lived app objects wired by :func:`create_app`.

    Kept as a small container (rather than module-level globals) so tests
    can instantiate multiple in parallel if ever needed.
    """

    def __init__(
        self,
        *,
        app: Flask,
        config: AppConfig,
        conn: sqlite3.Connection,
        db_lock: threading.RLock,
        camera: CameraDaemon,
        scale_handler: ScaleHandler,
        brightness_handler: BrightnessHandler,
        catch_all_camera: Optional[CameraDaemon] = None,
        weight_handler: Optional[WeightHandler] = None,
        cloud_worker: Optional[CloudWorker] = None,
        cloud_emitter: Optional[CloudEventEmitter] = None,
    ) -> None:
        self.app = app
        self.config = config
        self.conn = conn
        self.db_lock = db_lock
        self.camera = camera
        self.scale_handler = scale_handler
        self.brightness_handler = brightness_handler
        # Catch-all shelf (CATCH_ALL_SCALE_PLAN.md §5). Either both are
        # present (feature enabled + hardware found at boot) or both are
        # None (flag off, or /dev/video2 absent → graceful-degrade path).
        self.catch_all_camera = catch_all_camera
        self.weight_handler = weight_handler
        # Cloud integration (PROD_MIGRATION_PLAN.md). ``cloud_worker``
        # is the background drainer thread; ``cloud_emitter`` is the
        # producer-side facade shared with adapters + handlers. Both are
        # None when CLOUD_ENABLED=false. Exposed so tests + /healthz
        # introspection can observe their state.
        self.cloud_worker = cloud_worker
        self.cloud_emitter = cloud_emitter

    def shutdown(self) -> None:
        """Graceful shutdown: stop camera thread(s) + cloud worker + commit DB.

        Each step logs INFO at entry and exit so a hung shutdown shows
        up in the log with the specific step that stalled. After the
        cloud-worker join, we check ``is_alive()`` — a still-alive
        thread means the 5s join timed out, which is an operator signal
        (Wi-Fi hung indefinitely, runaway retry loop, etc.).
        """
        log.info("shutdown: starting")
        # Stop the cloud worker first so it doesn't attempt writes
        # against a connection we're about to close. The 5-second join
        # matches the camera timeout and covers one full outbox tick on
        # the worst-case max backoff path.
        if self.cloud_worker is not None:
            log.info("shutdown: stopping cloud worker")
            try:
                self.cloud_worker.stop()
                self.cloud_worker.join(timeout=5.0)
                still_alive = self.cloud_worker.is_alive()
                if still_alive:
                    log.warning(
                        "shutdown: cloud worker did not stop within timeout "
                        "(still alive after join)"
                    )
                log.info(
                    "shutdown: cloud worker stopped (joined=%s)",
                    not still_alive,
                )
            except Exception:  # pragma: no cover - defensive
                log.exception("cloud worker shutdown failed")
        try:
            log.info("shutdown: setting camera shutdown")
            self.camera.shutdown_event.set()
            self.camera.join(timeout=5.0)
            log.info("shutdown: camera stopped")
        except Exception:  # pragma: no cover - defensive
            log.exception("camera shutdown failed")
        if self.catch_all_camera is not None:
            try:
                log.info("shutdown: setting catch-all camera shutdown")
                self.catch_all_camera.shutdown_event.set()
                self.catch_all_camera.join(timeout=5.0)
                log.info("shutdown: catch-all camera stopped")
            except Exception:  # pragma: no cover - defensive
                log.exception("catch-all camera shutdown failed")
        try:
            log.info("shutdown: closing db")
            with self.db_lock:
                self.conn.commit()
                self.conn.close()
        except Exception:  # pragma: no cover - defensive
            log.exception("db close failed")
        log.info("shutdown: complete")


# ---------------------------------------------------------- app factory


def _last_weight_from_state(
    conn: sqlite3.Connection, db_lock: threading.RLock
):
    """Return a nullary callable used by the brightness handler.

    Reads app_state.last_scale_weight_g under the DB lock.
    """
    def _getter() -> float:
        with db_lock:
            state = storage_repo.get_app_state(conn)
        return float(state.last_scale_weight_g or 0.0)
    return _getter


def _resolve_camera_source(
    device: Optional[str],
    fallback_idx: Optional[int],
    *,
    default_idx: int,
) -> tuple[Optional[str], int]:
    """Resolve a camera-device string into (path, idx) for DaemonConfig.

    Rules:
      * Empty/None device → use ``fallback_idx`` (live shelf) or ``default_idx``.
      * Pure integer string → numeric index only.
      * ``/dev/videoN`` → return (path, N) so the existing index-based
        telemetry still has a sensible number to log.
      * Any other path (``/dev/v4l/by-id/...``, ``/dev/v4l/by-path/...``) →
        return (path, default_idx). Index is unused when path is set.
    """
    if not device:
        idx = fallback_idx if fallback_idx is not None else default_idx
        return None, int(idx)
    s = device.strip()
    if s.isdigit():
        return None, int(s)
    if s.startswith("/dev/video"):
        tail = s.rsplit("video", 1)[-1]
        try:
            return s, int(tail)
        except ValueError:
            return s, default_idx
    return s, default_idx


# -------------------------------------------- disk retention sweeper

DISK_RETENTION_MAX_AGE_SECONDS: int = 14 * 24 * 60 * 60  # 14 days
DISK_RETENTION_INTERVAL_SECONDS: int = 24 * 60 * 60      # 24 hours


def _dir_size_bytes(root: Path) -> int:
    """Sum of every regular file's size under ``root``. Best-effort — any
    unreadable entries are silently skipped."""
    total = 0
    try:
        for entry in root.rglob("*"):
            try:
                if entry.is_file():
                    total += entry.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    return total


def _sweep_old_run_artifacts(
    data_root: Path,
    *,
    max_age_seconds: int = DISK_RETENTION_MAX_AGE_SECONDS,
) -> dict[str, Any]:
    """Delete subdirectories under ``data/events/``, ``data/sessions/``
    and ``data/diag/`` whose mtime is older than ``max_age_seconds``.

    Returns a summary dict with counts + bytes freed. Idempotent and
    tolerant of missing top-level dirs.
    """
    now = time.time()
    dirs_deleted = 0
    bytes_freed = 0
    for name in ("events", "sessions", "diag"):
        root = data_root / name
        if not root.exists() or not root.is_dir():
            continue
        for child in root.iterdir():
            if not child.is_dir():
                continue
            try:
                mtime = child.stat().st_mtime
            except OSError:
                continue
            age = now - mtime
            if age < max_age_seconds:
                continue
            size = _dir_size_bytes(child)
            try:
                shutil.rmtree(child, ignore_errors=True)
            except OSError:
                continue
            if not child.exists():
                dirs_deleted += 1
                bytes_freed += size
    return {"dirs_deleted": dirs_deleted, "bytes_freed": bytes_freed}


LIFECYCLE_RETENTION_DAYS: int = 30
LIFECYCLE_RETENTION_INTERVAL_SECONDS: int = 24 * 60 * 60  # 24h
SYSTEM_HEALTH_INTERVAL_SECONDS: int = 60


def start_lifecycle_retention_sweeper(
    conn: sqlite3.Connection,
    db_lock: threading.RLock,
    *,
    retention_days: int = LIFECYCLE_RETENTION_DAYS,
    interval_seconds: int = LIFECYCLE_RETENTION_INTERVAL_SECONDS,
) -> threading.Thread:
    """Daily cleanup of lifecycle tables — delete rows older than N days."""
    def _loop() -> None:
        while True:
            try:
                deleted = lifecycle_storage.purge_older_than(
                    conn, db_lock, days=retention_days,
                )
                log.info(
                    "lifecycle retention: purged %s",
                    deleted,
                )
            except Exception:
                log.exception("lifecycle retention iteration threw")
            time.sleep(interval_seconds)

    t = threading.Thread(
        target=_loop, name="lifecycle-retention", daemon=True,
    )
    t.start()
    log.info(
        "lifecycle retention sweeper started (%dd retention, %ds interval)",
        retention_days, interval_seconds,
    )
    return t


def start_system_health_snapshot_thread(
    conn: sqlite3.Connection,
    db_lock: threading.RLock,
    *,
    interval_seconds: int = SYSTEM_HEALTH_INTERVAL_SECONDS,
) -> threading.Thread:
    """Every ``interval_seconds``: compute + persist a health snapshot.

    The snapshot reads volatile counters (scale weight, queue sizes, on-shelf
    aggregates, closed deque size, Anthropic counters). Safe to run even
    when classifiers / scales are idle — failing reads become NULL.
    """
    # Late imports so the thread helper stays self-contained and testable.
    from .camera import session_capture
    from .classifier.anthropic_client import get_anthropic_counters

    def _snapshot() -> dict[str, Any]:
        snap: dict[str, Any] = {}
        try:
            with db_lock:
                row = conn.execute(
                    "SELECT last_scale_weight_g FROM app_state WHERE id = 1"
                ).fetchone()
                snap["scale_weight_g"] = (
                    float(row[0]) if row and row[0] is not None else None
                )
                counts = conn.execute(
                    """
                    SELECT
                      SUM(CASE WHEN classifier_status='pending' THEN 1 ELSE 0 END),
                      SUM(CASE WHEN classifier_status='classifying' THEN 1 ELSE 0 END),
                      SUM(CASE WHEN classifier_status='failed' THEN 1 ELSE 0 END)
                      FROM scale_events
                    """
                ).fetchone()
                snap["pending_events"] = int(counts[0] or 0)
                snap["classifying_events"] = int(counts[1] or 0)
                snap["failed_events"] = int(counts[2] or 0)
                pr = conn.execute(
                    "SELECT COUNT(*) FROM review_queue WHERE status = 'pending'"
                ).fetchone()
                snap["pending_reviews"] = int(pr[0] or 0)
                agg = conn.execute(
                    """
                    SELECT COUNT(*), COALESCE(SUM(current_weight_g), 0)
                      FROM lots WHERE status = 'on_shelf'
                    """
                ).fetchone()
                snap["on_shelf_lot_count"] = int(agg[0] or 0)
                snap["on_shelf_weight_sum_g"] = float(agg[1] or 0.0)
        except Exception:  # pragma: no cover - defensive
            log.exception("system_health: DB read failed")

        try:
            snap["closed_deque_size"] = len(session_capture._CLOSED)
        except Exception:  # pragma: no cover - defensive
            snap["closed_deque_size"] = None

        try:
            calls, errors = get_anthropic_counters()
            snap["anthropic_calls_total"] = int(calls)
            snap["anthropic_errors_total"] = int(errors)
        except Exception:  # pragma: no cover - defensive
            snap["anthropic_calls_total"] = None
            snap["anthropic_errors_total"] = None
        return snap

    def _loop() -> None:
        while True:
            try:
                snap = _snapshot()
                lifecycle_storage.log_system_health_snapshot(
                    conn, db_lock, snap,
                )
            except Exception:
                log.exception("system_health snapshot iteration threw")
            time.sleep(interval_seconds)

    t = threading.Thread(
        target=_loop, name="system-health-snapshot", daemon=True,
    )
    t.start()
    log.info(
        "system_health snapshot thread started (interval=%ds)",
        interval_seconds,
    )
    return t


def start_disk_retention_sweeper(
    data_root: Path,
    *,
    max_age_seconds: int = DISK_RETENTION_MAX_AGE_SECONDS,
    interval_seconds: int = DISK_RETENTION_INTERVAL_SECONDS,
) -> threading.Thread:
    """Run ``_sweep_old_run_artifacts`` immediately, then every
    ``interval_seconds`` from a daemon thread. Returns the thread for
    tests/observability; nothing to join in normal app lifetime.
    """
    def _loop() -> None:
        while True:
            try:
                summary = _sweep_old_run_artifacts(
                    data_root, max_age_seconds=max_age_seconds,
                )
                log.info(
                    "disk retention sweeper: removed %d dirs, freed %d bytes",
                    summary["dirs_deleted"], summary["bytes_freed"],
                )
            except Exception:
                log.exception("disk retention sweeper: iteration threw")
            time.sleep(interval_seconds)

    t = threading.Thread(
        target=_loop,
        name="disk-retention-sweeper",
        daemon=True,
    )
    t.start()
    log.info(
        "disk retention sweeper started (max_age=%ds, interval=%ds)",
        max_age_seconds, interval_seconds,
    )
    return t


def create_app(
    *,
    config: Optional[AppConfig] = None,
    camera: Optional[CameraDaemon] = None,
    conn: Optional[sqlite3.Connection] = None,
    classifier_client: Any | None = None,
    apply_v4l2: bool = True,
    start_camera: bool = True,
) -> AppBundle:
    """Build the Flask app + all supporting objects.

    Parameters
    ----------
    config:
        Override the auto-loaded :class:`AppConfig` (tests).
    camera:
        Pre-built :class:`CameraDaemon` (tests). When ``None`` a real one
        is constructed from the config.
    conn:
        Pre-opened sqlite connection (tests use ``:memory:``).
    classifier_client:
        Optional Anthropic client override (tests inject a fake).
    apply_v4l2:
        Skip :func:`apply_locked_settings` when False (for tests / dev Macs).
    start_camera:
        Skip :meth:`CameraDaemon.start` when False (tests drive frames).
    """
    cfg = config or load_config()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    ensure_data_dirs(cfg)

    if apply_v4l2:
        try:
            apply_locked_settings(cfg.camera_device)
        except Exception:  # pragma: no cover — best-effort
            log.exception("failed to apply v4l2 locked settings")

    # --- Storage ---------------------------------------------------------
    if conn is None:
        conn = open_storage_db(str(cfg.db_path))
    # RLock (not Lock) so lifecycle.log_event can re-acquire when called
    # from a code path that already holds db_lock (e.g. inside
    # ``_classify_recorded_event``'s ``with self._db_lock, self._conn:``
    # block). ``storage/lifecycle.py`` documents this assumption on line
    # 14 ("Use the caller's db_lock so we don't deadlock with writers
    # that already hold it") — that only holds if the lock is reentrant.
    db_lock = threading.RLock()

    # Zombie-session cleanup: if the Pi was killed while a session was
    # open (door_open=1, current_session_id set), the session row stays
    # in-flight and its id lingers in app_state. New events would get
    # stamped with that stale id and the reconciler for it would never
    # run. Close the orphan now + wipe the pointer so the brightness
    # watcher can open a fresh session when the door next opens.
    try:
        leftover = conn.execute(
            "SELECT current_session_id FROM app_state WHERE id = 1"
        ).fetchone()
        stale_id = leftover[0] if leftover else None
        if stale_id:
            now_iso = now_iso_utc_ms()
            with conn:
                conn.execute(
                    "UPDATE sessions SET ended_at = COALESCE(ended_at, ?) "
                    "WHERE session_id = ? AND ended_at IS NULL",
                    (now_iso, stale_id),
                )
                conn.execute(
                    "UPDATE app_state SET current_session_id = NULL, "
                    "door_open = 0 WHERE id = 1"
                )
            log.warning(
                "startup: closed zombie session %s (Pi was killed "
                "mid-session); door_open flag reset to 0",
                stale_id,
            )
    except Exception:
        log.exception("startup zombie-session cleanup failed (non-fatal)")

    # Clear stale tare-arm rows from a crashed prior session
    # (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.1 + §7). The scale-event
    # interceptor already gates on ``expires_at > now`` so a truly
    # expired row can't intercept, but a long-ago ghost arm would
    # still render a stale banner on /inventory and confuse the
    # operator. Idempotent + cheap — drops rows older than 10 min.
    try:
        with db_lock:
            cleared_arms = storage_repo.clear_stale_tare_arm(
                conn, older_than_s=600,
            )
        if cleared_arms:
            log.warning(
                "startup: cleared %d stale tare_arm row(s) from prior session",
                cleared_arms,
            )
    except Exception:
        log.exception("startup stale-tare-arm cleanup failed (non-fatal)")

    # Reset any 'classifying' rows back to 'pending' — those are events
    # whose classifier worker was killed mid-run (SIGTERM during deploy,
    # process crash, etc.). Leaving them in 'classifying' would strand
    # them forever (sweeper + close-hook only look for 'pending').
    try:
        with conn:
            reset = conn.execute(
                "UPDATE scale_events SET classifier_status = 'pending' "
                "WHERE classifier_status = 'classifying'"
            )
        if reset.rowcount:
            log.warning(
                "startup: reset %d scale_event(s) from 'classifying' -> "
                "'pending' (worker killed mid-classification)",
                reset.rowcount,
            )
    except Exception:
        log.exception("startup classifying-status reset failed (non-fatal)")

    # --- Camera ----------------------------------------------------------
    # Source resolution: prefer ``camera_device`` when it looks like a path
    # (``/dev/videoN`` or a ``/dev/v4l/by-id/...`` symlink — by-id is
    # stable across replug/reboot, which /dev/videoN is not). Fall back to
    # the numeric ``camera_index`` for backwards compatibility.
    live_path, live_idx = _resolve_camera_source(
        cfg.camera_device, cfg.camera_index, default_idx=0
    )
    if camera is None:
        camera = CameraDaemon(
            DaemonConfig(
                camera_index=live_idx,
                camera_path=live_path,
                resolution=(cfg.resolution_width, cfg.resolution_height),
                capture_fps=cfg.capture_fps,
                brightness_threshold=cfg.brightness_threshold,
                brightness_hysteresis=cfg.brightness_hysteresis,
            )
        )
    # --- Catch-all camera (optional, behind feature flag) ---------------
    # CATCH_ALL_SCALE_PLAN.md §5.2: a second USB camera pointed at the
    # countertop catch-all scale. Frame-ring-buffer only — NO brightness
    # watcher + NO session_capture subscription. Session lifecycle on
    # this shelf is driven by WeightHandler (below) off heartbeats.
    #
    # Graceful degradation: if the hardware is missing (USB camera
    # not plugged in, driver refuses to open, etc.), log WARNING and
    # leave catch_all_camera = None. The rest of the app must keep
    # working so the primary live-shelf demo doesn't hard-fail just
    # because the secondary scale isn't attached yet.
    catch_all_camera: Optional[CameraDaemon] = None
    if cfg.catch_all_enabled:
        try:
            ca_path, ca_idx = _resolve_camera_source(
                cfg.catch_all_camera_device, None, default_idx=2
            )
            catch_all_camera = CameraDaemon(
                DaemonConfig(
                    camera_index=ca_idx,
                    camera_path=ca_path,
                    resolution=(cfg.resolution_width, cfg.resolution_height),
                    capture_fps=cfg.capture_fps,
                    # Brightness watcher is IRRELEVANT on the catch-all —
                    # there's no enclosure. Disable to skip the state
                    # machine + avoid spurious transition callbacks.
                    brightness_detection_enabled=False,
                )
            )
            log.info(
                "catch-all camera daemon constructed (path=%s, index=%s)",
                ca_path, ca_idx,
            )
        except Exception:  # pragma: no cover - depends on hardware
            log.warning(
                "catch-all enabled but camera could not be constructed "
                "(device=%s); continuing with catch_all_camera=None",
                cfg.catch_all_camera_device,
                exc_info=True,
            )
            catch_all_camera = None
    # NOTE: previously called ``register_extract_daemon(camera)`` here,
    # which populated a module-level ``_ACTIVE_DAEMON`` so
    # ``camera/extract.py``'s ``frame_at()`` / ``current_frame()`` were
    # callable from anywhere. ``extract.py`` is unused in production
    # (see handoff §14 — per-event-frame-anchoring bug) and keeping it
    # registered tempts future code into re-introducing that bug. The
    # module is left on disk as reference; we just don't arm it.
    # --- Cloud integration (PROD_MIGRATION_PLAN.md Phase 2 + 4) --------
    # Build the producer-side emitter first; its enabled-flag flows
    # into every handler/adapter below so a CLOUD_ENABLED=false boot
    # takes the no-op path without any conditional wiring downstream.
    # The background drainer/heartbeater thread is spun up later once
    # scale_handler exists (the heartbeat provider needs its pending-
    # review count + scale list).
    cloud_emitter: CloudEventEmitter = (
        CloudEventEmitter(conn, enabled=True)
        if cfg.cloud_enabled
        else null_emitter()
    )
    if cfg.cloud_enabled and (not cfg.cloud_url or not cfg.cloud_import_key):
        log.warning(
            "CLOUD_ENABLED=true but CLOUD_URL or CLOUD_IMPORT_KEY is "
            "missing — cloud worker will NOT start; events will queue "
            "locally in cloud_outbox with no drainer"
        )

    # --- CloudClient (shared by intake + worker) ------------------------
    # Construct the HTTP client once at startup so both the synchronous
    # intake path (/api/intake/save → POST /intake) and the async
    # CloudWorker drain the same authenticated client. When URL or
    # import key is missing we fall back to cloud_client=None; the
    # intake blueprint's cloud_enabled gate then treats the system as
    # effectively disabled (see the fallback warning below), which
    # avoids the NameError risk if the worker block guards on
    # URL/key but the intake block doesn't.
    cloud_client: Optional[CloudClient] = None
    if cfg.cloud_enabled and cfg.cloud_url and cfg.cloud_import_key:
        try:
            cloud_client = CloudClient(cfg.cloud_url, cfg.cloud_import_key)
        except Exception:  # pragma: no cover - defensive
            log.exception(
                "failed to construct CloudClient; cloud integration disabled"
            )
            cloud_client = None
    intake_cloud_enabled = bool(cfg.cloud_enabled and cloud_client is not None)
    if cfg.cloud_enabled and cloud_client is None:
        log.warning(
            "intake cloud mode disabled — CLOUD_URL/CLOUD_IMPORT_KEY not set"
        )

    # Startup catalog sync: when cloud is fully configured, pull the
    # cloud's product catalog into the local cache so classifier lookups
    # and wizard autofills see known products immediately. Best-effort —
    # we log and continue on failure so a transient cloud outage can't
    # block the Pi from booting.
    if intake_cloud_enabled and cloud_client is not None:
        try:
            # Pass ``refs_root`` so the orphan-photo scan runs inline
            # after the upsert — any cloud product without a local
            # ref-photo directory gets a WARNING per finding #11 of
            # the deep audit. Recovery is manual (operator re-runs
            # intake for the orphaned product).
            count = sync_products_from_cloud(
                cloud_client, conn,
                db_lock=db_lock,
                refs_root=cfg.refs_root,
            )
            log.info(
                "startup: synced %d product(s) from cloud catalog", count,
            )
        except Exception:
            log.warning(
                "startup: sync_products_from_cloud failed; continuing "
                "with whatever is cached locally",
                exc_info=True,
            )

    # --- Adapters --------------------------------------------------------
    candidate_source = adapters.RepoCandidateSource(
        conn, cfg.refs_root, db_lock=db_lock,
    )
    intake_repo = adapters.RepoIntakeFacade(conn, db_lock=db_lock)
    # Fix 1: hand the shared lock to the adapter so each repo method
    # acquires it for its own short DB op, freeing the reconciler driver
    # to release the lock between calls (heartbeats can interleave).
    # The cloud_emitter is shared with the ScaleHandler below — the
    # reconciler writes the canonical in-session resolutions and the
    # scale handler writes the fast-path in-flight ones; both should
    # mirror to the same outbox.
    reconciler_repo = adapters.RepoReconcilerAdapter(
        conn,
        db_lock=db_lock,
        cloud_emitter=cloud_emitter,
    )
    # web_repo is constructed AFTER scale_handler below so we can pass in
    # ScaleHandler.apply_user_reviewed_candidate as the review-resolve
    # callback (user-confirmed low-confidence picks need to actually
    # mint/update lots, not just stamp the review row as resolved).
    camera_source = adapters.CameraDaemonSource(camera)

    # --- Handlers --------------------------------------------------------
    # Reconciler callable — invoked by ScaleHandler.process_session_events
    # AFTER all pending events for a closing session have been
    # classified. Previously this lived in BrightnessHandler._on_close
    # and raced ahead of classification, causing every event to be
    # stamped "unknown" by the reconciler before the classifier had
    # time to look at it. Keeps the same repo adapter as before —
    # just re-wired to run at the right moment in the close pipeline.
    def _run_reconciler_for_session(session_id: str) -> None:
        # reconcile_session issues many short DB ops via reconciler_repo;
        # the adapter acquires db_lock per call so heartbeat writes can
        # still interleave. The final mark is one atomic write under
        # the lock to serialize against concurrent writers.
        resolutions = reconcile_session(session_id, reconciler_repo)
        log.info(
            "reconciler: wrote %d resolutions for session %s",
            len(resolutions), session_id,
        )
        with db_lock:
            storage_repo.mark_session_reconciled(conn, session_id)

    # Catch-all scale registry (CATCH_ALL_SCALE_PLAN.md §4.3). Always
    # constructed from the live config so device_id overrides take
    # effect; the ScaleHandler only rejects unknown device_ids when
    # ``catch_all_enabled`` is True.
    from .shelves import build_registry_from_config as _build_shelf_registry
    _shelf_registry = _build_shelf_registry(cfg)

    scale_handler = ScaleHandler(
        conn=conn,
        db_lock=db_lock,
        camera=camera,
        candidate_source=candidate_source,
        events_root=cfg.events_root,
        delta_threshold_g=cfg.event_delta_threshold_g,
        lookback_seconds=cfg.frame_lookback_seconds,
        recently_out_window_seconds=cfg.recently_out_window_seconds,
        dedup_cache_size=cfg.dedup_lru_size,
        classifier_client=classifier_client,
        reconciler_fn=_run_reconciler_for_session,
        lifecycle_verbose=cfg.lifecycle_verbose,
        in_flight_ttl_seconds=cfg.in_flight_ttl_seconds,
        new_item_weight_ratio=cfg.new_item_weight_ratio,
        consumption_noise_floor_g=cfg.consumption_noise_floor_g,
        catch_all_enabled=cfg.catch_all_enabled,
        shelf_registry_override=_shelf_registry,
        cloud_emitter=cloud_emitter,
        # Threaded for fire-and-forget tare-capture push-back
        # (CATCH_ALL_TARE_CAPTURE_PLAN.md §4.2 cloud resolution). May
        # be None when CLOUD_ENABLED=false — in that case the handler
        # never calls post_product_tare. When non-None, the handler
        # calls it inside a broad try/except so cloud errors never
        # block local writes.
        cloud_client=cloud_client,
    )

    # --- WeightHandler (catch-all session driver) -----------------------
    # CATCH_ALL_SCALE_PLAN.md §5.1/§6.1: when the feature flag is on, a
    # WeightHandler consumes every heartbeat whose device_id matches the
    # configured catch-all scale and decides session open/close from the
    # weight reading. We keep a reference on AppBundle for shutdown +
    # tests; production code reaches it only via the heartbeat middleware
    # installed just below.
    weight_handler: Optional[WeightHandler] = None
    if cfg.catch_all_enabled:
        weight_handler = WeightHandler(
            conn=conn,
            db_lock=db_lock,
            shelf_id="catch_all",
            onscale_threshold_g=cfg.catch_all_onscale_threshold_g,
            reconciler_fn=_run_reconciler_for_session,
        )
        # Wrap ScaleHandler.handle_heartbeat so every heartbeat is ALSO
        # tee'd into the WeightHandler when the device_id matches. This
        # keeps scale_events.py untouched (another agent owns it) and
        # preserves scale_handler's return semantics for the Flask
        # blueprint.
        _original_handle_heartbeat = scale_handler.handle_heartbeat

        def _handle_heartbeat_with_weight_tap(
            payload: dict[str, Any],
        ) -> tuple[dict[str, Any], int]:
            resp, status = _original_handle_heartbeat(payload)
            # Only propagate successful heartbeats for the catch-all
            # device. A 4xx from the validator means the payload was
            # malformed — not our concern.
            # Read ``catch_all_device_id`` live off ``cfg`` so that a
            # runtime ``/api/config`` flip takes effect immediately on
            # the next heartbeat — not just after a server restart.
            if (
                status == 200
                and isinstance(payload, dict)
                and str(payload.get("device_id", ""))
                == str(getattr(cfg, "catch_all_device_id", ""))
            ):
                try:
                    weight_handler.on_heartbeat(  # type: ignore[union-attr]
                        weight_g=float(payload.get("weight_g", 0.0)),
                        ts=str(payload.get("ts", "")),
                        device_id=str(payload["device_id"]),
                    )
                except Exception:  # pragma: no cover - defensive
                    log.exception(
                        "weight_handler middleware: on_heartbeat tap raised"
                    )
            return resp, status

        scale_handler.handle_heartbeat = (  # type: ignore[method-assign]
            _handle_heartbeat_with_weight_tap
        )
        log.info(
            "catch-all WeightHandler installed (threshold=%.1fg, device=%s)",
            cfg.catch_all_onscale_threshold_g, cfg.catch_all_device_id,
        )

    # Wire lifecycle sinks for modules that can't reach the DB conn
    # directly. Each sink writes via storage.lifecycle which is
    # exception-swallowing by design.
    def _session_sink(
        session_id: str, *, actor: str, reason_code: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> None:
        lifecycle_storage.log_session(
            conn, db_lock, session_id,
            actor=actor, reason_code=reason_code, payload=payload,
        )

    def _event_sink(
        event_id: str, *, actor: str, reason_code: str,
        payload: Optional[dict[str, Any]] = None,
    ) -> None:
        lifecycle_storage.log_event(
            conn, db_lock, event_id,
            actor=actor, reason_code=reason_code, payload=payload,
        )

    session_capture.set_lifecycle_sink(
        _session_sink, verbose=cfg.lifecycle_verbose,
    )
    # Late import so we don't pull anthropic SDK at module import time.
    from .classifier import classify as _classify_mod
    from .reconciler import reconcile as _reconcile_mod
    _classify_mod.set_lifecycle_sink(_event_sink)
    _reconcile_mod.set_lifecycle_sink(_session_sink)
    # Now that scale_handler exists, build web_repo with the
    # apply-reviewed-candidate wiring. When a user resolves a
    # ``low_confidence`` review by picking a candidate, the adapter
    # calls back into scale_handler to actually mint/update the lot.
    web_repo = adapters.RepoWebAdapter(
        conn,
        db_lock=db_lock,
        apply_reviewed_candidate_fn=scale_handler.apply_user_reviewed_candidate,
        catch_all_device_id=cfg.catch_all_device_id,
    )
    brightness_handler = BrightnessHandler(
        conn=conn,
        db_lock=db_lock,
        reconciler_repo=reconciler_repo,
        last_weight_provider=_last_weight_from_state(conn, db_lock),
    )
    camera.on_brightness_transition(brightness_handler)

    # Capture per-session before/after frames on door open/close. Events
    # fired during the session stay "pending" until close; the callback
    # below classifies all pending events in the session's window once
    # the close lands (frames + video are available at that point).
    session_capture.register(
        camera,
        cfg.data_root / "sessions",
        on_close_callback=scale_handler.process_session_events,
    )

    # Background sweeper for events that never match a session (e.g.,
    # door closed with no lit frames at event time). The sweeper marks
    # them failed after a grace window, and also catches post-close
    # events whose session landed after handle_scale_event returned.
    scale_handler.start_sweeper()

    # Daily disk-retention sweeper. ``data/events/``, ``data/sessions/``
    # and ``data/diag/`` accumulate per-run directories forever without
    # intervention; this trims anything older than 14 days.
    start_disk_retention_sweeper(cfg.data_root)

    # Lifecycle tables + system_health: 30-day retention; snapshot every 60s.
    start_lifecycle_retention_sweeper(conn, db_lock)
    start_system_health_snapshot_thread(conn, db_lock)

    # --- Flask -----------------------------------------------------------
    app = Flask(__name__)
    app.config["TESTING"] = False
    # Cap the body size Flask will buffer before returning 413. 16 MiB
    # comfortably covers multi-image intake uploads and full-resolution
    # frames while protecting the 1-core Pi from OOM under a naive DOS
    # (repeated multi-GB bodies to /api/scale-event etc.).
    app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

    # Late-binding reference dict so the ``/healthz`` route (registered
    # before the cloud worker is constructed further down) can observe
    # the worker's live state. Mutated right after CloudWorker.start().
    # Dict-in-a-closure is the minimal way to carry a single mutable
    # reference into the route without routing the full AppBundle
    # through it.
    bundle_ref: dict[str, Any] = {"cloud_worker": None}

    # Shelf camera registry — consumed by the MJPEG route (and future
    # per-shelf frame-picker code). Always contains a ``live_shelf``
    # entry; ``catch_all`` is present-but-None when the flag is on but
    # the hardware didn't initialize. We use ``app.extensions`` rather
    # than ``app.config`` to keep these non-JSON-serializable objects
    # out of any config-dump path.
    app.extensions["shelf_cameras"] = {
        "live_shelf": camera,
        "catch_all": catch_all_camera,
    }

    # Config read/write for /api/config.
    def _read_config() -> dict[str, Any]:
        return cfg.as_dict()

    def _update_config(patch: dict[str, Any]) -> dict[str, Any]:
        updated = apply_config_patch(cfg, patch)
        # Reflect live-updatable knobs into the camera daemon.
        camera.config.brightness_threshold = cfg.brightness_threshold
        camera.config.brightness_hysteresis = cfg.brightness_hysteresis
        camera.config.capture_fps = cfg.capture_fps
        scale_handler._delta_threshold_g = cfg.event_delta_threshold_g
        scale_handler._lookback = cfg.frame_lookback_seconds
        scale_handler._recently_out_window_seconds = cfg.recently_out_window_seconds
        # Reflect the catch-all enable flag so runtime /api/config flips
        # actually take effect in handle_scale_event's reject-unknown-device
        # gate. Without this, the handler keeps the boot-time value.
        scale_handler._catch_all_enabled = cfg.catch_all_enabled
        return updated

    def _force_open_session() -> dict[str, Any]:
        """Manual session-open trigger for bench demos.

        Uses the same brightness-transition callback used by the live
        camera so session semantics are identical (opens session, emits
        BrightnessTransition-style bookkeeping). If a session is already
        open, returns the current id rather than erroring.
        """
        from datetime import datetime, timezone
        from .camera.daemon import BrightnessTransition

        with db_lock:
            state = storage_repo.get_app_state(conn)
            if state.door_open and state.current_session_id:
                return {
                    "already_open": True,
                    "session_id": state.current_session_id,
                }
        # Use the shared helper so seconds + millis come from the same
        # datetime.now() call — two separate calls can straddle a
        # second boundary (produces e.g. 2026-04-16T23:59:59.001Z
        # where the seconds and millis are from different wall seconds).
        ts = now_iso_utc_ms()
        # Invoke the brightness handler synchronously (on the request
        # thread). It opens the session under the shared DB lock and
        # does not block on anything heavy.
        brightness_handler(BrightnessTransition("open", ts, 255.0))
        with db_lock:
            state = storage_repo.get_app_state(conn)
        return {
            "session_id": state.current_session_id,
            "ts": ts,
        }

    def _delete_product(product_id: str) -> dict[str, Any]:
        """Delete a single product + its lots + its reference images.

        Used by the per-row X button on the catalog table in /inventory.
        Raises LookupError if the product doesn't exist (route maps that
        to 404).
        """
        import shutil
        with db_lock:
            existing = storage_repo.get_product(conn, product_id)
            if existing is None:
                raise LookupError(f"product not found: {product_id!r}")
            counts = storage_repo.delete_product(conn, product_id)
        # Remove the on-disk reference-image directory for this product.
        refs_dir = Path(cfg.refs_root) / product_id
        refs_removed = False
        if refs_dir.exists():
            shutil.rmtree(refs_dir, ignore_errors=True)
            refs_removed = not refs_dir.exists()
        log.warning(
            "product delete: id=%s rows=%s refs_removed=%s",
            product_id, counts, refs_removed,
        )
        return {
            "product_id": product_id,
            "rows_deleted": counts,
            "refs_removed": refs_removed,
        }

    def _delete_lot(lot_id: str) -> dict[str, Any]:
        """Delete a single lot (inventory row). The underlying product
        stays in the catalog. Raises LookupError if the lot doesn't exist.
        """
        with db_lock:
            existing = storage_repo.get_lot(conn, lot_id)
            if existing is None:
                raise LookupError(f"lot not found: {lot_id!r}")
            counts = storage_repo.delete_lot(conn, lot_id)
        log.warning("lot delete: id=%s rows=%s", lot_id, counts)
        return {"lot_id": lot_id, "rows_deleted": counts}

    def _delete_usage(usage_id: str) -> dict[str, Any]:
        """Delete a single usage_log row + revert consumption on the lot.

        Called by POST /api/usage/<usage_id>/delete (the × button in the
        inventory page's usage log). Idempotent — unknown ids return
        ``deleted: 0`` without raising.
        """
        with db_lock:
            summary = storage_repo.delete_usage_log(conn, usage_id)
        log.info("usage delete: id=%s summary=%s", usage_id, summary)
        return summary

    def _force_close_session() -> dict[str, Any]:
        """Manual session-close trigger for bench demos.

        If no session is open, returns ``{"no_session": True}``.
        Otherwise invokes the brightness handler's close path, which
        closes the DB session. The reconciler is spawned downstream by
        ScaleHandler.process_session_events (the second close subscriber)
        once all pending events for this session have been classified.
        """
        from datetime import datetime, timezone
        from .camera.daemon import BrightnessTransition

        with db_lock:
            state = storage_repo.get_app_state(conn)
            session_id = state.current_session_id
            if not session_id:
                return {"no_session": True}
        # Same second-boundary fix as _force_open_session: single
        # datetime.now() via the shared helper.
        ts = now_iso_utc_ms()
        brightness_handler(BrightnessTransition("close", ts, 0.0))
        return {"session_id": session_id, "ts": ts}

    def _wipe_all() -> dict[str, Any]:
        """Destroy transactional rows + on-disk run artifacts. Keep the
        product catalog (and its reference images) + app_state + camera cal.

        Called by POST /api/admin/wipe (top-right "wipe" button). Idempotent:
        runs DELETEs in FK-safe order, then cleans events/, sessions/, and
        diag/ dirs on disk. The ``products``/``product_reference_images``
        tables and ``data/refs/`` directory are preserved so the user keeps
        their registered catalog (barcodes, expected weights, reference
        images) across wipes.

        Also clears the scale handler's dedup LRU so stale event_seq numbers
        can't suppress fresh events after a wipe.
        """
        import shutil
        # Order matters — children before parents for FK safety. The
        # product catalog (products + product_reference_images) is
        # intentionally NOT in this list.
        tables = (
            # usage_log first — it has FKs into lots, products, sessions,
            # and scale_events, so it must drain before any of those.
            "usage_log",
            "review_queue",
            "session_resolutions",
            "scale_events",
            "lots",
            "sessions",
        )
        counts: dict[str, int] = {}
        # Lifecycle: announce wipe starting. Uses a synthetic session_id
        # of "admin" so the trail lives in session_lifecycle for audit.
        try:
            lifecycle_storage.log_session(
                conn, db_lock, "admin:wipe",
                actor="user",
                reason_code=ReasonCode.WIPE_STARTED,
                payload={"tables": list(tables)},
            )
        except Exception:  # pragma: no cover - defensive
            pass
        with db_lock:
            # Bump the wipe epoch FIRST, under the same lock, BEFORE the
            # DELETEs. This closes a race where a classifier worker that
            # finished its Anthropic call pre-wipe and was blocked on
            # db_lock during this critical section could wake up between
            # the DELETE and a post-lock epoch bump, see the old epoch,
            # and mint a phantom catalog lot referencing a surviving
            # product. With the bump first, any worker that acquires
            # this lock after we release sees the new epoch on its very
            # next check and aborts before writing.
            try:
                new_epoch = scale_handler.bump_wipe_epoch()
                log.info("wipe: bumped wipe_epoch to %d", new_epoch)
            except AttributeError:
                pass
            # Single atomic transaction — if any DELETE fails we roll
            # back rather than leaving the DB half-wiped. Order matters
            # for FK safety AND app_state.current_session_id has a
            # non-cascading FK to sessions, so that pointer must be
            # cleared BEFORE deleting the sessions table.
            with conn:
                conn.execute(
                    "UPDATE app_state SET current_session_id = NULL, "
                    "door_open = 0 WHERE id = 1"
                )
                for t in tables:
                    before = conn.execute(
                        f"SELECT count(*) FROM {t}"
                    ).fetchone()[0]
                    conn.execute(f"DELETE FROM {t}")
                    counts[t] = before
        # Clear the scale handler's dedup LRU and per-device uptime
        # tracker so post-wipe events with seq=0 aren't rejected as
        # duplicates. Use the handler's own locks — a concurrent
        # heartbeat could otherwise mutate the LRU between our read
        # and clear. Fall back to no-op on legacy handler objects
        # without the _*_lock attributes.
        try:
            with scale_handler._dedup_lock:
                scale_handler._dedup.clear()
        except (AttributeError, RuntimeError):
            pass
        try:
            with scale_handler._uptime_lock:
                scale_handler._last_uptime_s.clear()
        except (AttributeError, RuntimeError):
            pass
        # Wipe on-disk artifacts. Note: ``refs/`` is intentionally excluded
        # — reference images belong to the registered product catalog.
        events_dir = Path(cfg.events_root)
        sessions_dir = Path(cfg.data_root) / "sessions"
        diag_dir = Path(cfg.data_root) / "diag"
        file_counts = {"events": 0, "sessions": 0, "diag": 0}
        for label, root in (
            ("events", events_dir),
            ("sessions", sessions_dir),
            ("diag", diag_dir),
        ):
            if not root.exists():
                continue
            for child in root.iterdir():
                if child.is_dir():
                    shutil.rmtree(child, ignore_errors=True)
                else:
                    try:
                        child.unlink()
                    except OSError:
                        continue
                file_counts[label] += 1
        log.warning(
            "admin wipe: rows=%s files=%s (products + refs preserved)",
            counts, file_counts,
        )
        # Reset the session-capture module's in-memory state so a stale
        # open-session handle from before the wipe can't reattach to the
        # now-deleted session row on the next door-open transition.
        session_capture.reset()
        try:
            lifecycle_storage.log_session(
                conn, db_lock, "admin:wipe",
                actor="user",
                reason_code=ReasonCode.WIPE_COMPLETED,
                payload={
                    "rows_deleted": counts,
                    "dirs_cleaned": file_counts,
                },
            )
        except Exception:  # pragma: no cover - defensive
            pass
        return {
            "rows_deleted": counts,
            "dirs_cleaned": file_counts,
            "preserved": ["products", "product_reference_images", "refs/"],
        }

    # Intake
    # When ``intake_cloud_enabled`` is True the blueprint routes product
    # creation through ``POST /intake`` on the cloud and uses
    # ``upsert_product_from_cloud`` to write-through the local cache.
    # Both producer (worker) and sync (intake) share the single
    # ``cloud_client`` we built above.
    intake_bp = create_intake_bp(
        repo=intake_repo,
        camera=camera_source,
        refs_root=cfg.refs_root,
        cloud_enabled=intake_cloud_enabled,
        cloud_client=cloud_client,
        cloud_upsert_fn=upsert_product_from_cloud,
        db_conn=conn,
        db_lock=db_lock,
    )
    app.register_blueprint(intake_bp)

    # Web HTML + API
    html_bp = make_html_bp(
        web_repo,
        data_dir=cfg.data_root,
        # Read the live config each time — a POST /api/config flip to
        # catch_all_enabled takes effect on the next page render without
        # a restart.
        catch_all_enabled=lambda: bool(getattr(cfg, "catch_all_enabled", False)),
    )
    api_bp = make_api_bp(
        web_repo,
        read_config=_read_config,
        update_config=_update_config,
        wipe_fn=_wipe_all,
        force_open_session=_force_open_session,
        force_close_session=_force_close_session,
        delete_product_fn=_delete_product,
        delete_lot_fn=_delete_lot,
        delete_usage_fn=_delete_usage,
        # Default target for the dashboard's auto-exposure toggle. The
        # button sends no ``device`` field, and the old hardcoded
        # /dev/video0 default targets the HD Web Camera (no exposure
        # controls). Pass the resolved live-shelf camera so the button
        # actually drives the camera that's producing session frames.
        default_camera_device=cfg.camera_device,
    )
    app.register_blueprint(html_bp)
    app.register_blueprint(api_bp)

    # Debug + observability routes (JSON + HTML timelines).
    app.register_blueprint(make_debug_bp(conn, db_lock))

    # Scale + heartbeat
    app.register_blueprint(make_scale_bp(scale_handler))

    # Live MJPEG — accepts ``?shelf=live_shelf`` (default) or
    # ``?shelf=catch_all`` (CATCH_ALL_SCALE_PLAN.md §5.2). When the
    # catch-all shelf is requested but the hardware is absent, return
    # 503 so the UI can distinguish "offline hardware" from "streaming".
    @app.route("/live.mjpg")
    def live_mjpg():
        from flask import request
        shelf = request.args.get("shelf") or mjpeg.DEFAULT_SHELF_KEY
        registry = app.extensions.get("shelf_cameras", {})
        # resolve_daemon now distinguishes unknown shelf names (KeyError)
        # from known shelves whose hardware is absent (returns None). Map
        # unknown → 404 so UI / ops can tell a typo from a missing camera.
        try:
            daemon = mjpeg.resolve_daemon(registry, shelf)
        except KeyError:
            return (
                {"error": f"unknown shelf={shelf!r}"},
                404,
            )
        if daemon is None:
            return (
                {"error": f"no camera registered for shelf={shelf!r}"},
                503,
            )
        return Response(
            mjpeg.stream(daemon),
            mimetype="multipart/x-mixed-replace; boundary=frame",
        )

    # Health check — reports actionable fields so operators can diagnose
    # silent failures (dead camera thread, stuck DB lock, missing API key,
    # dead cloud worker, growing outbox backlog, permanent-failure
    # queue). Finding #8 of the deep audit adds the cloud fields.
    @app.get("/healthz")
    def healthz():
        # Last frame freshness — camera thread could be alive but not
        # producing frames (driver hang, USB disconnect).
        last_frame_ts = getattr(camera, "last_frame_ts", None)
        last_frame_age_s: Optional[float] = None
        if last_frame_ts:
            try:
                ts_dt = datetime.fromisoformat(
                    str(last_frame_ts).replace("Z", "+00:00")
                )
                last_frame_age_s = (
                    datetime.now(timezone.utc) - ts_dt
                ).total_seconds()
            except ValueError:
                last_frame_age_s = None
        camera_stale = (
            last_frame_age_s is None or last_frame_age_s > 5.0
        )
        # DB reachable check — keep it cheap.
        db_ok = False
        try:
            with db_lock:
                conn.execute("SELECT 1").fetchone()
            db_ok = True
        except Exception:  # pragma: no cover - defensive
            db_ok = False
        # Anthropic API key present?
        api_key_ok = bool(os.environ.get("ANTHROPIC_API_KEY"))

        # --- Cloud-side fields (finding #8) ---------------------------
        # cloud_enabled mirrors the config knob — tells operators whether
        # CLOUD_ENABLED=true was set on this boot. Even when disabled we
        # surface the field so dashboards can detect the flag flip.
        cloud_enabled = bool(cfg.cloud_enabled)
        cloud_worker_alive: Optional[bool] = None
        cloud_outbox_pending: Optional[int] = None
        cloud_outbox_permanent_failures: Optional[int] = None
        if cloud_enabled:
            # If the worker object exists, query is_alive(); otherwise
            # the feature flag is on but startup decided not to spin one
            # up (missing URL/key). Operators should see False, not None,
            # so the /healthz consumer can alarm on that state.
            cloud_worker_alive = (
                bool(bundle_ref["cloud_worker"].is_alive())
                if bundle_ref.get("cloud_worker") is not None
                else False
            )
            try:
                from .cloud import outbox as _outbox_mod
                with db_lock:
                    cloud_outbox_pending = _outbox_mod.count_pending(conn)
                    cloud_outbox_permanent_failures = (
                        _outbox_mod.count_permanent_failures(conn)
                    )
            except Exception:  # pragma: no cover - defensive
                # Table missing (fresh DB before migrations) / other
                # DB error. Report None so the consumer knows we
                # couldn't read rather than a misleading 0.
                cloud_outbox_pending = None
                cloud_outbox_permanent_failures = None

        # When the cloud is meant to be on but the worker isn't, the
        # top-level ``ok`` flag must flip — a silent dead worker is
        # exactly the "queue forever, no drainer" failure mode the
        # audit finding is about.
        ok = (
            bool(camera.is_alive())
            and not camera_stale
            and db_ok
        )
        if cloud_enabled and cloud_worker_alive is not True:
            ok = False

        return {
            "ok": ok,
            "camera_alive": bool(camera.is_alive()),
            "camera_last_frame_age_s": last_frame_age_s,
            "camera_stale": camera_stale,
            "frames_captured": getattr(camera, "frames_captured", None),
            "grab_failures": getattr(camera, "grab_failures", None),
            "db_ok": db_ok,
            "anthropic_api_key_present": api_key_ok,
            "cloud_enabled": cloud_enabled,
            "cloud_worker_alive": cloud_worker_alive,
            "cloud_outbox_pending": cloud_outbox_pending,
            "cloud_outbox_permanent_failures": cloud_outbox_permanent_failures,
        }, (200 if ok else 503)

    # --- Launch camera thread(s) ----------------------------------------
    if start_camera:
        camera.start()
        if catch_all_camera is not None:
            try:
                catch_all_camera.start()
            except Exception:  # pragma: no cover - depends on hardware
                log.warning(
                    "catch-all camera start() failed; continuing without it",
                    exc_info=True,
                )

    # --- Cloud worker (PROD_MIGRATION_PLAN.md Phase 2) ------------------
    # Drains ``cloud_outbox`` + sends periodic heartbeats when the flag
    # is on AND both URL + import key are populated. Any of those
    # missing → log and skip startup; the app still runs standalone.
    cloud_worker: Optional[CloudWorker] = None
    if (
        cfg.cloud_enabled
        and cfg.cloud_url
        and cfg.cloud_import_key
        and cloud_client is not None
    ):
        try:
            # Cache the "scale_pairings missing" state so the first
            # sqlite OperationalError logs WARNING once, then every
            # subsequent heartbeat silently skips the scales query
            # until something re-creates the table. On a fresh Pi the
            # migrations haven't run yet and every 30s tick would
            # otherwise flood the log.
            _pairings_state: dict[str, bool] = {"missing": False}

            # Canonical scales derived from the static shelves registry so
            # the cloud UI can surface them the moment the Pi heartbeats,
            # even before any ESP event has landed in the local
            # ``scale_pairings`` table. Local rows (from auto-register
            # handlers, future single_item) MERGE on top, preserving
            # whatever extra scale_ids the Pi has seen.
            _registry_scales: list[dict[str, str]] = [
                {"scale_id": s.device_id, "kind": s.shelf_id}
                for s in _shelf_registry.values()
            ]

            def _heartbeat_provider() -> dict[str, Any]:
                """Assemble the heartbeat body from live Pi state.

                Reads under the shared ``db_lock`` to stay consistent
                with writers. Every field degrades gracefully (defaults
                to 0 / empty list) so a transient DB error can't kill
                the heartbeat — the worker's ``except`` handler will
                still log and continue.

                Finding #10: the heartbeat now carries the outbox
                pending + permanent-failure counts so the cloud UI can
                surface backlog state without needing a separate probe.
                Cloud side is expected to persist these on the device
                row (handled by a different agent).
                """
                pending_count = 0
                outbox_pending = 0
                outbox_permanent_failures = 0
                # Start with the static registry — always included so the
                # cloud UI can render the hardware this Pi is configured
                # for regardless of local DB state.
                merged: dict[str, str] = {
                    s["scale_id"]: s["kind"] for s in _registry_scales
                }
                try:
                    with db_lock:
                        pr = conn.execute(
                            "SELECT COUNT(*) FROM review_queue "
                            "WHERE status = 'pending'"
                        ).fetchone()
                        pending_count = int(pr[0] or 0) if pr else 0
                        rows: list[Any] = []
                        if not _pairings_state["missing"]:
                            try:
                                rows = conn.execute(
                                    "SELECT DISTINCT device_id, shelf_id "
                                    "  FROM scale_pairings "
                                    " ORDER BY device_id"
                                ).fetchall()
                                _pairings_state["missing"] = False
                            except sqlite3.OperationalError as exc:
                                msg = str(exc).lower()
                                if "no such table" in msg and "scale_pairings" in msg:
                                    log.warning(
                                        "heartbeat_provider: scale_pairings "
                                        "table missing; suppressing further "
                                        "warnings until it exists",
                                    )
                                    _pairings_state["missing"] = True
                                else:
                                    raise
                        # Outbox observability. Same db_lock acquisition
                        # as the other reads to keep the scan cheap +
                        # consistent. Defensive try/except around each
                        # call so a fresh DB without cloud_outbox still
                        # heartbeats (zero + log).
                        try:
                            from .cloud import outbox as _ob  # local import
                            outbox_pending = _ob.count_pending(conn)
                            outbox_permanent_failures = (
                                _ob.count_permanent_failures(conn)
                            )
                        except Exception:  # noqa: BLE001
                            outbox_pending = 0
                            outbox_permanent_failures = 0
                    # Merge local rows on top; local takes precedence
                    # because it reflects runtime auto-registration.
                    for r in rows:
                        did = str(r["device_id"])
                        merged[did] = str(r["shelf_id"] or merged.get(did, "live_shelf"))
                except Exception:  # pragma: no cover - defensive
                    log.warning(
                        "heartbeat_provider: DB read failed",
                        exc_info=True,
                    )
                scales = [
                    {"scale_id": sid, "kind": kind}
                    for sid, kind in sorted(merged.items())
                ]
                return {
                    "pending_review_count": pending_count,
                    "scales": scales,
                    "outbox_pending_count": outbox_pending,
                    "outbox_permanent_failures": outbox_permanent_failures,
                }

            # Finding #5 back-fill: scan recent resolutions for rows
            # whose outbox mirror was lost to a crash between the
            # local commit and the outbox insert. Safe no-op on a
            # fresh boot. Must run BEFORE the worker starts so the
            # re-emitted rows land in outbox order ahead of any live
            # emissions from the first heartbeat tick.
            try:
                with db_lock:
                    back_filled = backfill_missing_outbox_events(
                        conn, cloud_emitter,
                        window_hours=int(cfg.cloud_backfill_window_hours),
                    )
                if back_filled:
                    log.info(
                        "startup: back-filled %d orphan outbox event(s) "
                        "(window=%dh)",
                        back_filled, cfg.cloud_backfill_window_hours,
                    )
            except Exception:  # pragma: no cover - defensive
                log.warning(
                    "startup: backfill_missing_outbox_events raised",
                    exc_info=True,
                )

            cloud_worker = CloudWorker(
                client=cloud_client,
                conn_factory=lambda: conn,
                heartbeat_provider=_heartbeat_provider,
                poll_interval_s=float(cfg.cloud_heartbeat_interval_s),
            )
            cloud_worker.start()
            # Late-bind into the /healthz closure so the route can
            # observe the worker's is_alive state.
            bundle_ref["cloud_worker"] = cloud_worker
            log.info(
                "cloud worker started (url=%s, heartbeat=%ss)",
                cfg.cloud_url, cfg.cloud_heartbeat_interval_s,
            )

            # LiveTrack Import poller (2026-04-21-livetrack-import-wizard.md).
            # Same CloudClient, separate thread. The handler reads its
            # snapshot to short-circuit catch-all events when the cloud UI
            # has armed an import session. A failed seed-poll just leaves
            # the snapshot empty; the background loop will pick it up on
            # the next tick.
            try:
                livetrack_poller = LiveTrackPoller(
                    cloud_client, camera=camera,
                )
                livetrack_poller.seed_snapshot()
                scale_handler.set_livetrack_poller(livetrack_poller)
                livetrack_poller.start()
                log.info("livetrack import poller started")
            except Exception:  # pragma: no cover - defensive
                log.exception(
                    "failed to start livetrack import poller; "
                    "import-arm interception disabled",
                )
        except Exception:  # pragma: no cover - defensive
            log.exception(
                "failed to start cloud worker; events will queue locally",
            )
            cloud_worker = None
    else:
        if not cfg.cloud_enabled:
            log.info(
                "cloud integration disabled; events will not sync."
            )
        # The other branch (enabled but missing url/key) already logged
        # a WARNING up at emitter-construction time.

    return AppBundle(
        app=app,
        config=cfg,
        conn=conn,
        db_lock=db_lock,
        camera=camera,
        scale_handler=scale_handler,
        brightness_handler=brightness_handler,
        catch_all_camera=catch_all_camera,
        weight_handler=weight_handler,
        cloud_worker=cloud_worker,
        cloud_emitter=cloud_emitter,
    )


# --------------------------------------------------------------- CLI

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Live Shelf demo server")
    parser.add_argument("--host", help="override WEB_HOST")
    parser.add_argument("--port", type=int, help="override WEB_PORT")
    parser.add_argument(
        "--no-v4l2",
        action="store_true",
        help="skip v4l2 locked-settings (useful off-Pi)",
    )
    parser.add_argument(
        "--no-camera",
        action="store_true",
        help="don't start the camera thread (debug only)",
    )
    parser.add_argument(
        "--data-dir",
        help="override DATA_DIR",
    )
    args = parser.parse_args(argv)

    cfg = load_config()
    if args.data_dir:
        os.environ["DATA_DIR"] = args.data_dir
        cfg = load_config()
    bundle = create_app(
        config=cfg,
        apply_v4l2=not args.no_v4l2,
        start_camera=not args.no_camera,
    )

    host = args.host or cfg.web_host
    port = args.port or cfg.web_port

    # Graceful shutdown on SIGINT / SIGTERM.
    # Note: the `finally` clause below runs `bundle.shutdown()` for us — we
    # must NOT call it here too, otherwise the second call hits a closed
    # sqlite connection and logs a spurious ProgrammingError on every clean
    # exit. Just raise SystemExit and let the try/finally unwind.
    def _sig_handler(signum, frame):  # pragma: no cover - signal path
        log.info("received signal %s", signum)
        sys.exit(0)

    signal.signal(signal.SIGINT, _sig_handler)
    try:
        signal.signal(signal.SIGTERM, _sig_handler)
    except (AttributeError, ValueError):  # pragma: no cover - windows
        pass

    log.info("starting Flask on %s:%d (data_dir=%s)", host, port, cfg.data_root)
    try:
        bundle.app.run(host=host, port=port, threaded=True, use_reloader=False)
    finally:
        bundle.shutdown()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
