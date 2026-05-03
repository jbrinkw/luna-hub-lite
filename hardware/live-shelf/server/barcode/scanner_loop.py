"""Scanner orchestration loop.

Pulls barcodes from a source iterator (HID listener in production, fake
in tests) and forwards each to the cloud via
CloudClient.post_barcode_scan.

Failure handling:
  * Cloud errors are logged and swallowed; the loop never crashes.
  * pi_event_id is generated per-scan as ``barcode-<uuid4>`` so
    process-restart retries get fresh IDs. The cloud's idempotency layer
    deduplicates retries within a single pi_event_id.
"""
from __future__ import annotations
import logging
import uuid
from typing import Any, Callable, Iterator

logger = logging.getLogger(__name__)


class ScannerLoop:
    def __init__(
        self,
        *,
        cloud_client: Any,
        barcode_source: Callable[[], Iterator[str]],
    ) -> None:
        self._cloud = cloud_client
        self._source_factory = barcode_source
        self._iterator: Iterator[str] | None = None

    def _ensure_iter(self) -> Iterator[str]:
        if self._iterator is None:
            self._iterator = iter(self._source_factory())
        return self._iterator

    def _post_one(self, barcode: str) -> None:
        pi_event_id = f'barcode-{uuid.uuid4()}'
        try:
            res = self._cloud.post_barcode_scan(
                barcode=barcode, pi_event_id=pi_event_id,
            )
            logger.info('barcode: %s → tx=%s status=%s',
                        barcode, res.get('transaction_id'), res.get('status'))
        except Exception:
            logger.warning(
                'barcode: cloud post failed for %s (non-fatal)',
                barcode, exc_info=True,
            )

    def run_once(self) -> None:
        """Pull the next barcode and forward it. Exit cleanly when source
        is exhausted; tests rely on this single-step API."""
        try:
            barcode = next(self._ensure_iter())
        except StopIteration:
            return
        self._post_one(barcode)

    def run_forever(self) -> None:
        """Production entry point — loops until the source is exhausted."""
        for barcode in self._source_factory():
            self._post_one(barcode)
