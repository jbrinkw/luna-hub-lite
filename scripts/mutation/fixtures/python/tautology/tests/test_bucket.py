"""DELIBERATELY WEAK tests — the negative fixture for the mutation gate.

These assertions check only defined-ness and rough type shape. A
rigorous mutmut run should report a LOW score (< 30%): any
boundary-flipping mutation passes these tests unchanged, so survivors
dominate.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from fixture_src.bucket import bucket, clamp_tagged  # noqa: E402


def test_bucket_is_defined() -> None:
    assert bucket is not None
    assert callable(bucket)


def test_bucket_returns_string() -> None:
    assert isinstance(bucket(0, 0), str)
    assert isinstance(bucket(5, 10), str)


def test_clamp_tagged_is_defined() -> None:
    assert clamp_tagged is not None
    assert callable(clamp_tagged)


def test_clamp_tagged_returns_tuple_with_two_items() -> None:
    r = clamp_tagged(5, 10)
    assert isinstance(r, tuple)
    assert len(r) == 2
