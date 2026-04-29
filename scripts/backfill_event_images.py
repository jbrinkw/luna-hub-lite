#!/usr/bin/env python3
"""One-shot backfill: upload missing event images to Supabase Storage.

Queries chefbyte.shelf_event_log for rows whose before_image_url or
after_image_url is NULL, then for each fetches the before/after JPEG from
the Pi's LAN web server (http://<lan_ip>:8000/event/<pi_event_id>/<frame>.jpg),
uploads them to Supabase Storage, and writes the resulting HTTPS URLs back to
the DB.

WHEN TO RUN
-----------
Run this script once (or periodically) from a host that can reach the Pi on
the LAN (the Pi itself is ideal).  It requires:

  - Pi web server reachable at LAN IP
  - Supabase service_role key and project URL
  - The chefbyte-event-images Storage bucket to exist (migration 20260429290000)
  - shelf_event_log.before_image_url / after_image_url columns to exist
    (migration 20260429300000)

CONFIGURATION
-------------
Set via environment variables or a local .env file (see .env.example):

  SUPABASE_URL         https://<project>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY  <service_role JWT>
  PI_LAN_IP            192.168.0.181   (or hostname)
  PI_WEB_PORT          8000            (default)
  DRY_RUN              1               (print plan, don't upload)

USAGE
-----
  # From the Pi or a host on the same LAN as the Pi:
  pip install requests python-dotenv
  python scripts/backfill_event_images.py

  # Dry-run first to see what would be uploaded:
  DRY_RUN=1 python scripts/backfill_event_images.py

NOTES
-----
- Idempotent: skips rows that already have both URLs populated.
- If the Pi is unreachable, the script skips rather than failing; run again
  when the Pi is back online.
- pi_event_id NULL rows are skipped (no image to look up).
- The user_id in the storage path comes from shelf_event_log.user_id.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

try:
    from dotenv import load_dotenv
    _env_file = Path(__file__).resolve().parents[1] / ".env"
    if _env_file.exists():
        load_dotenv(_env_file)
    _local_env = _env_file.with_name(".env.local")
    if _local_env.exists():
        load_dotenv(_local_env, override=True)
except ImportError:
    pass  # python-dotenv optional

import requests

# ---------------------------------------------------------------------------
# Config from env
# ---------------------------------------------------------------------------

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
PI_LAN_IP = os.environ.get("PI_LAN_IP", "192.168.0.181")
PI_WEB_PORT = int(os.environ.get("PI_WEB_PORT", "8000"))
DRY_RUN = os.environ.get("DRY_RUN", "0").strip() in {"1", "true", "yes"}
BUCKET = "chefbyte-event-images"
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "50"))

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_config() -> None:
    missing = []
    if not SUPABASE_URL:
        missing.append("SUPABASE_URL")
    if not SERVICE_ROLE_KEY:
        missing.append("SUPABASE_SERVICE_ROLE_KEY")
    if missing:
        print(f"ERROR: missing required env vars: {', '.join(missing)}", file=sys.stderr)
        print("Set them in your environment or .env file.", file=sys.stderr)
        sys.exit(1)


def _rest_headers() -> dict:
    return {
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "apikey": SERVICE_ROLE_KEY,
        "Accept-Profile": "chefbyte",
        "Content-Profile": "chefbyte",
    }


def _storage_headers(content_type: str = "image/jpeg") -> dict:
    return {
        "Authorization": f"Bearer {SERVICE_ROLE_KEY}",
        "apikey": SERVICE_ROLE_KEY,
        "Content-Type": content_type,
        "x-upsert": "true",
    }


def fetch_pending_events(session: requests.Session) -> list[dict]:
    """Fetch shelf_event_log rows with missing cloud image URLs."""
    url = (
        SUPABASE_URL
        + "/rest/v1/shelf_event_log"
        + "?select=event_id,user_id,pi_event_id,before_image_url,after_image_url"
        + "&or=(before_image_url.is.null,after_image_url.is.null)"
        + "&pi_event_id=not.is.null"
        + f"&limit={BATCH_SIZE}"
        + "&order=created_at.asc"
    )
    resp = session.get(url, headers=_rest_headers(), timeout=10)
    resp.raise_for_status()
    return resp.json() or []


def fetch_image_from_pi(
    session: requests.Session,
    pi_event_id: str,
    filename: str,
) -> Optional[bytes]:
    """Fetch a JPEG from the Pi's LAN web server. Returns None if unreachable."""
    url = f"http://{PI_LAN_IP}:{PI_WEB_PORT}/event/{pi_event_id}/{filename}"
    try:
        resp = session.get(url, timeout=5)
        if resp.ok:
            return resp.content
        print(f"  Pi returned {resp.status_code} for {url}")
        return None
    except requests.RequestException as exc:
        print(f"  Pi unreachable ({url}): {exc}")
        return None


