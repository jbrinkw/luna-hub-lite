"""Rigorous boundary-exercising tests for fixtures/python/good_contract.

A proper unit test kills mutmut mutations by asserting at every branch
boundary. Expect mutmut score > 80% here.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fixture_src.bucket import bucket, clamp_tagged  # noqa: E402


# ---------------------------------------------------------------------------
# bucket
# ---------------------------------------------------------------------------


def test_bucket_zero_boundary() -> None:
    assert bucket(0, 10) == "zero"
    assert bucket(0, 1) == "zero"
    # `score == 0` mutated to `score != 0` would return "low".
    assert bucket(0, 5) != "low"
    assert bucket(0, 5) != "high"


def test_bucket_low_interior() -> None:
    assert bucket(1, 10) == "low"
    assert bucket(5, 10) == "low"
    assert bucket(9, 10) == "low"


def test_bucket_high_at_and_above_limit() -> None:
    # `score < limit` -> `score <= limit` mutation would return "low" at
    # score == limit. We assert "high" to kill it.
    assert bucket(10, 10) == "high"
    assert bucket(11, 10) == "high"
    assert bucket(1_000, 10) == "high"


# ---------------------------------------------------------------------------
# clamp_tagged
# ---------------------------------------------------------------------------


def test_clamp_tagged_neg_max_only_when_max_lt_zero() -> None:
    assert clamp_tagged(5, -1) == (0, "neg-max")
    assert clamp_tagged(-5, -1) == (0, "neg-max")
    # `max < 0` -> `max <= 0` mutation would tag max=0 as neg-max.
    assert clamp_tagged(0, 0) == (0, "ok")


def test_clamp_tagged_neg_n_only_when_n_lt_zero_and_max_ge_zero() -> None:
    assert clamp_tagged(-1, 10) == (0, "neg-n")
    assert clamp_tagged(-100, 10) == (0, "neg-n")
    # `n < 0` -> `n <= 0` mutation would tag n=0 as neg-n.
    assert clamp_tagged(0, 10) == (0, "ok")


def test_clamp_tagged_over_only_when_n_gt_max() -> None:
    assert clamp_tagged(11, 10) == (10, "over")
    assert clamp_tagged(9_999, 10) == (10, "over")
    # `n > max` -> `n >= max` mutation would tag n=max as over.
    assert clamp_tagged(10, 10) == (10, "ok")
    assert clamp_tagged(7, 7) == (7, "ok")


def test_clamp_tagged_ok_mid_range() -> None:
    assert clamp_tagged(5, 10) == (5, "ok")
