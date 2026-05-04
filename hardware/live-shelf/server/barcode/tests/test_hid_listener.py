"""HID listener tests with a fake evdev source."""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from server.barcode.hid_listener import (
    ScannerDeviceLost,
    _check_inode_match,
    accumulate_keys_to_barcode,
    discover_barcode_device,
    open_device_and_stream_barcodes,
)


def test_accumulates_digits_until_enter():
    keys = ['KEY_0', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_4', 'KEY_5',
            'KEY_6', 'KEY_7', 'KEY_8', 'KEY_9', 'KEY_0', 'KEY_1', 'KEY_2',
            'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    assert barcode == '0123456789012'

def test_ignores_non_digit_keys_other_than_enter():
    keys = ['KEY_LEFTSHIFT', 'KEY_1', 'KEY_2', 'KEY_3', 'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    assert barcode == '123'

def test_returns_empty_string_when_no_enter():
    barcode = accumulate_keys_to_barcode(['KEY_1', 'KEY_2', 'KEY_3'])
    assert barcode == ''

def test_handles_caps_and_letter_keys():
    keys = ['KEY_A', 'KEY_B', 'KEY_C', 'KEY_1', 'KEY_2', 'KEY_ENTER']
    barcode = accumulate_keys_to_barcode(keys)
    # Letters preserved (some scanners encode UPC checks as alpha)
    assert barcode == 'ABC12'


# ---------------------------------------------------------------------------
# I-Pi-2 hardening: typed exception + device discovery
# ---------------------------------------------------------------------------


def _install_fake_evdev(monkeypatch, *, devices: list, list_paths: list[str]):
    """Inject a fake ``evdev`` module into ``sys.modules`` so the lazy
    import inside the production code picks it up. Returns the fake
    module object for further configuration in the calling test.
    """
    fake_evdev = types.ModuleType('evdev')
    fake_evdev.list_devices = MagicMock(return_value=list_paths)
    # Map each path to its device.
    by_path = dict(zip(list_paths, devices))

    def _input_device(path):
        if path not in by_path:
            raise OSError(2, f'no such device {path}')
        return by_path[path]

    fake_evdev.InputDevice = MagicMock(side_effect=_input_device)
    # ``evdev.ecodes`` only needed by ``open_device_and_stream_barcodes``;
    # the discovery path never reaches it.
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    return fake_evdev


def _make_fake_device(name: str, vendor: int) -> MagicMock:
    dev = MagicMock()
    dev.name = name
    info = types.SimpleNamespace(vendor=vendor)
    dev.info = info
    return dev


def test_discover_by_vendor_id(monkeypatch):
    """When BARCODE_SCANNER_VENDOR_ID matches a device's ``info.vendor``,
    the matching path is returned. Vendor wins over name for stability
    across firmware updates."""
    logitech = _make_fake_device('Logitech Wireless', 0x046d)
    symbol = _make_fake_device('Symbol Bar Code Scanner', 0x05e0)
    _install_fake_evdev(
        monkeypatch,
        devices=[logitech, symbol],
        list_paths=['/dev/input/event0', '/dev/input/event1'],
    )
    result = discover_barcode_device(
        vendor_id_hex='05e0', name_substring=None,
    )
    assert result == '/dev/input/event1'


def test_discover_by_name_substring(monkeypatch):
    """Falls back to a case-insensitive name match when no vendor is given."""
    keyboard = _make_fake_device('Apple Keyboard', 0x05ac)
    scanner = _make_fake_device('Datalogic QuickScan I QD2400', 0x05f9)
    _install_fake_evdev(
        monkeypatch,
        devices=[keyboard, scanner],
        list_paths=['/dev/input/event0', '/dev/input/event1'],
    )
    result = discover_barcode_device(
        vendor_id_hex=None, name_substring='datalogic',
    )
    assert result == '/dev/input/event1'


def test_discover_vendor_wins_over_name(monkeypatch):
    """When both criteria are set, the vendor match wins — vendor IDs
    are stable across firmware updates whereas dev.name can change."""
    by_vendor = _make_fake_device('Mystery Device', 0x05e0)
    by_name = _make_fake_device('Datalogic QuickScan', 0x1111)
    _install_fake_evdev(
        monkeypatch,
        devices=[by_name, by_vendor],
        list_paths=['/dev/input/event0', '/dev/input/event1'],
    )
    result = discover_barcode_device(
        vendor_id_hex='05e0', name_substring='datalogic',
    )
    # Iteration order matches list_paths; '/event0' is checked first
    # but its vendor (0x1111) doesn't match → continue. '/event1' has
    # the matching vendor → return it. Without vendor-wins logic the
    # first iteration would have early-returned on the name match.
    assert result == '/dev/input/event1'


def test_discover_no_match_raises_ScannerDeviceLost(monkeypatch):
    """No vendor/name match → :class:`ScannerDeviceLost`, not silent."""
    keyboard = _make_fake_device('Apple Keyboard', 0x05ac)
    _install_fake_evdev(
        monkeypatch,
        devices=[keyboard],
        list_paths=['/dev/input/event0'],
    )
    with pytest.raises(ScannerDeviceLost, match='no matching scanner device'):
        discover_barcode_device(vendor_id_hex='ffff', name_substring=None)


def test_discover_with_no_criteria_raises():
    """Caller must pass at least one criterion or set
    ``BARCODE_SCANNER_DEVICE`` directly. We surface that as a
    ``ScannerDeviceLost`` so the outer restart wrapper treats it like
    any other device-loss event."""
    with pytest.raises(ScannerDeviceLost, match='no discovery criteria'):
        discover_barcode_device()


def test_discover_skips_devices_that_fail_to_open(monkeypatch):
    """``InputDevice(path)`` can race a udev hot-unplug between
    ``list_devices`` and ``InputDevice``. We skip the offending path
    and keep scanning rather than aborting the whole discovery."""
    fake_evdev = types.ModuleType('evdev')
    fake_evdev.list_devices = MagicMock(
        return_value=['/dev/input/event0', '/dev/input/event1'],
    )
    scanner = _make_fake_device('Symbol Scanner', 0x05e0)

    def _input_device(path):
        if path == '/dev/input/event0':
            raise PermissionError('permission denied')
        return scanner

    fake_evdev.InputDevice = MagicMock(side_effect=_input_device)
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    result = discover_barcode_device(
        vendor_id_hex='05e0', name_substring=None,
    )
    assert result == '/dev/input/event1'


# ---------------------------------------------------------------------------
# I-Pi-2 hardening: open_device_and_stream_barcodes exception wrapping
# ---------------------------------------------------------------------------


def test_open_raises_ScannerDeviceLost_when_path_missing(monkeypatch):
    """Startup failure: BARCODE_SCANNER_DEVICE points at a path that
    doesn't exist (e.g. /dev/input/event5 after a USB-port renumbering).
    We surface that as ``ScannerDeviceLost`` so the wrapper retries."""
    # Make evdev importable so we get past the first try block.
    _install_fake_evdev(monkeypatch, devices=[], list_paths=[])
    monkeypatch.setattr('os.path.exists', lambda _p: False)
    with pytest.raises(ScannerDeviceLost, match='evdev device not found'):
        # Iterators are lazy → exhaust to trigger the exception path.
        list(open_device_and_stream_barcodes('/dev/input/event99'))


def test_open_raises_ScannerDeviceLost_on_open_failure(monkeypatch):
    """The path exists but evdev.InputDevice(...) raises an OSError
    (e.g. permission denied after udev rules dropped). We catch that
    and re-raise as ``ScannerDeviceLost`` so the wrapper distinguishes
    device-loss from a code crash."""
    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(
        side_effect=PermissionError('permission denied'),
    )
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    monkeypatch.setattr('os.path.exists', lambda _p: True)
    with pytest.raises(ScannerDeviceLost, match='failed to open'):
        list(open_device_and_stream_barcodes('/dev/input/event0'))


def test_open_raises_ScannerDeviceLost_on_mid_stream_oserror(monkeypatch):
    """The dominant case in production: USB cable jiggle while the
    listener is parked. The poll-based loop calls ``device.read()``
    after select indicates POLLIN; we surface a mid-stream OSError as
    ``ScannerDeviceLost``."""
    import os as _os

    # Real pipe fd so select.poll().register() accepts it AND POLLIN
    # reads predictably. We write a byte so poll returns immediately,
    # then OSError is raised when the listener calls device.read().
    r_fd, w_fd = _os.pipe()
    _os.write(w_fd, b'\x00')

    fake_device = MagicMock()
    fake_device.name = 'Symbol Scanner'
    fake_device.fd = r_fd
    fake_device.read = MagicMock(side_effect=OSError(19, 'no such device'))
    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(return_value=fake_device)
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    monkeypatch.setattr('os.path.exists', lambda _p: True)
    try:
        with pytest.raises(ScannerDeviceLost, match='mid-stream device error'):
            list(open_device_and_stream_barcodes('/dev/input/event0'))
    finally:
        _os.close(r_fd)
        try:
            _os.close(w_fd)
        except OSError:
            pass


def test_open_raises_ScannerDeviceLost_on_silent_inode_change(monkeypatch):
    """BT-scanner stale-fd watchdog (2026-05-03 follow-up): when the
    kernel re-binds the same eventN path to a new uhid Sysfs node
    during a BT sleep/wake cycle, the device fd silently goes stale
    while the listener is parked in ``select.poll``. The watchdog
    re-stats the path on every poll-timeout and raises
    :class:`ScannerDeviceLost` when the inode changes — that's the only
    reliable signal short of a udev MONITOR socket. Without it, every
    BT idle-disconnect drops scans on the floor for the duration of the
    backoff window."""
    import os as _os
    from server.barcode import hid_listener as hid

    # Real pipe so poll.register() works, but we never write to it —
    # poll will time out, triggering the inode re-stat path.
    r_fd, w_fd = _os.pipe()

    fake_device = MagicMock()
    fake_device.name = 'ScanAvengerHID'
    fake_device.fd = r_fd

    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(return_value=fake_device)
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)

    # Speed up the test — drop poll timeout to 50ms.
    monkeypatch.setattr(hid, '_POLL_TIMEOUT_MS', 50)
    monkeypatch.setattr('os.path.exists', lambda _p: True)

    # First os.stat call (at open time) returns inode A; later calls
    # (during the poll-timeout watchdog) return inode B — simulating
    # the kernel re-bind that the user just observed live.
    inode_seq = iter([
        types.SimpleNamespace(st_ino=111),  # open-time snapshot
        types.SimpleNamespace(st_ino=222),  # post-rebind
    ])

    def _fake_stat(_path):
        return next(inode_seq)

    monkeypatch.setattr('os.stat', _fake_stat)

    try:
        with pytest.raises(ScannerDeviceLost, match='silent re-bind detected'):
            list(open_device_and_stream_barcodes('/dev/input/event0'))
    finally:
        _os.close(r_fd)
        _os.close(w_fd)


def test_open_raises_ScannerDeviceLost_on_pollhup(monkeypatch):
    """Companion to the inode-change watchdog: when the kernel removes
    the input node entirely (USB unplug, BT layer crash), poll returns
    POLLHUP/POLLERR without a timeout. We surface that as
    :class:`ScannerDeviceLost` so the wrapper rediscovers."""
    import os as _os
    from server.barcode import hid_listener as hid

    # Pipe whose write end is closed before poll runs — POLLIN+POLLHUP
    # fires immediately on Linux.
    r_fd, w_fd = _os.pipe()
    _os.close(w_fd)

    fake_device = MagicMock()
    fake_device.name = 'ScanAvengerHID'
    fake_device.fd = r_fd
    fake_device.read = MagicMock(
        side_effect=AssertionError('device.read should not be called on POLLHUP'),
    )

    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(return_value=fake_device)
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    monkeypatch.setattr(hid, '_POLL_TIMEOUT_MS', 50)
    monkeypatch.setattr('os.path.exists', lambda _p: True)
    monkeypatch.setattr('os.stat', lambda _p: types.SimpleNamespace(st_ino=1))

    try:
        with pytest.raises(ScannerDeviceLost, match='HUP/ERR/NVAL'):
            list(open_device_and_stream_barcodes('/dev/input/event0'))
    finally:
        _os.close(r_fd)


def test_ScannerDeviceLost_distinct_from_generic_exception():
    """The whole point of the typed exception is so ``except
    ScannerDeviceLost`` catches device-loss without also catching a
    code crash. Verify the type relationship."""
    assert issubclass(ScannerDeviceLost, Exception)
    # And not a built-in subclass that might accidentally swallow
    # legitimate errors when caught.
    assert not issubclass(ScannerDeviceLost, OSError)
    assert not issubclass(ScannerDeviceLost, RuntimeError)


# ---------------------------------------------------------------------------
# Audit 1-MED-1 + B-HIGH-5: inode-watchdog helper unit tests.
#
# ``_check_inode_match`` is the pure helper extracted from the listener
# loop so the watchdog logic can be exercised directly. The iterator-
# based tests above cover the integration shape; these cover the corner
# cases that are awkward to hit through the iterator (recovery from
# initial-stat-failure, false-positive on healthy idle).
# ---------------------------------------------------------------------------


def test_check_inode_match_happy_path_returns_baseline_unchanged(monkeypatch):
    """Healthy scanner, idle but same inode → helper returns the same
    baseline and DOES NOT raise.

    Audit B-HIGH-5: the dominant production path is "scanner is healthy,
    nobody is scanning right now, the same inode resolves on every tick".
    A regression that inverts the inode comparison would manifest as
    spurious ``ScannerDeviceLost`` on healthy idle.
    """
    monkeypatch.setattr(
        'os.stat', lambda _p: types.SimpleNamespace(st_ino=42),
    )
    # Multiple ticks all return the same inode → never raises and
    # always returns the original baseline.
    for _ in range(5):
        result = _check_inode_match('/dev/input/event0', 42)
        assert result == 42, (
            "watchdog must not advance the baseline when the inode is "
            "stable — a moving baseline would mask a genuine re-bind"
        )


def test_check_inode_match_raises_on_inode_change(monkeypatch):
    """Audit baseline: helper raises ScannerDeviceLost when the inode
    changes from the original baseline. Mirrors the iterator-based
    test; pinned here so a refactor that drops the helper-level guard
    fails loudly even before the integration test catches it."""
    monkeypatch.setattr(
        'os.stat', lambda _p: types.SimpleNamespace(st_ino=999),
    )
    with pytest.raises(ScannerDeviceLost, match='silent re-bind detected'):
        _check_inode_match('/dev/input/event0', 42)


def test_check_inode_match_raises_on_stat_failure_after_baseline(monkeypatch):
    """When stat raises mid-watchdog (with a baseline already armed),
    surface as ScannerDeviceLost — the device just vanished and the
    iterator loop should rediscover."""
    def _fake_stat(_path):
        raise OSError(2, 'no such file')

    monkeypatch.setattr('os.stat', _fake_stat)
    with pytest.raises(ScannerDeviceLost, match='stat failed during read'):
        _check_inode_match('/dev/input/event0', 42)


def test_check_inode_match_recovers_baseline_on_first_successful_stat(monkeypatch):
    """Audit 1-MED-1: when ``original_inode is None`` (open-time stat
    failed) the helper retries on every call. The first successful
    stat establishes the baseline and returns it; subsequent matching
    stats don't raise; an inode change AFTER recovery DOES raise.

    Pre-fix: ``original_inode = None`` was set once at open and never
    revisited, so a transient open-time stat failure silently disabled
    the watchdog forever.
    """
    # Stat raises on the first call; returns inode 42 on the second
    # and beyond. Mirrors the "kernel-permission flap" race during
    # device enumeration.
    call_count = {'n': 0}

    def _fake_stat(_path):
        call_count['n'] += 1
        if call_count['n'] == 1:
            raise OSError(13, 'permission denied')
        return types.SimpleNamespace(st_ino=42)

    monkeypatch.setattr('os.stat', _fake_stat)

    # First call: stat raises → helper returns None (still disarmed).
    result1 = _check_inode_match('/dev/input/event0', None)
    assert result1 is None, (
        "stat-fail recovery: helper must return None when stat is "
        "still failing so the caller knows the watchdog is not yet "
        "armed"
    )
    # Second call: stat succeeds → helper returns the new baseline.
    result2 = _check_inode_match('/dev/input/event0', None)
    assert result2 == 42, (
        "stat-fail recovery: a successful retry must establish the "
        "baseline so subsequent comparisons can detect re-binds"
    )
    # Third call: stat returns the same inode → no raise.
    result3 = _check_inode_match('/dev/input/event0', 42)
    assert result3 == 42

    # Fourth call: stat returns a DIFFERENT inode → raise.
    # Replace the stat patch to simulate a kernel re-bind AFTER the
    # watchdog recovered.
    monkeypatch.setattr(
        'os.stat', lambda _p: types.SimpleNamespace(st_ino=99),
    )
    with pytest.raises(ScannerDeviceLost, match='42 -> 99'):
        _check_inode_match('/dev/input/event0', 42)


def test_open_recovers_when_initial_stat_fails(monkeypatch):
    """Audit 1-MED-1 integration: the listener's open-time stat fails
    once → ``original_inode = None`` initially. After ONE poll-timeout
    iteration, the helper retries the stat and recovers the baseline.
    Subsequent matching stats don't raise; an inode change after
    recovery DOES raise (proves the watchdog is now armed).

    Pre-fix shape: a transient stat failure at open silently disabled
    the inode-mismatch check forever. Today's code retries on every
    poll-timeout until stat succeeds.
    """
    import os as _os
    from server.barcode import hid_listener as hid

    r_fd, w_fd = _os.pipe()
    fake_device = MagicMock()
    fake_device.name = 'ScanAvengerHID'
    fake_device.fd = r_fd
    fake_device.read = MagicMock(
        side_effect=AssertionError(
            'device.read should not be called on poll-timeout path'
        ),
    )

    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(return_value=fake_device)
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    monkeypatch.setattr(hid, '_POLL_TIMEOUT_MS', 50)
    monkeypatch.setattr('os.path.exists', lambda _p: True)

    # Stat schedule:
    #   call 1 (open-time): raise OSError → original_inode stays None
    #   call 2 (first poll-timeout): return inode 42 → helper recovers
    #   call 3 (second poll-timeout): return inode 99 → MUST raise
    stat_calls = {'n': 0}

    def _fake_stat(_path):
        stat_calls['n'] += 1
        n = stat_calls['n']
        if n == 1:
            raise OSError(13, 'permission denied (transient)')
        if n == 2:
            return types.SimpleNamespace(st_ino=42)
        return types.SimpleNamespace(st_ino=99)

    monkeypatch.setattr('os.stat', _fake_stat)

    try:
        with pytest.raises(ScannerDeviceLost, match='42 -> 99'):
            list(open_device_and_stream_barcodes('/dev/input/event0'))
        # Sanity: the watchdog actually traversed the recovery path —
        # we expect at least 3 stat calls (open-time fail + recovery +
        # re-bind detection).
        assert stat_calls['n'] >= 3, (
            "expected open-time stat + recovery + re-bind detection "
            f"(got {stat_calls['n']} stat calls)"
        )
    finally:
        _os.close(r_fd)
        try:
            _os.close(w_fd)
        except OSError:
            pass
