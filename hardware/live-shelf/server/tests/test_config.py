"""Direct unit tests for ``server.config.apply_config_patch``.

``POST /api/config`` funnels live config updates through
``apply_config_patch``. The whitelist (``MUTABLE_CONFIG_KEYS``) and per-key
range validators (``_MUTABLE_RANGE_VALIDATORS``) are the last line of
defense against a bad POST crashing the capture loop or pivoting config
state we never intended to be mutable at runtime (e.g. ``db_path``).

Previously this path was only exercised via the `/api/config` endpoint
in ``test_integration.py::test_api_state_and_config`` — and only the
happy-path branch. These tests pin the three failure-mode branches so a
regression can't silently reopen an unsafe mutation channel.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make ``server.config`` importable when pytest is run from the repo root.
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.config import (  # noqa: E402
    AppConfig,
    MUTABLE_CONFIG_KEYS,
    apply_config_patch,
)


# ---------------------------------------------------------------------------
# In-flight tracker knobs (§9 of IN_FLIGHT_TRACKER_PLAN.md)
# ---------------------------------------------------------------------------


def test_default_event_delta_threshold_is_15g():
    """Documented default per user request — ensures we don't drift."""
    cfg = AppConfig()
    assert cfg.event_delta_threshold_g == 15.0


def test_apply_config_patch_accepts_in_flight_knobs():
    cfg = AppConfig()
    assert cfg.in_flight_ttl_seconds == 14_400
    assert cfg.new_item_weight_ratio == 1.15
    assert cfg.consumption_noise_floor_g == 2.0

    apply_config_patch(cfg, {
        "in_flight_ttl_seconds": 3600,
        "new_item_weight_ratio": 1.25,
        "consumption_noise_floor_g": 5.0,
    })
    assert cfg.in_flight_ttl_seconds == 3600
    assert cfg.new_item_weight_ratio == 1.25
    assert cfg.consumption_noise_floor_g == 5.0


def test_apply_config_patch_rejects_invalid_new_item_ratio():
    """A ratio ≤ 1.0 would classify any return as a replacement — the
    validator must reject it."""
    cfg = AppConfig()
    with pytest.raises(ValueError, match="new_item_weight_ratio"):
        apply_config_patch(cfg, {"new_item_weight_ratio": 1.0})
    with pytest.raises(ValueError, match="new_item_weight_ratio"):
        apply_config_patch(cfg, {"new_item_weight_ratio": 0.5})


def test_apply_config_patch_rejects_negative_in_flight_ttl():
    cfg = AppConfig()
    with pytest.raises(ValueError, match="in_flight_ttl_seconds"):
        apply_config_patch(cfg, {"in_flight_ttl_seconds": -1})


def test_apply_config_patch_rejects_negative_noise_floor():
    cfg = AppConfig()
    with pytest.raises(ValueError, match="consumption_noise_floor_g"):
        apply_config_patch(cfg, {"consumption_noise_floor_g": -0.1})


def test_apply_config_patch_rejects_non_whitelisted_key():
    """Regression guard: any key outside MUTABLE_CONFIG_KEYS must raise.

    The handoff explicitly calls out that paths and the API key are
    boot-time only — silently accepting a ``db_path`` update would let
    a malicious or buggy admin UI redirect the DB without a restart,
    orphaning the live connection. The whitelist must reject by name.
    """
    cfg = AppConfig()
    # ``db_path`` is deliberately not in MUTABLE_CONFIG_KEYS.
    assert "db_path" not in MUTABLE_CONFIG_KEYS
    original = cfg.db_path

    with pytest.raises(ValueError) as excinfo:
        apply_config_patch(cfg, {"db_path": "/tmp/hack"})

    # Error message must mention the offending key so the UI can surface
    # it to the operator.
    assert "db_path" in str(excinfo.value)
    # Post-condition: the in-memory config is untouched.
    assert cfg.db_path == original


def test_apply_config_patch_accepts_whitelisted_key():
    """Happy-path sanity check: a valid whitelisted key updates the
    matching dataclass attribute and the post-patch dict view reflects
    the change.
    """
    cfg = AppConfig()
    assert "capture_fps" in MUTABLE_CONFIG_KEYS
    original = cfg.capture_fps

    result = apply_config_patch(cfg, {"capture_fps": 5})

    assert cfg.capture_fps == 5
    assert cfg.capture_fps != original
    # Returned dict view reflects the update too.
    assert result["capture_fps"] == 5


def test_apply_config_patch_rejects_out_of_range():
    """``capture_fps`` must be ≥ 1 — zero and negatives would stall the
    capture loop, which is why the per-key range validator exists. The
    ValueError message must mention 'outside valid range' so the UI can
    surface it distinctly from the whitelist-reject path.
    """
    cfg = AppConfig()
    original = cfg.capture_fps

    with pytest.raises(ValueError) as excinfo:
        apply_config_patch(cfg, {"capture_fps": 0})

    msg = str(excinfo.value)
    assert "outside valid range" in msg
    assert "capture_fps" in msg
    # Post-condition: the out-of-range value did NOT land on the config.
    assert cfg.capture_fps == original


def test_apply_config_patch_rejects_negative_threshold():
    """Extra range-validator coverage for ``event_delta_threshold_g``:
    the predicate requires > 0, so zero or negatives must raise.
    """
    cfg = AppConfig()
    original = cfg.event_delta_threshold_g

    with pytest.raises(ValueError) as excinfo:
        apply_config_patch(cfg, {"event_delta_threshold_g": -1.0})

    assert "outside valid range" in str(excinfo.value)
    assert cfg.event_delta_threshold_g == original


def test_apply_config_patch_rejects_unknown_key_name():
    """A key that isn't in the whitelist AND isn't a real AppConfig
    attribute must still raise — it's the whitelist check that fires,
    not a dataclass AttributeError.
    """
    cfg = AppConfig()

    with pytest.raises(ValueError) as excinfo:
        apply_config_patch(cfg, {"totally_fake_key": 42})

    assert "totally_fake_key" in str(excinfo.value)


def test_apply_config_patch_multiple_keys_atomic_on_failure():
    """If the patch contains one good key and one bad key, the good key
    may or may not have applied before the error (depends on dict order),
    but the bad one MUST NOT silently apply. Verify the bad key did not
    land on the config.
    """
    cfg = AppConfig()

    with pytest.raises(ValueError):
        apply_config_patch(
            cfg,
            {"capture_fps": 7, "db_path": "/tmp/evil"},
        )

    # db_path is not mutable — the whitelist reject fires before any
    # attempt to set it, so the attribute remains the default.
    assert str(cfg.db_path) != "/tmp/evil"
