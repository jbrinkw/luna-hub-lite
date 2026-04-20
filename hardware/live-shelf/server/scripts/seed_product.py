#!/usr/bin/env python3
"""Interactive seeder for one Live Shelf demo product.

This script consumes a product profile JSON (see ``demo_seeds/*.json``) and
drives the running Live Shelf server's intake HTTP API to:

1.  Re-verify OpenFoodFacts data for the barcode (cache-bust sanity check).
2.  Capture 3 reference photos from the live camera while the product sits
    on the shelf under a stable weight reading.
3.  Create the product + reference image rows + the initial on-shelf lot.

The script talks to the server exclusively through the HTTP intake API
defined in ``server/intake/routes.py`` — no direct DB access, no SSH.

Usage
-----
::

    python seed_product.py path/to/demo_seeds/<barcode>.json \\
        [--host http://192.168.0.181:8000] \\
        [--skip-lookup] [--yes]

``--skip-lookup`` skips the ``/api/intake/lookup`` call (useful if OFF is down).

``--yes`` auto-accepts all "press Enter" prompts. Use only for dry runs where
you are not actually staging products on a shelf.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx

DEFAULT_HOST = "http://192.168.0.181:8000"
DEFAULT_TIMEOUT_S = 10.0
CAPTURE_COUNT = 3
CAPTURE_SLEEP_S = 1.0


# ---------------------------------------------------------------------------
# Utility
# ---------------------------------------------------------------------------


def _p(msg: str = "") -> None:
    print(msg, flush=True)


def _prompt(msg: str, *, auto_yes: bool = False) -> None:
    """Pause for user confirmation. ``auto_yes`` skips interactive input."""
    if auto_yes:
        _p(f">>> {msg} [auto-yes]")
        return
    try:
        input(f">>> {msg} ")
    except EOFError:
        # Non-interactive stdin — treat as auto-continue
        _p("    [stdin closed — continuing]")


def _die(msg: str, *, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def _safe_host(host: str) -> str:
    return host.rstrip("/")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------


def _get(client: httpx.Client, path: str) -> Any:
    url = path if path.startswith("http") else f"{client.base_url}{path}"
    try:
        resp = client.get(path)
    except httpx.HTTPError as exc:
        _die(f"GET {url} failed: {exc}")
    return _handle_response(resp, f"GET {path}")


def _post(client: httpx.Client, path: str, body: dict[str, Any]) -> Any:
    url = f"{client.base_url}{path}"
    try:
        resp = client.post(path, json=body)
    except httpx.HTTPError as exc:
        _die(f"POST {url} failed: {exc}")
    return _handle_response(resp, f"POST {path}")


def _handle_response(resp: httpx.Response, ctx: str) -> Any:
    if resp.status_code >= 400:
        body_preview = ""
        try:
            body_preview = resp.text[:500]
        except Exception:
            body_preview = "<binary/unreadable>"
        _die(f"{ctx} → {resp.status_code}\n{body_preview}")
    try:
        return resp.json()
    except ValueError:
        _die(f"{ctx} returned non-JSON: {resp.text[:200]}")


# ---------------------------------------------------------------------------
# Profile loading
# ---------------------------------------------------------------------------


def load_profile(path: Path) -> dict[str, Any]:
    if not path.is_file():
        _die(f"profile not found: {path}")
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        _die(f"profile is not valid JSON ({path}): {exc}")
    if not isinstance(data, dict):
        _die(f"profile must be a JSON object ({path})")
    for required in ("barcode", "form_suggested"):
        if required not in data:
            _die(f"profile missing required key '{required}' ({path})")
    return data


def build_save_payload(
    profile: dict[str, Any],
    *,
    temp_id: str,
    image_paths: list[str],
    gross_weight_g: Optional[float],
) -> dict[str, Any]:
    form = dict(profile.get("form_suggested") or {})
    barcode = str(profile.get("barcode") or "").strip()

    # Only keep fields the IntakeForm dataclass understands. Unknown keys
    # are ignored server-side, but keeping the payload tight makes the logs
    # easier to read when things go wrong.
    allowed = {
        "name",
        "barcode",
        "brand",
        "variant",
        "net_weight_g",
        "gross_weight_g",
        "tare_weight_g",
        "serving_weight_g",
        "servings_per_container",
        "unit_type",
        "density_g_per_ml",
        "container_type",
        "temp_id",
        "image_paths",
    }
    payload: dict[str, Any] = {k: v for k, v in form.items() if k in allowed}
    payload["barcode"] = barcode
    payload["temp_id"] = temp_id
    payload["image_paths"] = list(image_paths)
    if gross_weight_g is not None:
        payload["gross_weight_g"] = gross_weight_g
    return payload


# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------


def seed_one(
    profile_path: Path,
    *,
    host: str,
    skip_lookup: bool = False,
    auto_yes: bool = False,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> dict[str, Any]:
    """Seed one product. Returns the ``/api/intake/save`` response dict."""
    host = _safe_host(host)
    profile = load_profile(profile_path)
    barcode = str(profile["barcode"]).strip()
    display_name = (profile.get("form_suggested") or {}).get("name") or barcode

    _p("")
    _p("=" * 60)
    _p(f"  Seeding: {display_name}")
    _p(f"  Barcode: {barcode}")
    _p(f"  Profile: {profile_path}")
    _p(f"  Server:  {host}")
    _p("=" * 60)

    with httpx.Client(base_url=host, timeout=timeout_s) as client:
        # 1. Verify server reachable + capture baseline weight
        _p("")
        _p("[1/5] Checking server reachability (/api/state)...")
        state = _get(client, "/api/state")
        baseline_weight = state.get("last_scale_weight_g")
        door_open = state.get("door_open")
        _p(f"      door_open={door_open}  last_scale_weight_g={baseline_weight}")
        if baseline_weight is None:
            _p(
                "      WARN: scale has no weight reading yet. Make sure the ESP "
                "is posting heartbeats."
            )

        # 2. Re-verify OFF lookup (optional)
        if not skip_lookup:
            _p("")
            _p("[2/5] Re-fetching OpenFoodFacts data (/api/intake/lookup)...")
            lookup = _post(client, "/api/intake/lookup", {"barcode": barcode})
            off = (lookup or {}).get("off") or {}
            if off.get("found"):
                _p(
                    f"      OFF: {off.get('product_name')!r} "
                    f"brand={off.get('brands')!r} "
                    f"product_quantity_g={off.get('product_quantity_g')}"
                )
            else:
                _p("      OFF lookup returned no product (will use profile as-is)")
        else:
            _p("")
            _p("[2/5] Skipping OFF lookup (--skip-lookup)")

        # 3. Mint a temp_id and prompt placement
        temp_id = str(uuid.uuid4())
        _p("")
        _p(f"[3/5] temp_id for this intake: {temp_id}")
        _prompt(
            f"Place '{display_name}' on the shelf. Press Enter when stable weight is shown.",
            auto_yes=auto_yes,
        )

        # Refresh state to record the placed weight
        state_after = _get(client, "/api/state")
        gross_weight_g = state_after.get("last_scale_weight_g")
        _p(f"      placed weight (gross_weight_g): {gross_weight_g}")
        if gross_weight_g is None:
            _p("      WARN: no scale reading captured; continuing without gross_weight_g.")

        # 4. Capture 3 reference images
        _p("")
        _p(f"[4/5] Capturing {CAPTURE_COUNT} reference images...")
        image_paths: list[str] = []
        image_ids: list[str] = []
        for i in range(1, CAPTURE_COUNT + 1):
            _prompt(
                f"Capture {i}/{CAPTURE_COUNT} — adjust angle slightly if you want, then Enter.",
                auto_yes=auto_yes,
            )
            cap = _post(
                client,
                "/api/intake/capture-ref",
                {"temp_id": temp_id},
            )
            image_id = cap.get("image_id")
            file_path = cap.get("file_path")
            if not image_id or not file_path:
                _die(f"capture-ref returned unexpected payload: {cap}")
            image_ids.append(image_id)
            image_paths.append(file_path)
            _p(f"      captured: {file_path}  (id={image_id})")
            if i < CAPTURE_COUNT:
                time.sleep(CAPTURE_SLEEP_S)

        # 5. Save
        _p("")
        _p("[5/5] Saving product + initial lot (/api/intake/save)...")
        payload = build_save_payload(
            profile,
            temp_id=temp_id,
            image_paths=image_paths,
            gross_weight_g=gross_weight_g,
        )
        save = _post(client, "/api/intake/save", payload)
        product_id = save.get("product_id")
        lot_id = save.get("lot_id")
        ref_ids = save.get("reference_image_ids") or []
        if not product_id:
            _die(f"/api/intake/save returned unexpected payload: {save}")

    _p("")
    _p("-" * 60)
    _p("  Seeded successfully")
    _p(f"  product_id: {product_id}")
    if lot_id:
        _p(f"  lot_id:     {lot_id}")
    else:
        _p("  lot_id:     (none — intake is catalog-only; lot will be created "
           "when a unit is placed on the live shelf)")
    _p(f"  refs:       {len(ref_ids)} image row(s): {ref_ids}")
    _p("-" * 60)

    return {
        "product_id": product_id,
        "lot_id": lot_id,
        "reference_image_ids": ref_ids,
        "temp_id": temp_id,
        "image_paths": image_paths,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Seed one demo product into a running Live Shelf server via the intake HTTP API.",
    )
    ap.add_argument("profile", type=Path, help="Path to a demo_seeds/<barcode>.json profile file.")
    ap.add_argument(
        "--host",
        default=DEFAULT_HOST,
        help=f"Server base URL (default: {DEFAULT_HOST})",
    )
    ap.add_argument(
        "--skip-lookup",
        action="store_true",
        help="Skip the /api/intake/lookup sanity call (use if OFF is down).",
    )
    ap.add_argument(
        "--yes",
        action="store_true",
        help="Auto-accept all interactive prompts (for dry runs only).",
    )
    ap.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_S,
        help=f"Per-request HTTP timeout in seconds (default: {DEFAULT_TIMEOUT_S})",
    )
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    args = build_argparser().parse_args(argv)
    try:
        seed_one(
            args.profile,
            host=args.host,
            skip_lookup=args.skip_lookup,
            auto_yes=args.yes,
            timeout_s=args.timeout,
        )
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover — top-level safety net
        _die(f"unexpected failure: {exc!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
