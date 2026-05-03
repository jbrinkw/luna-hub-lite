"""USB HID barcode listener.

A USB barcode scanner appears to Linux as an HID keyboard. It types the
barcode digits and presses ENTER. We watch /dev/input/eventX, accumulate
keystrokes into a string, and emit it on ENTER.

For test isolation, the keystroke-to-barcode logic is split out into
``accumulate_keys_to_barcode`` (pure function) and the OS-side reader
(``open_device_and_stream_barcodes``) is a thin wrapper over evdev.
"""
from __future__ import annotations
import logging
import os
from typing import Iterable, Iterator

logger = logging.getLogger(__name__)

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
    """
    import evdev  # type: ignore[import-untyped]
    if not os.path.exists(device_path):
        raise FileNotFoundError(f'evdev device not found: {device_path}')
    device = evdev.InputDevice(device_path)
    logger.info('barcode: opened %s (%s)', device_path, device.name)
    buffer: list[str] = []
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
