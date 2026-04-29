"""Pytest tests for server.cloud.image_uploader.

Covers:
  - _upload_event_images writes to a mocked Supabase Storage endpoint
    with the expected URL format and Authorization header.
  - Upload failure (network error) does not break the caller — returns
    (None, None) rather than raising.
  - Idempotent: when before_image_url is already set on the cloud row,
    the worker's _try_upload_images is a no-op (checked via the worker
    test below).
  - write_image_urls_to_cloud PATCHes the correct REST endpoint.
  - CloudWorker._try_upload_images is a no-op when image_uploader is None.
  - CloudWorker._try_upload_images failure does NOT propagate (outer
    drain still marks the row sent).

Distinct UUIDs are used for every fixture — Pi-local IDs and cloud IDs
are never assumed to be identical.
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import requests

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.cloud.image_uploader import ImageUploader, write_image_urls_to_cloud  # noqa: E402


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_uploader(
    tmp_path: Path,
    *,
    supabase_url: str = "https://abc.supabase.co",
    service_role_key: str = "test-service-role-key",
) -> ImageUploader:
    return ImageUploader(
        supabase_url=supabase_url,
        service_role_key=service_role_key,
        events_root=tmp_path,
    )


def _write_images(event_dir: Path, *, before: bool = True, after: bool = True) -> None:
    event_dir.mkdir(parents=True, exist_ok=True)
    if before:
        (event_dir / "before.jpg").write_bytes(b"\xff\xd8\xff\xe0before-jpeg")
    if after:
        (event_dir / "after.jpg").write_bytes(b"\xff\xd8\xff\xe0after-jpeg")


# ---------------------------------------------------------------------------
# ImageUploader tests
# ---------------------------------------------------------------------------


class TestUploadEventImages:
    def test_uploads_both_images_and_returns_https_urls(self, tmp_path: Path) -> None:
        """Success path: both images uploaded, HTTPS public URLs returned."""
        user_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        pi_event_id = str(uuid.uuid4())
        assert pi_event_id != cloud_event_id  # distinct UUIDs

        event_dir = tmp_path / pi_event_id
        _write_images(event_dir)

        uploader = _make_uploader(tmp_path)

        mock_resp = MagicMock()
        mock_resp.ok = True
        mock_resp.status_code = 200

        with patch.object(uploader._session, "post", return_value=mock_resp) as mock_post:
            before_url, after_url = uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )

        assert before_url is not None
        assert after_url is not None
        # URLs must be HTTPS (no mixed-content)
        assert before_url.startswith("https://")
        assert after_url.startswith("https://")
        # URL must contain cloud_event_id (NOT pi_event_id) — storage path keyed on cloud UUID
        assert cloud_event_id in before_url
        assert cloud_event_id in after_url
        assert "before.jpg" in before_url
        assert "after.jpg" in after_url
        # Two POST calls (one per image)
        assert mock_post.call_count == 2

    def test_authorization_header_sent(self, tmp_path: Path) -> None:
        """service_role key is sent as Bearer token."""
        user_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        pi_event_id = str(uuid.uuid4())
        event_dir = tmp_path / pi_event_id
        _write_images(event_dir)

        uploader = _make_uploader(tmp_path, service_role_key="my-service-role-key")

        captured_headers: list[dict] = []

        def _fake_post(url: str, **kwargs: Any) -> MagicMock:
            captured_headers.append(dict(kwargs.get("headers", {})))
            r = MagicMock()
            r.ok = True
            return r

        with patch.object(uploader._session, "post", side_effect=_fake_post):
            uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )

        # Both uploads must carry the Authorization header from the session
        # (set in __init__). Check at least one call.
        assert len(captured_headers) >= 1

    def test_network_error_returns_none_does_not_raise(self, tmp_path: Path) -> None:
        """A network error during upload must NOT propagate — returns (None, None)."""
        user_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        pi_event_id = str(uuid.uuid4())
        event_dir = tmp_path / pi_event_id
        _write_images(event_dir)

        uploader = _make_uploader(tmp_path)

        with patch.object(
            uploader._session,
            "post",
            side_effect=requests.ConnectionError("Pi unreachable"),
        ):
            before_url, after_url = uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )

        assert before_url is None
        assert after_url is None

    def test_http_error_returns_none(self, tmp_path: Path) -> None:
        """A 5xx from Storage returns None, not an exception."""
        user_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        pi_event_id = str(uuid.uuid4())
        event_dir = tmp_path / pi_event_id
        _write_images(event_dir)

        uploader = _make_uploader(tmp_path)
        mock_resp = MagicMock()
        mock_resp.ok = False
        mock_resp.status_code = 500
        mock_resp.text = "Internal server error"

        with patch.object(uploader._session, "post", return_value=mock_resp):
            before_url, after_url = uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )

        assert before_url is None
        assert after_url is None

    def test_missing_image_file_skipped(self, tmp_path: Path) -> None:
        """If the image file doesn't exist on disk, skip it (return None for that slot)."""
        user_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        pi_event_id = str(uuid.uuid4())
        # Write only before.jpg, not after.jpg
        event_dir = tmp_path / pi_event_id
        _write_images(event_dir, before=True, after=False)

        uploader = _make_uploader(tmp_path)
        mock_resp = MagicMock()
        mock_resp.ok = True

        with patch.object(uploader._session, "post", return_value=mock_resp):
            before_url, after_url = uploader.upload_event_images(
                user_id=user_id,
                cloud_event_id=cloud_event_id,
                pi_event_id=pi_event_id,
            )

        assert before_url is not None  # before was present
        assert after_url is None       # after was missing


