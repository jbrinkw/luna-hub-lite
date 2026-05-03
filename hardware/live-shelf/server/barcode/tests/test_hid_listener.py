"""HID listener tests with a fake evdev source."""
from __future__ import annotations

import sys
import types
from unittest.mock import MagicMock, patch

import pytest

from server.barcode.hid_listener import (
    ScannerDeviceLost,
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
    """The dominant case in production: USB cable jiggle while
    ``read_loop`` is parked. We surface as ``ScannerDeviceLost``."""
    fake_device = MagicMock()
    fake_device.name = 'Symbol Scanner'

    def _broken_read_loop():
        # Simulate a USB unplug after we've started iterating.
        raise OSError(19, 'no such device')
        yield  # pragma: no cover - unreachable

    fake_device.read_loop = _broken_read_loop
    fake_evdev = types.ModuleType('evdev')
    fake_evdev.InputDevice = MagicMock(return_value=fake_device)
    fake_evdev.list_devices = MagicMock(return_value=[])
    fake_evdev.ecodes = types.SimpleNamespace(EV_KEY=1)
    fake_evdev.categorize = MagicMock()
    monkeypatch.setitem(sys.modules, 'evdev', fake_evdev)
    monkeypatch.setattr('os.path.exists', lambda _p: True)
    with pytest.raises(ScannerDeviceLost, match='mid-stream device error'):
        list(open_device_and_stream_barcodes('/dev/input/event0'))


def test_ScannerDeviceLost_distinct_from_generic_exception():
    """The whole point of the typed exception is so ``except
    ScannerDeviceLost`` catches device-loss without also catching a
    code crash. Verify the type relationship."""
    assert issubclass(ScannerDeviceLost, Exception)
    # And not a built-in subclass that might accidentally swallow
    # legitimate errors when caught.
    assert not issubclass(ScannerDeviceLost, OSError)
    assert not issubclass(ScannerDeviceLost, RuntimeError)
