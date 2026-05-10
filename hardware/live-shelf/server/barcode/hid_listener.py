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

BT-scanner stale-fd watchdog (2026-05-03 follow-up)
---------------------------------------------------
Bluetooth HID scanners commonly idle-disconnect after ~30-60s. When the
scanner reconnects the kernel re-binds the uhid device, often reusing
the same /dev/input/eventN path but pointing it at a NEW Sysfs node.
``device.read_loop()`` parked on the old fd does NOT raise — the fd
silently goes stale and every keystroke from the new binding is lost
until something else triggers a restart. The user observed this live:
listener "running" for 8 hours, last_scan_age_s=29939, four kernel
re-binds in between, every scan dropped.

The fix uses ``select.poll()`` with a short timeout so we (a) detect
``POLLHUP`` / ``POLLERR`` immediately when the kernel removes the fd
and (b) re-stat the eventN path on every poll-timeout to catch the
silent re-bind case where the old fd still seems healthy but the path
now resolves to a different inode/sysfs entry. Either signal raises
:class:`ScannerDeviceLost` so the outer restart wrapper rediscovers.
"""
from __future__ import annotations
import logging
import os
import select
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

# poll timeout in ms — short enough that a silent BT re-bind is detected
# within ~2s (the user feels at most one or two missed scans before the
# wrapper restarts), long enough that healthy idle scanners don't burn
# CPU in tight loops. Kept as a module-level constant so tests can
# monkeypatch it down to ~50ms for fast feedback.
_POLL_TIMEOUT_MS = 2000


def _check_poll_flags(
    device_path: str,
    flags: int,
) -> Optional[ScannerDeviceLost]:
    """Pure helper for the poll-flags fault-detection branch.

    Returns a constructed (but un-raised) :class:`ScannerDeviceLost`
    instance when ``flags`` includes any of POLLHUP / POLLERR /
    POLLNVAL — the three "the kernel just removed the fd" signals. The
    caller raises it. Returns ``None`` for healthy flag sets so the loop
    keeps reading.

    Audit B-HIGH-6 (2026-05-04): pulled out of the listener loop so all
    three failure flags can be exercised in a unit test without driving
    the full evdev iterator. POLLHUP is reproducible via a closed-write-end
    pipe; POLLERR / POLLNVAL are reachable via specific kernel races but
    NOT plausibly fakeable on a real fd from userspace, so the
    integration test can only realistically cover POLLHUP. Testing the
    helper directly closes the gap.

    The flag set is intentionally narrow: POLLIN means "data is available
    to read" — that's the happy path, not a failure — and is filtered
    out by the bitmask. POLLPRI / POLLRDHUP aren't checked because the
    listener doesn't ask for them in ``poller.register``.
    """
    bad = select.POLLHUP | select.POLLERR | select.POLLNVAL
    if flags & bad:
        return ScannerDeviceLost(
            f'poll detected HUP/ERR/NVAL on {device_path} '
            f'(flags={flags})'
        )
    return None


def _check_inode_match(
    device_path: str,
    original_inode: Optional[int],
) -> Optional[int]:
    """Pure helper for the BT-rebind watchdog.

    Returns the (possibly newly-recovered) baseline inode that the
    caller should track going forward, or raises
    :class:`ScannerDeviceLost` if a silent re-bind was detected or the
    path vanished.

    Three cases:

      1. ``original_inode is None``: the open-time stat raised; we try
         to establish a fresh baseline. On success we return the new
         inode — the watchdog is now armed. On stat failure we return
         ``None`` so the caller can retry on the next timeout.
      2. ``original_inode`` is set, current stat matches: return
         ``original_inode`` unchanged — happy path, no re-bind.
      3. ``original_inode`` is set, stat fails or returns a different
         inode: raise :class:`ScannerDeviceLost`.

    The path-existence check is intentionally OUTSIDE this helper so
    the listener can raise its own descriptive error without ambiguity.

    Audit B-HIGH-5 (2026-05-04): the iterator-based test for the
    happy-path (idle scanner, same inode, no false-positive raise) is
    fiddly to write end-to-end because the listener blocks in
    ``select.poll``. Pulling the inode logic out into a pure helper
    lets the watchdog be tested directly without driving the whole
    listener loop.
    """
    if original_inode is None:
        # Recovery path: open-time stat raised; try again. On success
        # the caller arms the watchdog with this baseline; on failure
        # we return None to signal "retry next timeout".
        try:
            return os.stat(device_path).st_ino
        except OSError:
            return None
    try:
        current_inode = os.stat(device_path).st_ino
    except OSError as exc:
        raise ScannerDeviceLost(
            f'stat failed during read on {device_path}: '
            f'{type(exc).__name__}: {exc}'
        ) from exc
    if current_inode != original_inode:
        raise ScannerDeviceLost(
            f'silent re-bind detected on {device_path}: '
            f'inode {original_inode} -> {current_inode} '
            '(BT scanner sleep/wake or USB hot-plug)'
        )
    return original_inode


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

    # Snapshot the device path's inode at open time. When the BT scanner
    # idle-disconnects and reconnects, the kernel typically re-binds the
    # same eventN path to a new uhid Sysfs node. devtmpfs regenerates the
    # device file with a new inode in the process, so an inode mismatch
    # against the still-valid fd is the most reliable "this fd is stale"
    # signal short of a udev MONITOR socket. The check fires only on
    # poll-timeout (no events for ``_POLL_TIMEOUT_MS``), so it's a no-op
    # in the common case where the scanner is actively typing.
    #
    # Audit 1-MED-1 (2026-05-04): when the open-time stat fails (rare —
    # device race during enumeration, kernel-permission flap), we leave
    # ``original_inode`` as None and the poll-timeout loop below retries
    # the stat on every tick. Without this retry, a transient stat
    # failure at startup would silently disable the watchdog forever —
    # exactly the BT-rebind case the watchdog was built to catch.
    try:
        original_inode = os.stat(device_path).st_ino
    except OSError:
        original_inode = None

    poller = select.poll()
    poller.register(device.fd, select.POLLIN | select.POLLHUP | select.POLLERR)

    buffer: list[str] = []
    try:
        while True:
            ready = poller.poll(_POLL_TIMEOUT_MS)
            if not ready:
                # No keystrokes for the timeout window — verify the device
                # path still resolves to the same inode. A silent kernel
                # re-bind during a BT sleep/wake cycle gets caught here.
                if not os.path.exists(device_path):
                    raise ScannerDeviceLost(
                        f'device path vanished during read: {device_path}'
                    )
                # Audit 1-MED-1 + B-HIGH-5: helper handles both the
                # recovery case (open-time stat failed; try again now
                # that the kernel has settled) and the normal compare.
                # On a recovery iteration we just establish the new
                # baseline and skip comparison this tick (there's
                # nothing to compare against). On the normal path the
                # helper returns the same baseline or raises on a
                # re-bind / vanished path.
                original_inode = _check_inode_match(
                    device_path, original_inode,
                )
                continue
            for fd, flags in ready:
                # Audit B-HIGH-6: pure helper handles the POLLHUP /
                # POLLERR / POLLNVAL bitmask check so all three flags
                # can be unit-tested directly (POLLERR + POLLNVAL are
                # not plausibly fakeable on a real fd from userspace).
                fault = _check_poll_flags(device_path, flags)
                if fault is not None:
                    raise fault
            for event in device.read():
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
        # while we're parked in ``poll`` raises OSError.
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
