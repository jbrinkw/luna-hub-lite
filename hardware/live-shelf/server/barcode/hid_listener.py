"""USB HID barcode listener.

A USB barcode scanner appears to Linux as an HID keyboard. It types the
barcode digits and presses ENTER. We watch /dev/input/eventX, accumulate
keystrokes into a string, and emit it on ENTER.

For test isolation, the keystroke-to-barcode logic is split out into
``accumulate_keys_to_barcode`` (pure function) and the OS-side reader
(``open_device_and_stream_barcodes``) is a thin wrapper over evdev.

Hardening (I-Pi-2)
------------------
The OS-side reader and device discovery raise :class:`ScannerDeviceLost`
on every flavor of "the device went away" — startup ENOENT, mid-loop
``OSError`` from a USB unplug, kernel-permission flap. The outer restart
wrapper in :mod:`server.app` distinguishes that from a generic crash so
device-loss can downgrade to a warn-level retry instead of an error.
"""
from __future__ import annotations
import logging
import os
from typing import Any, Iterable, Iterator, Optional

logger = logging.getLogger(__name__)


class ScannerDeviceLost(Exception):
    """Raised when the evdev device becomes unavailable.

    Fires on USB unplug, permission flap, kernel device-reset, or any
    discovery failure (no matching device, missing criteria). Distinct
    from generic :class:`Exception` so the outer restart wrapper can
    react appropriately — warn-level + retry vs error-level + investigate.
    """


# Map evdev keycode → character.
KEY_MAP: dict[str, str] = {
    f'KEY_{d}': str(d) for d in range(10)
}
KEY_MAP.update({
    f'KEY_{c}': c for c in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
})

ENTER_KEYS = {'KEY_ENTER', 'KEY_KPENTER'}
IGNORED_KEYS = {'KEY_LEFTSHIFT', 'KEY_RIGHTSHIFT',
                'KEY_LEFTCTRL', 'KEY_RIGHTCTRL',
                'KEY_LEFTALT', 'KEY_RIGHTALT',
                'KEY_CAPSLOCK', 'KEY_NUMLOCK'}


def accumulate_keys_to_barcode(keys: Iterable[str]) -> str:
    """Convert a sequence of evdev key names to a barcode string.

    Stops at the first ENTER. Non-digit, non-letter, non-ENTER keys are
    silently ignored. Returns empty string if no ENTER appears.
    """
    out: list[str] = []
    for key in keys:
        if key in ENTER_KEYS:
            return ''.join(out)
        if key in IGNORED_KEYS:
            continue
        char = KEY_MAP.get(key)
        if char:
            out.append(char)
    return ''  # No ENTER seen.


def open_device_and_stream_barcodes(device_path: str) -> Iterator[str]:
    """Open an evdev device and yield barcodes as they are scanned.

    Blocking iterator. Wraps ``evdev`` to stay testable: tests substitute
    a fake by passing a list to ``accumulate_keys_to_barcode`` directly.

    Raises :class:`ScannerDeviceLost` on any USB / permission / kernel
    failure so the outer restart wrapper can warn-and-retry without
    treating the loss as a code-level crash. The wrapper rebuilds the
    iterator each restart so a re-plugged USB scanner picks up cleanly
    on the next iteration.
    """
    try:
        import evdev  # type: ignore[import-untyped]
    except ImportError as exc:
        # No evdev → not a "device lost" condition; this is a config/env
        # bug (someone set BARCODE_SCANNER_ENABLED=true on a host that
        # doesn't have python-evdev). Surface the original ImportError
        # so the operator gets a clean traceback at startup.
        raise ImportError(
            'evdev not installed — install python-evdev or unset '
            'BARCODE_SCANNER_ENABLED'
        ) from exc

    if not os.path.exists(device_path):
        raise ScannerDeviceLost(
            f'evdev device not found: {device_path} (USB unplug? '
            'kernel device-reset? bad BARCODE_SCANNER_DEVICE path?)'
        )
    try:
        device = evdev.InputDevice(device_path)
    except (OSError, PermissionError, IOError) as exc:
        raise ScannerDeviceLost(
            f'failed to open {device_path}: {type(exc).__name__}: {exc}'
        ) from exc
    logger.info('barcode: opened %s (%s)', device_path, device.name)
    buffer: list[str] = []
    try:
        for event in device.read_loop():
            if event.type != evdev.ecodes.EV_KEY:
                continue
            key_event = evdev.categorize(event)
            if key_event.keystate != key_event.key_down:
                continue
            keycode = key_event.keycode
            if isinstance(keycode, list):
                keycode = keycode[0]
            if keycode in ENTER_KEYS:
                barcode = ''.join(buffer)
                buffer = []
                if barcode:
                    yield barcode
            elif keycode in IGNORED_KEYS:
                continue
            else:
                char = KEY_MAP.get(keycode)
                if char:
                    buffer.append(char)
    except (OSError, IOError) as exc:
        # Mid-iteration failures are the dominant case — a USB unplug
        # while we're parked in ``read_loop`` raises OSError.
        raise ScannerDeviceLost(
            f'mid-stream device error on {device_path}: '
            f'{type(exc).__name__}: {exc}'
        ) from exc


