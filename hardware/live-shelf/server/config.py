"""Config loader for the Live Shelf orchestrator (Bundle H).

Reads `.env` (via python-dotenv if available) and an optional
`config.json` sitting next to this module. Values are merged with
environment taking precedence, then file, then hardcoded defaults.

The resulting `AppConfig` is a plain dataclass so subsystems can read
their knobs without coupling to the orchestrator module.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

_THIS_DIR = Path(__file__).resolve().parent
_DEFAULT_CONFIG_JSON = _THIS_DIR / "config.json"
_DEFAULT_ENV_FILE = _THIS_DIR / ".env"


# -- Defaults --------------------------------------------------------------
# These mirror the keys documented in `.env.example`. Keep in sync.
DEFAULTS: dict[str, Any] = {
    "ANTHROPIC_API_KEY": "",
    "LIVE_SHELF_MODEL": "claude-sonnet-4-6",
    "CAMERA_INDEX": 0,
    "RESOLUTION_WIDTH": 1280,
    "RESOLUTION_HEIGHT": 720,
    "CAPTURE_FPS": 10,
    "BRIGHTNESS_THRESHOLD": 8.0,
    "BRIGHTNESS_HYSTERESIS": 4.0,
    "WEB_PORT": 8000,
    "WEB_HOST": "0.0.0.0",
    "EVENT_DELTA_THRESHOLD_G": 15.0,
    "DATA_DIR": "./data",
    "CAMERA_DEVICE": "/dev/video0",
    "LOG_LEVEL": "INFO",
    "RECENTLY_OUT_WINDOW_SECONDS": 86_400,
    "DEDUP_LRU_SIZE": 2048,
    "FRAME_LOOKBACK_SECONDS": 2.0,
    # Lifecycle observability: when False (default) high-volume rows
    # (frames_archive_tick on every N frames, sweeper_considered for
    # rows that immediately continue without deciding) are suppressed.
    # Flip to True to capture every transition — use only when actively
    # debugging a specific flow; the DB grows quickly at capture-fps.
    "LIFECYCLE_VERBOSE": False,
    # In-flight tracker (IN_FLIGHT_TRACKER_PLAN.md §9).
    "IN_FLIGHT_TTL_SECONDS": 21_600,        # 6 hours
    "NEW_ITEM_WEIGHT_RATIO": 1.15,          # return > pickup × this → new item
    "CONSUMPTION_NOISE_FLOOR_G": 2.0,       # |consumption| < this clamps to 0
    # Catch-all scale (CATCH_ALL_SCALE_PLAN.md §8). Feature flag stays
    # False until the hardware is physically attached.
    "CATCH_ALL_ENABLED": False,
    "CATCH_ALL_CAMERA_DEVICE": "/dev/video2",
    "CATCH_ALL_PHOTO_DELAY_S": 1.5,
    "CATCH_ALL_ONSCALE_THRESHOLD_G": 5.0,
    "CATCH_ALL_DEVICE_ID": "scale-02",
    # Cloud integration (PROD_MIGRATION_PLAN.md). CLOUD_ENABLED gates
    # every cloud call; when False the Pi runs in standalone mode
    # exactly like before. CLOUD_URL points at the Supabase
    # shelf-ingest edge function (e.g. https://abc.supabase.co/functions/v1);
    # CLOUD_IMPORT_KEY is the per-device key the cloud hashes + looks
    # up in live_shelf_devices. Heartbeat cadence is independent of
    # the worker's adaptive outbox-drain cadence.
    "CLOUD_ENABLED": False,
    "CLOUD_URL": "",
    "CLOUD_IMPORT_KEY": "",
    "CLOUD_HEARTBEAT_INTERVAL_S": 30,
    # Finding #6: how far back the startup self-heal scan walks
    # ``session_resolutions`` looking for rows whose outbox mirror was
    # lost to a crash. Default 7d (168h) — long enough to recover from
    # a week of offline time, short enough to keep the scan cheap as
    # the Pi accumulates resolution history.
    "CLOUD_BACKFILL_WINDOW_HOURS": 168,
    # Image upload to Supabase Storage (mixed-content fix).
    # CLOUD_SUPABASE_URL: project base URL, e.g. https://abc.supabase.co
    # CLOUD_SERVICE_ROLE_KEY: service_role JWT (never sent to browser).
    # Both must be set for image upload to work; if either is empty the
    # upload is skipped and the web app falls back to the LAN URL.
    "CLOUD_SUPABASE_URL": "",
    "CLOUD_SERVICE_ROLE_KEY": "",
}


# -- Helpers ---------------------------------------------------------------


def _load_env_file(env_path: Path) -> dict[str, str]:
    """Minimal .env parser — key=value, # comments, skip blank lines.

    We don't depend on python-dotenv so the orchestrator can boot on a
    barebones Pi. Double/single quoted values are unquoted.
    """
    if not env_path.exists():
        return {}
    out: dict[str, str] = {}
    try:
        content = env_path.read_text(encoding="utf-8")
    except OSError as exc:
        log.warning("could not read %s: %s", env_path, exc)
        return {}
    for raw in content.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if (v.startswith('"') and v.endswith('"')) or (
            v.startswith("'") and v.endswith("'")
        ):
            v = v[1:-1]
        out[k] = v
    return out


def _load_json_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        log.warning("could not parse %s: %s", path, exc)
        return {}


def _coerce(default: Any, raw: Any, key: str | None = None) -> Any:
    """Coerce a raw string/env value into the type of the default.

    On conversion failure we log a warning (with the offending key +
    value) so misconfiguration is visible, then fall back to the
    provided default.
    """
    if raw is None:
        return default
    if isinstance(default, bool):
        s = str(raw).strip().lower()
        return s in {"1", "true", "yes", "on"}
    if isinstance(default, int) and not isinstance(default, bool):
        try:
            return int(raw)
        except (TypeError, ValueError):
            log.warning(
                "config: %s=%r is not a valid %s, using default %r",
                key, raw, type(default).__name__, default,
            )
            return default
    if isinstance(default, float):
        try:
            return float(raw)
        except (TypeError, ValueError):
            log.warning(
                "config: %s=%r is not a valid %s, using default %r",
                key, raw, type(default).__name__, default,
            )
            return default
    return str(raw)


# -- AppConfig -------------------------------------------------------------


@dataclass
class AppConfig:
    """Typed view of the resolved settings.

    All fields have defaults; load() fills them from env + config.json.
    """

    anthropic_api_key: str = ""
    live_shelf_model: str = "claude-sonnet-4-6"
    camera_index: int = 0
    resolution_width: int = 1280
    resolution_height: int = 720
    capture_fps: int = 10
    brightness_threshold: float = 8.0
    brightness_hysteresis: float = 4.0
    web_port: int = 8000
    web_host: str = "0.0.0.0"
    event_delta_threshold_g: float = 15.0
    data_dir: str = "./data"
    camera_device: str = "/dev/video0"
    log_level: str = "INFO"
    recently_out_window_seconds: int = 86_400
    dedup_lru_size: int = 2048
    frame_lookback_seconds: float = 2.0
    lifecycle_verbose: bool = False
    # In-flight tracker knobs.
    in_flight_ttl_seconds: int = 21_600
    new_item_weight_ratio: float = 1.15
    consumption_noise_floor_g: float = 2.0
    # Catch-all scale knobs (CATCH_ALL_SCALE_PLAN.md §8).
    catch_all_enabled: bool = False
    catch_all_camera_device: str = "/dev/video2"
    catch_all_photo_delay_s: float = 1.5
    catch_all_onscale_threshold_g: float = 5.0
    catch_all_device_id: str = "scale-02"
    # Cloud integration knobs (boot-time only — not in MUTABLE_CONFIG_KEYS).
    cloud_enabled: bool = False
    cloud_url: str = ""
    cloud_import_key: str = ""
    cloud_heartbeat_interval_s: int = 30
    cloud_backfill_window_hours: int = 168
    cloud_supabase_url: str = ""
    cloud_service_role_key: str = ""
    # Path roots — computed post-load.
    data_root: Path = field(default_factory=lambda: Path("./data").resolve())
    refs_root: Path = field(default_factory=lambda: Path("./data/refs").resolve())
    events_root: Path = field(
        default_factory=lambda: Path("./data/events").resolve()
    )
    db_path: Path = field(
        default_factory=lambda: Path("./data/shelf.sqlite3").resolve()
    )

    @property
    def resolution(self) -> tuple[int, int]:
        return (self.resolution_width, self.resolution_height)

    def as_dict(self) -> dict[str, Any]:
        """Dict view used by `GET /api/config`. Paths coerced to str."""
        out: dict[str, Any] = {}
        for f in fields(self):
            value = getattr(self, f.name)
            if isinstance(value, Path):
                value = str(value)
            out[f.name] = value
        # Anthropic key is redacted in UI context.
        if out.get("anthropic_api_key"):
            out["anthropic_api_key"] = "***redacted***"
        # Cloud import key and service_role key are secrets — same redaction.
        if out.get("cloud_import_key"):
            out["cloud_import_key"] = "***redacted***"
        if out.get("cloud_service_role_key"):
            out["cloud_service_role_key"] = "***redacted***"
        return out


# -- Public API ------------------------------------------------------------


# Keys that `POST /api/config` is allowed to update live. Everything else
# (paths, API key) is considered boot-time config.
MUTABLE_CONFIG_KEYS: frozenset[str] = frozenset(
    {
        "brightness_threshold",
        "brightness_hysteresis",
        "event_delta_threshold_g",
        "capture_fps",
        "live_shelf_model",
        "recently_out_window_seconds",
        "frame_lookback_seconds",
        "in_flight_ttl_seconds",
        "new_item_weight_ratio",
        "consumption_noise_floor_g",
        "catch_all_enabled",
        "catch_all_photo_delay_s",
        "catch_all_onscale_threshold_g",
    }
)


def _build_from_merged(merged: dict[str, Any]) -> AppConfig:
    """Produce AppConfig from a merged {UPPER_KEY: raw} dict."""
    cfg = AppConfig()
    # Map DEFAULTS keys → dataclass attribute.
    mapping: dict[str, str] = {k: k.lower() for k in DEFAULTS}
    for up_key, default_val in DEFAULTS.items():
        attr = mapping[up_key]
        if not hasattr(cfg, attr):
            continue
        raw = merged.get(up_key, default_val)
        setattr(cfg, attr, _coerce(default_val, raw, key=up_key))

    # Derive paths.
    root = Path(cfg.data_dir).expanduser().resolve()
    cfg.data_root = root
    cfg.refs_root = root / "refs"
    cfg.events_root = root / "events"
    cfg.db_path = root / "shelf.sqlite3"
    return cfg


def load_config(
    *,
    env_file: Optional[Path] = None,
    config_json: Optional[Path] = None,
) -> AppConfig:
    """Resolve config from defaults + optional .env + optional config.json.

    Precedence (low→high): DEFAULTS < config.json < .env file < os.environ.
    """
    env_path = env_file or _DEFAULT_ENV_FILE
    json_path = config_json or _DEFAULT_CONFIG_JSON

    merged: dict[str, Any] = dict(DEFAULTS)
    # config.json keys may be lowercase/dataclass-style; accept both shapes.
    file_cfg = _load_json_config(json_path)
    for k, v in file_cfg.items():
        merged[k.upper()] = v

    file_env = _load_env_file(env_path)
    for k, v in file_env.items():
        merged[k] = v
        # Push .env values into os.environ (if not already set there) so
        # downstream code paths that read os.environ directly —
        # classifier.anthropic_client, intake.ai_tare — see the same values
        # the config.py resolver did. Mirrors python-dotenv's default behavior.
        # Skip empty-string values: an empty `FOO=` in .env must not shadow a
        # real value in the actual environment nor make membership checks
        # return True with a useless "" that tricks downstream code.
        if k not in os.environ and v:
            os.environ[k] = str(v)

    for k in list(merged.keys()):
        if k in os.environ:
            merged[k] = os.environ[k]

    return _build_from_merged(merged)


def ensure_data_dirs(cfg: AppConfig) -> None:
    """Create the data subdirectories if they don't exist yet."""
    for path in (cfg.data_root, cfg.refs_root, cfg.events_root):
        path.mkdir(parents=True, exist_ok=True)


