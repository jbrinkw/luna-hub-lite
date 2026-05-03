"""HID listener tests with a fake evdev source."""
from __future__ import annotations
from server.barcode.hid_listener import accumulate_keys_to_barcode

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