def upload_to_storage(
    session: requests.Session,
    object_path: str,
    data: bytes,
) -> Optional[str]:
    """Upload bytes to Supabase Storage; return public HTTPS URL on success."""
    upload_url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{object_path}"
    try:
        resp = session.post(
            upload_url,
            data=data,
            headers=_storage_headers(),
            timeout=20,
        )
        if not resp.ok:
            print(f"  Storage upload failed ({resp.status_code}): {resp.text[:200]}")
            return None
    except requests.RequestException as exc:
        print(f"  Storage upload error: {exc}")
        return None
    return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{object_path}"


def write_urls_to_db(
    session: requests.Session,
    event_id: str,
    before_url: Optional[str],
    after_url: Optional[str],
) -> bool:
    """PATCH shelf_event_log with cloud image URLs."""
    body: dict = {}
    if before_url:
        body["before_image_url"] = before_url
    if after_url:
        body["after_image_url"] = after_url
    if not body:
        return True

    url = SUPABASE_URL + f"/rest/v1/shelf_event_log?event_id=eq.{event_id}"
    try:
        resp = session.patch(
            url,
            json=body,
            headers={**_rest_headers(), "Content-Type": "application/json", "Prefer": "return=minimal"},
            timeout=10,
        )
        if not resp.ok:
            print(f"  DB PATCH failed ({resp.status_code}): {resp.text[:200]}")
            return False
    except requests.RequestException as exc:
        print(f"  DB PATCH error: {exc}")
        return False
    return True


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    _check_config()

    if DRY_RUN:
        print("DRY RUN mode — no uploads or DB writes will happen.\n")

    session = requests.Session()

    print(f"Fetching pending events (batch={BATCH_SIZE})…")
    try:
        rows = fetch_pending_events(session)
    except requests.RequestException as exc:
        print(f"ERROR fetching pending events: {exc}", file=sys.stderr)
        sys.exit(1)

    if not rows:
        print("Nothing to backfill — all events already have cloud image URLs.")
        return

    print(f"Found {len(rows)} event(s) with missing image URLs.\n")

    ok_count = 0
    skip_count = 0
    fail_count = 0

    for row in rows:
        event_id: str = row["event_id"]
        user_id: str = row["user_id"]
        pi_event_id: str = row["pi_event_id"]
        existing_before: Optional[str] = row.get("before_image_url")
        existing_after: Optional[str] = row.get("after_image_url")

        print(f"Event {event_id} (pi_event_id={pi_event_id})")

        before_url = existing_before
        after_url = existing_after

        for filename, existing in [
            ("before.jpg", existing_before),
            ("after.jpg", existing_after),
        ]:
            if existing:
                print(f"  {filename}: already uploaded → skip")
                continue

            if DRY_RUN:
                print(f"  {filename}: DRY RUN — would fetch from Pi and upload")
                continue

            data = fetch_image_from_pi(session, pi_event_id, filename)
            if data is None:
                skip_count += 1
                continue

            object_path = f"{user_id}/{event_id}/{filename}"
            cloud_url = upload_to_storage(session, object_path, data)
            if cloud_url is None:
                fail_count += 1
                continue

            print(f"  {filename}: uploaded → {cloud_url}")
            if filename == "before.jpg":
                before_url = cloud_url
            else:
                after_url = cloud_url

        if DRY_RUN:
            continue

        wrote = write_urls_to_db(session, event_id, before_url, after_url)
        if wrote:
            ok_count += 1
        else:
            fail_count += 1

    print(f"\nDone. ok={ok_count} skip={skip_count} fail={fail_count}")
    if fail_count:
        sys.exit(1)


if __name__ == "__main__":
    main()
