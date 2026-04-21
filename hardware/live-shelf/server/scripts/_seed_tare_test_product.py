"""One-shot on-Pi probe: ensure at least one certified catalog row exists.

Run on the Pi via::

    cd /home/jeremy/live-shelf && .venv/bin/python -m server.scripts._seed_tare_test_product

Seeds a single certified product (name='Tare Test Jar', barcode='tare-test-001')
if the catalog has zero certified-not-on-shelf rows. Idempotent: re-running is a
no-op once the product exists.

Used to bring up an end-to-end tare-capture demo on a freshly-wiped Pi where
the cloud catalog hasn't synced any products. Safe to leave deployed; noise
it adds to the catalog is a single clearly-named row.
"""

from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from server.config import AppConfig  # noqa: E402
from server.storage import init_db, repo as storage_repo  # noqa: E402
from server.storage.models import ProductIn  # noqa: E402


def main() -> int:
    cfg = AppConfig()
    conn = init_db(str(cfg.db_path))
    certified = [p for p in storage_repo.list_products(conn) if p.certified]
    if certified:
        p = certified[0]
        print(
            f"already have certified product: {p.product_id} {p.name!r}"
        )
        return 0
    p = storage_repo.create_product(
        conn,
        ProductIn(
            name="Tare Test Jar",
            barcode="tare-test-001",
            unit_type="solid",
            container_type="jar",
            certified=1,
        ),
    )
    print(f"created: {p.product_id} {p.name!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
