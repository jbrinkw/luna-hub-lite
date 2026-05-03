"""Scanner loop orchestrator tests."""
from unittest.mock import MagicMock
from server.barcode.scanner_loop import ScannerLoop


def test_scanner_loop_dispatches_each_barcode():
    cloud = MagicMock()
    cloud.post_barcode_scan.return_value = {'transaction_id': 't', 'status': 'applied'}

    def fake_source():
        yield '0123456789012'
        yield '0123456789013'

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    loop.run_once()
    loop.run_once()
    assert cloud.post_barcode_scan.call_count == 2


def test_scanner_loop_swallows_cloud_errors():
    cloud = MagicMock()
    cloud.post_barcode_scan.side_effect = RuntimeError('cloud down')

    def fake_source():
        yield '0123456789012'

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    # Must not raise: errors should be logged + swallowed.
    loop.run_once()
    assert cloud.post_barcode_scan.call_count == 1


def test_scanner_loop_generates_unique_pi_event_id_per_scan():
    cloud = MagicMock()
    cloud.post_barcode_scan.return_value = {'transaction_id': 't'}

    def fake_source():
        yield '0123456789012'
        yield '0123456789012'  # same barcode, different pi_event_id

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    loop.run_once()
    loop.run_once()
    eid1 = cloud.post_barcode_scan.call_args_list[0].kwargs['pi_event_id']
    eid2 = cloud.post_barcode_scan.call_args_list[1].kwargs['pi_event_id']
    assert eid1 != eid2


def test_scanner_loop_stops_cleanly_on_exhausted_source():
    cloud = MagicMock()
    cloud.post_barcode_scan.return_value = {'transaction_id': 't'}

    def fake_source():
        return iter([])

    loop = ScannerLoop(cloud_client=cloud, barcode_source=fake_source)
    # No exception when source is empty.
    loop.run_once()
    assert cloud.post_barcode_scan.call_count == 0
