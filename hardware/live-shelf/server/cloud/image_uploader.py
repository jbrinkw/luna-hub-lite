"""Upload Pi event images to Supabase Storage (mixed-content fix).

Chrome blocks HTTP image fetches from an HTTPS page (mixed-content).  The
web app at https://lunahub.dev was rendering ``http://<pi-ip>:8000/...``
URLs that always fail in production.  This module fixes the root cause: after
each outbox event drains successfully the worker calls
:func:`upload_event_images`, which PUTs ``before.jpg`` + ``after.jpg`` to
the ``chefbyte-event-images`` Supabase Storage bucket and returns public
HTTPS URLs.  The worker then writes those URLs back to
``chefbyte.shelf_event_log`` via the shelf-ingest edge function's
``/update-image-urls`` endpoint (or via a direct service_role Supabase
REST call — see :func:`write_image_urls_to_cloud`).

Design choices
--------------
* Failure is **non-fatal**.  A network blip during upload must not fail the
  event drain.  The LAN URL fallback in the web app remains usable for
  events whose images haven't been uploaded yet.
* **Idempotent**.  The ``before_image_url`` column is checked before
  uploading.  If it's already set (Pi rebooted mid-run, outbox retry), the
  upload is skipped.  Supabase Storage PUT with ``upsert=true`` header also
  makes the byte-level write idempotent.
* **Distinct UUIDs**.  The shelf_event_log ``event_id`` is the cloud UUID;
  the ``pi_event_id`` is the Pi-local scale_events.event_id used to locate
  the image files on disk.  These are never the same value.
* **No blocking the outbox**.  Image upload is best-effort; exceptions are
  caught and logged, not re-raised.

Object path convention
----------------------
``chefbyte-event-images/<user_id>/<cloud_event_id>/before.jpg``
``chefbyte-event-images/<user_id>/<cloud_event_id>/after.jpg``

Where ``cloud_event_id`` is the ``shelf_event_log.event_id`` UUID (from the
cloud's ``/event`` response).  This keeps the path guess-resistant (UUID in
the path) and scoped per-user.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional, Tuple

import requests

log = logging.getLogger(__name__)

# Supabase Storage REST path template.
# POST to this URL with the service_role Bearer token to upsert an object.
_STORAGE_UPLOAD_PATH = "/storage/v1/object/{bucket}/{object_path}"

# Public CDN URL template — returned after a successful upload.
_STORAGE_PUBLIC_URL = "/storage/v1/object/public/{bucket}/{object_path}"

BUCKET = "chefbyte-event-images"


class ImageUploader:
    """Upload Pi event images to Supabase Storage after a successful drain.

    Parameters
    ----------
    supabase_url:
        Project base URL, e.g. ``https://abc.supabase.co``.  No trailing slash.
    service_role_key:
        service_role JWT.  Never sent to the browser — only used on the Pi.
    events_root:
        ``AppConfig.events_root`` — the directory under which per-event
        subdirectories live (``<events_root>/<pi_event_id>/before.jpg``).
    timeout_s:
        Per-upload HTTP timeout.  Default 15s — generous for a JPEG over LAN.
    """

    def __init__(
        self,
        supabase_url: str,
        service_role_key: str,
        events_root: Path,
        *,
        timeout_s: float = 15.0,
    ) -> None:
        self._base = supabase_url.rstrip("/")
        self._key = service_role_key
        self._events_root = Path(events_root)
        self._timeout_s = timeout_s
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Authorization": f"Bearer {service_role_key}",
                "apikey": service_role_key,
                "x-upsert": "true",  # overwrite on retry
            }
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def upload_event_images(
        self,
        *,
        user_id: str,
        cloud_event_id: str,
        pi_event_id: str,
    ) -> Tuple[Optional[str], Optional[str]]:
        """Upload before/after images and return (before_url, after_url).

        Both values are ``None`` on failure (the caller logs and continues).
        Partial success (one image uploaded, the other fails) returns the
        uploaded URL + ``None`` for the failed one — the caller writes
        whatever it has.

        Parameters
        ----------
        user_id:
            Supabase auth user UUID (scopes the storage path).
        cloud_event_id:
            ``shelf_event_log.event_id`` UUID — used as the storage object's
            directory component.  NOT the Pi-local scale_events.event_id.
        pi_event_id:
            Pi-local ``scale_events.event_id`` — used to find the image files
            on disk under ``events_root/<pi_event_id>/``.
        """
        event_dir = self._events_root / pi_event_id
        before_url = self._upload_single(
            local_path=event_dir / "before.jpg",
            user_id=user_id,
            cloud_event_id=cloud_event_id,
            filename="before.jpg",
        )
        after_url = self._upload_single(
            local_path=event_dir / "after.jpg",
            user_id=user_id,
            cloud_event_id=cloud_event_id,
            filename="after.jpg",
        )
        return before_url, after_url

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _object_path(self, user_id: str, cloud_event_id: str, filename: str) -> str:
        return f"{user_id}/{cloud_event_id}/{filename}"

    def _upload_url(self, object_path: str) -> str:
        return self._base + _STORAGE_UPLOAD_PATH.format(
            bucket=BUCKET, object_path=object_path
        )

    def _public_url(self, object_path: str) -> str:
        return self._base + _STORAGE_PUBLIC_URL.format(
            bucket=BUCKET, object_path=object_path
        )

    def _upload_single(
        self,
        *,
        local_path: Path,
        user_id: str,
        cloud_event_id: str,
        filename: str,
    ) -> Optional[str]:
        """Upload one file; return public HTTPS URL on success, None on failure."""
        if not local_path.exists():
            log.debug(
                "image_uploader: %s not found on disk — skipping",
                local_path,
            )
            return None
        object_path = self._object_path(user_id, cloud_event_id, filename)
        upload_url = self._upload_url(object_path)
        try:
            data = local_path.read_bytes()
        except OSError as exc:
            log.warning(
                "image_uploader: could not read %s: %s", local_path, exc
            )
            return None
        try:
            resp = self._session.post(
                upload_url,
                data=data,
                headers={"Content-Type": "image/jpeg"},
                timeout=self._timeout_s,
            )
            if not resp.ok:
                log.warning(
                    "image_uploader: upload failed for %s: HTTP %s %s",
                    object_path, resp.status_code, resp.text[:200],
                )
                return None
        except requests.RequestException as exc:
            log.warning(
                "image_uploader: network error uploading %s: %s",
                object_path, exc,
            )
            return None
        return self._public_url(object_path)

    @classmethod
    def from_config(
        cls,
        cfg: "object",
        *,
        timeout_s: float = 15.0,
    ) -> Optional["ImageUploader"]:
        """Build an uploader from AppConfig, or None if not configured.

        Returns ``None`` (not an error) when either ``cloud_supabase_url``
        or ``cloud_service_role_key`` is empty — image upload is silently
        disabled and the LAN URL fallback stays active.
        """
        supabase_url = getattr(cfg, "cloud_supabase_url", "")
        service_role_key = getattr(cfg, "cloud_service_role_key", "")
        if not supabase_url or not service_role_key:
            return None
        events_root = getattr(cfg, "events_root", None)
        if not events_root:
            log.warning(
                "image_uploader: events_root not set in config — "
                "image upload disabled"
            )
            return None
        return cls(
            supabase_url,
            service_role_key,
            Path(events_root),
            timeout_s=timeout_s,
        )


def write_image_urls_to_cloud(
    *,
    supabase_url: str,
    service_role_key: str,
    cloud_event_id: str,
    before_url: Optional[str],
    after_url: Optional[str],
    timeout_s: float = 10.0,
) -> bool:
    """PATCH shelf_event_log image URL columns via Supabase REST API.

    Uses the PostgREST REST API (service_role, bypasses RLS) to UPDATE
    ``chefbyte.shelf_event_log`` directly — no edge function round-trip
    needed since we already have the service_role key on the Pi.

    Returns True on success, False on any failure (caller logs + continues).
    """
    if not supabase_url or not service_role_key:
        return False
    if not before_url and not after_url:
        return False

    rest_url = (
        supabase_url.rstrip("/")
        + "/rest/v1/shelf_event_log"
        + f"?event_id=eq.{cloud_event_id}"
    )
    body: dict = {}
    if before_url:
        body["before_image_url"] = before_url
    if after_url:
        body["after_image_url"] = after_url

    headers = {
        "Authorization": f"Bearer {service_role_key}",
        "apikey": service_role_key,
        "Content-Type": "application/json",
        "Prefer": "return=minimal",
        # PostgREST requires the schema header for non-public schemas.
        "Accept-Profile": "chefbyte",
        "Content-Profile": "chefbyte",
    }
    try:
        resp = requests.patch(
            rest_url,
            json=body,
            headers=headers,
            timeout=timeout_s,
        )
        if not resp.ok:
            log.warning(
                "image_uploader: PATCH shelf_event_log failed: HTTP %s %s",
                resp.status_code, resp.text[:200],
            )
            return False
    except requests.RequestException as exc:
        log.warning(
            "image_uploader: network error patching shelf_event_log: %s", exc
        )
        return False
    return True


__all__ = [
    "ImageUploader",
    "write_image_urls_to_cloud",
]