# Per-key range validators. Each predicate returns True if the (already
# coerced) value is acceptable. Kept as a small lookup table so future keys
# can be added here without touching the patch-apply logic.
_MUTABLE_RANGE_VALIDATORS: dict[str, Any] = {
    "capture_fps": lambda v: v >= 1,
    "brightness_threshold": lambda v: v > 0,
    "brightness_hysteresis": lambda v: v >= 0,
    "event_delta_threshold_g": lambda v: v > 0,
    "frame_lookback_seconds": lambda v: v > 0,
    "recently_out_window_seconds": lambda v: v >= 0,
    "in_flight_ttl_seconds": lambda v: v >= 0,
    "new_item_weight_ratio": lambda v: v > 1.0,
    "consumption_noise_floor_g": lambda v: v >= 0,
    "catch_all_photo_delay_s": lambda v: v >= 0,
    "catch_all_onscale_threshold_g": lambda v: v > 0,
}


def apply_config_patch(cfg: AppConfig, patch: dict[str, Any]) -> dict[str, Any]:
    """Apply a config update coming from `POST /api/config`.

    Only keys listed in :data:`MUTABLE_CONFIG_KEYS` are writable; everything
    else raises ``ValueError``. Numeric keys are additionally range-checked
    via :data:`_MUTABLE_RANGE_VALIDATORS` so a bad POST (e.g. ``capture_fps=0``)
    can't crash the capture loop. Returns the post-patch config dict view.
    """
    for key, value in patch.items():
        if key not in MUTABLE_CONFIG_KEYS:
            raise ValueError(f"unknown or immutable config key: {key!r}")
        current = getattr(cfg, key)
        coerced = _coerce(current, value, key=key)
        validator = _MUTABLE_RANGE_VALIDATORS.get(key)
        if validator is not None and not validator(coerced):
            raise ValueError(f"{key}: value {coerced} outside valid range")
        setattr(cfg, key, coerced)
    return cfg.as_dict()


__all__ = [
    "AppConfig",
    "DEFAULTS",
    "MUTABLE_CONFIG_KEYS",
    "apply_config_patch",
    "ensure_data_dirs",
    "load_config",
]
