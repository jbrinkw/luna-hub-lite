"""Unit tests for ``server.tools.locks``.

Pass-2 audit finding #12: the ``NullLock`` class used to be duplicated
across four modules (``adapters/candidate_source.py``, ``adapters/intake_repo.py``,
``adapters/web_repo.py``, ``intake/cloud_sync.py``). It now lives in
:mod:`server.tools.locks` and every site imports from there. These
tests lock down the public surface + the import-identity contract so
future refactors don't fragment the class again.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def test_null_lock_is_a_context_manager():
    from server.tools.locks import NullLock

    lock = NullLock()
    # __enter__ / __exit__ both defined and return expected shapes.
    with lock as l:
        assert l is lock


def test_null_lock_acquire_release_stubs():
    from server.tools.locks import NullLock

    lock = NullLock()
    # ``acquire`` returns True (threading.Lock-compatible contract) and
    # ``release`` returns None — matches how the web_repo legacy calls
    # used the old local class.
    assert lock.acquire() is True
    assert lock.acquire(blocking=False, timeout=0.5) is True
    assert lock.release() is None


def test_all_four_adapter_modules_share_the_same_class():
    """Finding #12: each of the four old sites must import the SAME
    ``NullLock`` now. If a future refactor re-introduces a local copy
    (intentionally or otherwise) this test fails loudly."""
    from server.adapters.candidate_source import _NullLock as cs_nl
    from server.adapters.intake_repo import _NullLock as ir_nl
    from server.adapters.web_repo import _NullLock as wr_nl
    from server.intake.cloud_sync import _NullLock as cs_intake_nl
    from server.tools.locks import NullLock as canonical

    assert cs_nl is canonical
    assert ir_nl is canonical
    assert wr_nl is canonical
    assert cs_intake_nl is canonical