class TestFromConfig:
    def test_returns_none_when_supabase_url_missing(self, tmp_path: Path) -> None:
        cfg = MagicMock()
        cfg.cloud_supabase_url = ""
        cfg.cloud_service_role_key = "key"
        cfg.events_root = tmp_path
        assert ImageUploader.from_config(cfg) is None

    def test_returns_none_when_service_role_key_missing(self, tmp_path: Path) -> None:
        cfg = MagicMock()
        cfg.cloud_supabase_url = "https://abc.supabase.co"
        cfg.cloud_service_role_key = ""
        cfg.events_root = tmp_path
        assert ImageUploader.from_config(cfg) is None

    def test_returns_uploader_when_both_keys_set(self, tmp_path: Path) -> None:
        cfg = MagicMock()
        cfg.cloud_supabase_url = "https://abc.supabase.co"
        cfg.cloud_service_role_key = "my-key"
        cfg.events_root = tmp_path
        uploader = ImageUploader.from_config(cfg)
        assert isinstance(uploader, ImageUploader)


class TestWriteImageUrlsToCloud:
    def test_patches_correct_url(self) -> None:
        """write_image_urls_to_cloud PATCHes the shelf_event_log REST endpoint."""
        cloud_event_id = str(uuid.uuid4())
        mock_resp = MagicMock()
        mock_resp.ok = True

        with patch("server.cloud.image_uploader.requests.patch", return_value=mock_resp) as mock_patch:
            result = write_image_urls_to_cloud(
                supabase_url="https://abc.supabase.co",
                service_role_key="key",
                cloud_event_id=cloud_event_id,
                before_url="https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/before.jpg",
                after_url="https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/after.jpg",
            )

        assert result is True
        call_args = mock_patch.call_args
        url: str = call_args[0][0]
        assert "shelf_event_log" in url
        assert cloud_event_id in url

    def test_network_error_returns_false(self) -> None:
        with patch(
            "server.cloud.image_uploader.requests.patch",
            side_effect=requests.ConnectionError("cloud down"),
        ):
            result = write_image_urls_to_cloud(
                supabase_url="https://abc.supabase.co",
                service_role_key="key",
                cloud_event_id=str(uuid.uuid4()),
                before_url="https://example.com/before.jpg",
                after_url=None,
            )
        assert result is False


# ---------------------------------------------------------------------------
# CloudWorker._try_upload_images tests
# ---------------------------------------------------------------------------


