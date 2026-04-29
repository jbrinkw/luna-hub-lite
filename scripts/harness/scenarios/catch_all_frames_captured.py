"""Scenario: catch-all event captures only after.jpg on Pi disk (single-frame).

Bug class
---------
Catch-all events have no brightness-driven ``session_capture`` pipeline
(see ``ScaleHandler._capture_catch_all_frames`` docstring). Without an
inline ring-buffer capture at event time, catch-all events never get
JPEGs on disk — the Pi's ``/event/<id>/before.jpg`` route 404s and the
cloud event viewer shows placeholder tiles forever. This scenario pins
the contract:

  1. A catch-all event MUST produce ``data/events/<event_id>/before.jpg``
     AND ``data/events/<event_id>/after.jpg`` on the Pi's disk at the
     moment ``handle_scale_event`` returns.
  2. The Pi's local ``scale_events`` row records the event_id so the
     frames can be associated back to the cloud event viewer via
     ``/event/<event_id>/*.jpg`` LAN fetch.

Scope note: we do NOT assert the cloud ``shelf_event_log`` row here.
Catch-all events emit to cloud only after the classifier pipeline
closes a session + the reconciler runs — a multi-step flow that needs
a real classifier + frame buffer. The on-disk frame capture happens
inline in ``handle_scale_event`` regardless, which is the specific
contract this scenario pins. The single_item_first_placement scenario
already covers the outbox → cloud round trip on the simpler live_scale
path.

Test wiring
-----------
We install a minimal ``_MiniCameraDaemon`` stand-in whose
``snapshot_ring()`` returns an empty list (forces the "ring miss"
branch in ``_capture_catch_all_frames``) and whose
``current_frame_jpeg()`` returns a well-formed JPEG byte stream. This
exercises the fallback path the handler uses when the ring is empty —
the most common production case during the first few hundred ms after
an event fires (frames older than 2s slop are rejected; fresh frames
may not be in the ring yet).

The full-ring happy path is tested by the Pi-side unit tests; here we
just need ONE frame on disk per event, which is what the fallback
gives us.
"""

from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

from scripts.harness.orchestrator import HarnessContext, scenario


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

REPO_ROOT = Path(__file__).resolve().parents[3]
LIVE_SHELF_DIR = REPO_ROOT / "hardware" / "live-shelf"
if str(LIVE_SHELF_DIR) not in sys.path:
    sys.path.insert(0, str(LIVE_SHELF_DIR))


# ---------------------------------------------------------------------------
# Minimal fake camera
# ---------------------------------------------------------------------------
# A 1×1 black JPEG — the smallest valid JPEG that cv2 / PIL will accept.
# Produced via `cv2.imencode('.jpg', np.zeros((1,1,3), np.uint8))` and
# captured here as a literal so the harness doesn't need cv2 just to
# generate a fake frame. Byte-for-byte from that output.
_TINY_JPEG = bytes.fromhex(
    "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707"
    "07090908080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c23"
    "1c1c2837292c30313434341f27393d38323c2e333432ffdb0043010909090c0b0c18"
    "0d0d1832211c21323232323232323232323232323232323232323232323232323232"
    "323232323232323232323232323232323232323232323232ffc00011080001000103"
    "012200021101031101ffc4001f0000010501010101010100000000000000000102030"
    "405060708090a0bffc400b5100002010303020403050504040000017d010203000411"
    "05122131410613516107227114328191a1082342b1c11552d1f02433627282090a16"
    "1718191a25262728292a3435363738393a434445464748494a535455565758595a63"
    "6465666768696a737475767778797a838485868788898a92939495969798999aa2a3"
    "a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9da"
    "e1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffc4001f0100030101010101010101"
    "01010000000000000102030405060708090a0bffc400b5110002010204040304070504"
    "0400010277000102031104052131061241510761711322328108144291a1b1c10923"
    "3352f0156272d10a162434e125f11718191a262728292a35363738393a4344454647"
    "48494a535455565758595a636465666768696a737475767778797a82838485868788"
    "898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6"
    "c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9faffda00"
    "0c03010002110311003f00fbfce28affd9"
)


class _MiniCameraDaemon:
    """Stand-in for :class:`~server.camera.daemon.CameraDaemon`.

    Provides only the two attributes ``_capture_catch_all_frames``
    touches: ``snapshot_ring`` (returning an empty list to trigger the
    "ring miss" fallback) and ``current_frame_jpeg`` (the fallback
    source). This is the same shape as the real daemon's public
    interface for these two methods, so the handler doesn't know the
    difference.
    """

    def snapshot_ring(self):
        return []

    def current_frame_jpeg(self, quality: int = 85):
        return _TINY_JPEG

    def current_frame(self):  # pragma: no cover - not used by this scenario
        return None


