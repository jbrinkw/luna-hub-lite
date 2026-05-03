"""Smoke-test that the wire-up doesn't crash.

Verifies ``_start_barcode_scanner_thread`` (Task 10) honors the
``BARCODE_SCANNER_ENABLED`` env-var gate and starts a daemon thread
named ``barcode-scanner`` when enabled. Stronger end-to-end behavior
(post → cloud) is covered by ``test_scanner_loop.py`` +
``test_cloud_post.py`` — this file only verifies the entrypoint
wiring boundary.
"""
from unittest.mock import MagicMock, patch


def test_start_barcode_scanner_thread_off_by_default(monkeypatch):
    """Without ``BARCODE_SCANNER_ENABLED`` set, no thread starts."""
    monkeypatch.delenv('BARCODE_SCANNER_ENABLED', raising=False)
    from server.app import _start_barcode_scanner_thread

    fake_client = MagicMock()
    with patch('server.app.threading.Thread') as mock_thread:
        result = _start_barcode_scanner_thread(fake_client)
        assert result is None
        mock_thread.assert_not_called()


def test_start_barcode_scanner_thread_off_when_value_falsy(monkeypatch):
    """Falsy values for the env var (e.g. ``false``, ``0``) keep it off."""
    monkeypatch.setenv('BARCODE_SCANNER_ENABLED', 'false')
    from server.app import _start_barcode_scanner_thread

    fake_client = MagicMock()
    with patch('server.app.threading.Thread') as mock_thread:
        result = _start_barcode_scanner_thread(fake_client)
        assert result is None
        mock_thread.assert_not_called()


def test_start_barcode_scanner_thread_no_op_when_cloud_client_none(monkeypatch):
    """Even with the env var on, ``cloud_client=None`` skips the thread."""
    monkeypatch.setenv('BARCODE_SCANNER_ENABLED', 'true')
    from server.app import _start_barcode_scanner_thread

    with patch('server.app.threading.Thread') as mock_thread:
        result = _start_barcode_scanner_thread(None)
        assert result is None
        mock_thread.assert_not_called()


def test_start_barcode_scanner_thread_on_when_env_set(monkeypatch):
    """With ``BARCODE_SCANNER_ENABLED=true``, a daemon thread starts."""
    monkeypatch.setenv('BARCODE_SCANNER_ENABLED', 'true')
    monkeypatch.setenv('BARCODE_SCANNER_DEVICE', '/dev/null')

    from server.app import _start_barcode_scanner_thread

    fake_client = MagicMock()
    with patch('server.app.threading.Thread') as mock_thread:
        mock_thread_instance = MagicMock()
        mock_thread.return_value = mock_thread_instance
        result = _start_barcode_scanner_thread(fake_client)
        mock_thread.assert_called_once()
        assert mock_thread.call_args.kwargs.get('name') == 'barcode-scanner'
        assert mock_thread.call_args.kwargs.get('daemon') is True
        mock_thread_instance.start.assert_called_once()
        assert result is mock_thread_instance