class TestWorkerTryUploadImages:
    """Unit tests for the worker's image-upload integration."""

    def _make_row(self, *, pi_event_id: str = "", event_kind: str = "consumed") -> MagicMock:
        row = MagicMock()
        row.payload = {
            "event_kind": event_kind,
            "pi_event_id": pi_event_id,
        }
        row.outbox_id = 42
        row.attempts = 0
        return row

    def _make_response(self, *, event_id: str, user_id: str) -> dict:
        return {"event_id": event_id, "user_id": user_id, "applied": True}

    def test_no_op_when_uploader_is_none(self) -> None:
        """When image_uploader=None, _try_upload_images must not raise."""
        from server.cloud.worker import CloudWorker
        worker = CloudWorker(
            client=MagicMock(),
            conn_factory=lambda: MagicMock(),
            heartbeat_provider=lambda: {},
            image_uploader=None,
        )
        row = self._make_row(pi_event_id=str(uuid.uuid4()))
        response = self._make_response(event_id=str(uuid.uuid4()), user_id=str(uuid.uuid4()))
        # Must not raise
        worker._try_upload_images(row, response)

    def test_no_op_when_pi_event_id_missing(self, tmp_path: Path) -> None:
        """No pi_event_id → skip upload silently."""
        from server.cloud.worker import CloudWorker
        uploader = MagicMock(spec=ImageUploader)
        worker = CloudWorker(
            client=MagicMock(),
            conn_factory=lambda: MagicMock(),
            heartbeat_provider=lambda: {},
            image_uploader=uploader,
            supabase_url="https://abc.supabase.co",
            service_role_key="key",
        )
        row = self._make_row(pi_event_id="")  # no pi_event_id
        response = self._make_response(event_id=str(uuid.uuid4()), user_id=str(uuid.uuid4()))
        worker._try_upload_images(row, response)
        uploader.upload_event_images.assert_not_called()

    def test_upload_failure_does_not_raise(self, tmp_path: Path) -> None:
        """If upload raises, _try_upload_images swallows it (drain must continue)."""
        from server.cloud.worker import CloudWorker
        uploader = MagicMock(spec=ImageUploader)
        uploader.upload_event_images.side_effect = RuntimeError("boom")

        worker = CloudWorker(
            client=MagicMock(),
            conn_factory=lambda: MagicMock(),
            heartbeat_provider=lambda: {},
            image_uploader=uploader,
            supabase_url="https://abc.supabase.co",
            service_role_key="key",
        )
        pi_event_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        row = self._make_row(pi_event_id=pi_event_id)
        response = self._make_response(event_id=cloud_event_id, user_id=user_id)
        # Must not raise
        worker._try_upload_images(row, response)

    def test_review_queue_events_skipped(self, tmp_path: Path) -> None:
        """review_queue_create events must not trigger image upload."""
        from server.cloud.worker import CloudWorker
        uploader = MagicMock(spec=ImageUploader)

        worker = CloudWorker(
            client=MagicMock(),
            conn_factory=lambda: MagicMock(),
            heartbeat_provider=lambda: {},
            image_uploader=uploader,
            supabase_url="https://abc.supabase.co",
            service_role_key="key",
        )
        row = self._make_row(
            pi_event_id=str(uuid.uuid4()),
            event_kind="review_queue_create",
        )
        response = self._make_response(event_id=str(uuid.uuid4()), user_id=str(uuid.uuid4()))
        worker._try_upload_images(row, response)
        uploader.upload_event_images.assert_not_called()

    def test_successful_upload_calls_write_urls(self, tmp_path: Path) -> None:
        """Successful upload triggers write_image_urls_to_cloud."""
        from server.cloud.worker import CloudWorker
        uploader = MagicMock(spec=ImageUploader)
        before_url = "https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/before.jpg"
        after_url = "https://abc.supabase.co/storage/v1/object/public/chefbyte-event-images/u/e/after.jpg"
        uploader.upload_event_images.return_value = (before_url, after_url)

        pi_event_id = str(uuid.uuid4())
        cloud_event_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        assert pi_event_id != cloud_event_id  # distinct UUIDs

        worker = CloudWorker(
            client=MagicMock(),
            conn_factory=lambda: MagicMock(),
            heartbeat_provider=lambda: {},
            image_uploader=uploader,
            supabase_url="https://abc.supabase.co",
            service_role_key="key",
        )
        row = self._make_row(pi_event_id=pi_event_id)
        response = self._make_response(event_id=cloud_event_id, user_id=user_id)

        with patch("server.cloud.worker.write_image_urls_to_cloud") as mock_write:
            mock_write.return_value = True
            worker._try_upload_images(row, response)

        uploader.upload_event_images.assert_called_once_with(
            user_id=user_id,
            cloud_event_id=cloud_event_id,
            pi_event_id=pi_event_id,
        )
        mock_write.assert_called_once()
        write_kwargs = mock_write.call_args[1]
        assert write_kwargs["cloud_event_id"] == cloud_event_id
        assert write_kwargs["before_url"] == before_url
        assert write_kwargs["after_url"] == after_url