def discover_barcode_device(
    vendor_id_hex: Optional[str] = None,
    name_substring: Optional[str] = None,
) -> str:
    """Scan all input devices, return the first /dev/input/eventX path
    that matches.

    Match by either USB vendor:product (preferred — stable across
    firmware updates and across USB-port renumbering after a reboot)
    or by name substring (e.g. ``Datalogic``). Returns the device path.

    Vendor wins if both are set. If neither is set, raises
    :class:`ScannerDeviceLost`.

    Env vars expected by callers:
      ``BARCODE_SCANNER_VENDOR_ID`` (hex, e.g. ``05e0`` for Symbol/Zebra)
      ``BARCODE_SCANNER_NAME_PATTERN`` (case-insensitive substring of dev.name)
    """
    if not vendor_id_hex and not name_substring:
        raise ScannerDeviceLost(
            'no discovery criteria — set BARCODE_SCANNER_VENDOR_ID or '
            'BARCODE_SCANNER_NAME_PATTERN, or hardcode BARCODE_SCANNER_DEVICE.'
        )
    try:
        import evdev  # type: ignore[import-untyped]
    except ImportError as exc:
        raise ImportError(
            'evdev not installed — install python-evdev or unset '
            'BARCODE_SCANNER_ENABLED'
        ) from exc

    target_vendor = vendor_id_hex.lower() if vendor_id_hex else None
    target_name = name_substring.lower() if name_substring else None
    # Two-pass discovery so vendor truly "wins" — any vendor match in
    # the list beats any name match, even when the name match appears
    # on an earlier path. Otherwise an unrelated device with "Datalogic"
    # in the name would shadow the actual scanner picked by vendor.
    candidates: list[tuple[str, Any]] = []
    for path in evdev.list_devices():
        try:
            dev = evdev.InputDevice(path)
        except (OSError, PermissionError):
            # Device disappeared between list_devices() and InputDevice() —
            # skip it and keep scanning. Common when udev is racing.
            continue
        candidates.append((path, dev))

    # Pass 1: vendor match (preferred — stable across firmware updates).
    if target_vendor:
        for path, dev in candidates:
            if f'{dev.info.vendor:04x}' == target_vendor:
                logger.info(
                    'barcode: matched device by vendor %s: %s (%s)',
                    vendor_id_hex, dev.name, path,
                )
                return path
    # Pass 2: name substring fallback.
    if target_name:
        for path, dev in candidates:
            if target_name in dev.name.lower():
                logger.info(
                    'barcode: matched device by name %r: %s (%s)',
                    name_substring, dev.name, path,
                )
                return path
    raise ScannerDeviceLost(
        f'no matching scanner device found '
        f'(vendor={vendor_id_hex}, name={name_substring})'
    )