@scenario("catch_all_frames_captured")
def _catch_all_frames_captured(ctx: HarnessContext) -> None:
    # 1. Seed cloud: user + device + product. Pair scale-02 as catch_all
    # so handler accepts + categorizes correctly.
    ctx.seed_cloud_user()
    ctx.seed_device()
    product_id = ctx.seed_product(
        name="Catch-all test product",
        net_weight_g=500.0,
    )
    # catch_all pairings MUST have product_id=NULL (enforced by the
    # scale_pairings_product_id_kind_chk CHECK in migration
    # 20260424040000). The catch-all shelf has no fixed product — the
    # classifier figures it out per-event.
    ctx.seed_pairing(
        scale_id="scale-02",
        kind="catch_all",
        product_id=None,
    )
    # Seed an existing lot so a "refilled" event has a target to
    # mutate. apply_shelf_event's branch looks for existing lots on
    # the user/product before inserting a new one.
    lot_id = ctx.seed_stock_lot(product_id=product_id, qty_containers=1.0)
    ctx.check(
        "cloud_seeded",
        True,
        evidence=f"user+device+product+lot ready (lot_id={lot_id[:8]})",
    )

    # 2. Build the Pi handler with catch-all camera wired. We bypass
    # ``build_pi_scale_handler`` because it doesn't set
    # ``catch_all_camera`` — construct the handler directly here.
    from server.handlers.scale_events import ScaleHandler  # noqa: E402
    from server.shelves import DEFAULT_REGISTRY  # noqa: E402

    class _NullCandidateSource:
        def get_on_shelf_lots(self, shelf_id=None):
            return []

        def get_recently_out_lots(self, window_seconds, shelf_id=None):
            return []

        def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
            return []

        def get_certified_not_on_shelf(self):
            return []

    # Scrub any leftover event dirs from a prior run of this scenario
    # under the same tmp_dir (HarnessContext reuses tmp_dir/<scenario>
    # across invocations to amortize init). The frame-capture happy path
    # assertion below counts dirs strictly.
    events_root = ctx.tmp_dir / "events"
    if events_root.exists():
        import shutil as _sh
        _sh.rmtree(events_root)
    events_root.mkdir(exist_ok=True)
    cam = _MiniCameraDaemon()
    import threading as _th

    handler = ScaleHandler(
        conn=ctx.pi_sqlite,
        db_lock=_th.RLock(),
        camera=None,
        candidate_source=_NullCandidateSource(),
        events_root=events_root,
        delta_threshold_g=5.0,
        lookback_seconds=2.0,
        recently_out_window_seconds=86_400,
        classifier_client=None,
        catch_all_enabled=True,
        shelf_registry_override=dict(DEFAULT_REGISTRY),
        cloud_emitter=ctx.pi_emitter,
        cloud_client=ctx.pi_cloud_client,
        catch_all_camera=cam,
    )

    # 3. Fire a catch_all refill event. scale-02 is the catch-all
    # device_id in DEFAULT_REGISTRY.
    resp, status = handler.handle_scale_event({
        "ts": _now_iso(),
        "device_id": "scale-02",
        "event_seq": 1,
        "delta_g": 500.0,
        "before_weight_g": 0.0,
        "after_weight_g": 500.0,
    })
    ctx.check(
        "handler_accepted",
        status == 200,
        evidence=f"status={status} resp={resp!r}",
    )

    # 4. On-disk: catch-all writes ONLY after.jpg (single-frame model
    # per commit 2d7a819 / 2026-04-29). The shelf-flavored before/after
    # delta math doesn't apply to catch-all events — the catch-all
    # classifier prompt is single-image and works against absolute scale
    # weight, not delta.
    event_dirs = [p for p in events_root.iterdir() if p.is_dir()]
    ctx.check(
        "event_dir_created",
        len(event_dirs) == 1,
        evidence=(
            f"expected exactly 1 event dir under {events_root}; "
            f"got {event_dirs!r}"
        ),
    )
    if event_dirs:
        event_dir = event_dirs[0]
        before = event_dir / "before.jpg"
        after = event_dir / "after.jpg"
        ctx.check(
            "after_jpg_exists",
            after.is_file() and after.stat().st_size > 0,
            evidence=(
                f"after.jpg missing or empty at {after} "
                f"(dir contents: {sorted(p.name for p in event_dir.iterdir())})"
            ),
        )
        ctx.check(
            "before_jpg_NOT_present",
            not before.exists(),
            evidence=(
                f"single-frame contract: before.jpg must NOT be written "
                f"for catch-all events. Found at {before}. "
                f"(dir contents: {sorted(p.name for p in event_dir.iterdir())})"
            ),
        )
        pi_event_id = event_dir.name
    else:
        pi_event_id = None

    # 5. Pi-local scale_events row: the event is recorded with the
    # same event_id as the on-disk directory, which is how the Pi's
    # Flask `/event/<event_id>/before.jpg` route resolves. If this row
    # is missing, the frames exist on disk but nothing routes to them.
    if pi_event_id is not None:
        scale_row = ctx.pi_sqlite.execute(
            "SELECT event_id, shelf_id FROM scale_events WHERE event_id = ?",
            (pi_event_id,),
        ).fetchone()
        ctx.check(
            "pi_scale_event_row_recorded",
            scale_row is not None,
            evidence=(
                f"scale_events row must exist for event_id={pi_event_id} "
                f"(otherwise the Pi's /event/<id>/*.jpg route can't find "
                f"the event); got row={scale_row!r}"
            ),
        )
        if scale_row is not None:
            scale_dict = (
                dict(scale_row)
                if hasattr(scale_row, "keys")
                else {"event_id": scale_row[0], "shelf_id": scale_row[1]}
            )
            ctx.check(
                "scale_event_shelf_id_catch_all",
                scale_dict.get("shelf_id") == "catch_all",
                evidence=(
                    f"scale_events.shelf_id must be 'catch_all' for "
                    f"catch-all events; got {scale_dict!r}"
                ),
            )
