"""Session-boundary frame capture.

Subscribes to the camera daemon's brightness watcher. On a ``door_open``
transition we record the open timestamp; on ``door_close`` we walk the
ring buffer to build a complete session record containing:

    * ``before.jpg``  — first well-exposed frame of the session (skipping
      the initial overexposed burst while auto-exposure is still adapting)
    * ``after.jpg``   — last lit frame before the door started closing
    * ``session.mp4`` — all lit, non-overexposed frames as H.264 video

Scale events call :func:`get_frames_for_event` with their Pi-clock arrival
timestamp; it returns the frames from the session that *contains* that
timestamp (open_ts ≤ event_ts ≤ close_ts + grace), not just "the most
recent closed session." This avoids the prior bug where back-to-back
sessions or late-settling events silently attached the wrong pair.

If no session matches the event's timestamp, the function returns
``(None, None, None)`` rather than falling back to stale frames.
"""

from __future__ import annotations

import logging
import shutil
import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Deque, Optional

import cv2
import numpy as np

from .daemon import BrightnessTransition, CameraDaemon, compute_brightness

log = logging.getLogger(__name__)

# Brightness above which we consider a frame "lit." Matches the daemon's
# door-open gate — anything below is effectively dark. Tuned for this rig:
# closed ≈ 0.8, open ≈ 18 with exposure locked at 1600.
LIT_BRIGHTNESS_MIN: float = 8.0

# Upper bound on brightness for "usable" frames. Exposure is now manually
# locked (see locked_settings.py), so the old auto-adaptation whiteout
# during the first ~2 seconds after door open no longer happens — steady
# brightness sits around ~190. This threshold is just a sanity ceiling
# near pure-white (255) to catch genuine saturation (e.g. a stray bright
# reflection), not adaptation bursts. Frames above it are excluded from
# both the before-pick and the video.
OVEREXPOSED_THRESHOLD: float = 240.0

# JPEG quality for session frames.
JPEG_QUALITY: int = 90

# Grace period after close during which an event is still considered part
# of the session. ESP stability detection typically lags door close by
# 1-5 seconds, but some items (e.g. a cream-cheese tub or other soft /
# bouncy containers) take noticeably longer than 10s to settle before the
# ESP declares stability. 30s accommodates those slow-settling items
# without extending far enough to match unrelated later events.
POST_CLOSE_GRACE_S: float = 30.0

# Tolerance on the close-time frame bound. Frames captured in the few
# hundred ms after the close transition fires but while `_handle_close`
# is running should still count as part of the session — the brightness
# callback and the capture thread are independent, so a frame's ts can
# be slightly after close_ts purely due to thread scheduling jitter.
# Frames beyond this tolerance are assumed to be post-close and are
# excluded from the after-pick / video.
FRAME_CLOSE_TOLERANCE_S: float = 0.5

# Settling delay for the SESSION-WIDE before/after picks (used when no
# per-event framing applies). The camera has internal AGC that takes a
# few frames to ramp up after door-open and a few frames to react when
# the door starts closing; picking the extreme-first or extreme-last lit
# frame lands us mid-adaptation.
FRAME_SETTLE_DELAY_S: float = 0.2

# For PER-EVENT framing (pick_event_frames), the "after" frame target is
# ``event_ts - EVENT_AFTER_LOOKBACK_S``. The ESP declares stability after
# ~1s of scale samples within tolerance, so a frame at event_ts - 1.0s
# corresponds to the EARLIEST moment the scale was stable for this
# event — before the user could have started placing a subsequent item
# (because that would have broken stability). Picking in the middle of
# the stable window (the old 0.2s value) means frames ~800ms into the
# stable period, which is enough time for the user's hand to be
# reaching in with item N+1 and get captured in the frame.
EVENT_AFTER_LOOKBACK_S: float = 1.0

# Minimum gap between an event's "after" anchor and the PRIOR event's
# stability ts. For rapid back-to-back events (~3-4s apart) the next
# event's physical action can be in motion by ``event_N - 1.0s``, so we
# clamp the "after" target to be at least this far after the prior
# event's stability ts — guarantees forward progress through the
# per-event chain even when EVENT_AFTER_LOOKBACK_S would otherwise
# rewind past the prior event.
MIN_AFTER_CHAIN_GAP_S: float = 0.2

# Session-boundary guard. Per-event "before" / "after" picks are
# constrained to frames whose ts is >= session.open_ts + this offset.
# 0.0 = simple open_ts floor; tune up if AGC settling produces a burst
# of unusable frames right at open_ts. Set here so tests can mock it.
SESSION_BOUNDARY_GUARD_S: float = 0.0

# How many closed sessions to retain in memory. Each event lookup scans
# this list for a matching session. Ten is plenty for any realistic
# transaction rate while bounding memory.
MAX_RETAINED_SESSIONS: int = 10


# ----------------------------------------------------------------- state

_LOCK = threading.Lock()
_CURRENT: Optional[dict] = None
_CLOSED: Deque[dict] = deque(maxlen=MAX_RETAINED_SESSIONS)

# Optional lifecycle sink — app.py sets this after DB init so the
# capture thread can emit session_lifecycle rows without a direct DB
# handle. Signature::
#
#     sink(session_id: str | None, *, actor: str, reason_code: str,
#          payload: dict | None = None) -> None
#
# When ``None`` (tests, bare imports) we skip observability writes. The
# sink implementation MUST NOT raise — we still wrap every call.
_LIFECYCLE_SINK: Optional[Any] = None
# Same idea but for the high-volume "frame tick" stream. Called with
# ``session_id`` when LIFECYCLE_VERBOSE is on AND every 100th frame.
_LIFECYCLE_VERBOSE: bool = False


def set_lifecycle_sink(
    sink: Optional[Any],
    *,
    verbose: bool = False,
) -> None:
    """Wire an observability sink for session_lifecycle writes."""
    global _LIFECYCLE_SINK, _LIFECYCLE_VERBOSE
    _LIFECYCLE_SINK = sink
    _LIFECYCLE_VERBOSE = bool(verbose)


def _lc(session_id: Optional[str], *, actor: str, reason_code: str,
        payload: Optional[dict] = None) -> None:
    sink = _LIFECYCLE_SINK
    if sink is None or not session_id:
        return
    try:
        sink(session_id, actor=actor, reason_code=reason_code, payload=payload)
    except Exception:  # pragma: no cover - observability must not raise
        log.warning("session_capture: lifecycle sink raised", exc_info=True)

# Hard cap on lit frames streamed to disk per open session. At 10fps this
# covers ~10 minutes — far longer than any realistic multi-item placement
# window — while preventing a runaway open-door event from filling the
# SD card. When reached, additional frames are dropped with a warning
# rather than overwriting earlier frames (we want opening-state to stay
# archived; later extras can be lost safely).
LIVE_ARCHIVE_MAX_FRAMES: int = 6000


# ----------------------------------------------------------------- helpers

def _safe_ts(iso: str) -> str:
    """Colon-free version of an ISO ts suitable for a directory name."""
    return iso.replace(":", "-")


def _parse_iso(ts: str) -> Optional[datetime]:
    """Parse an ISO-8601 ts; return None on failure so callers can skip."""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def _encode_jpeg(frame: np.ndarray, path: Path) -> bool:
    """Encode and write a single JPEG. Returns True on success."""
    try:
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    except Exception:
        log.exception("session_capture: cv2.imencode threw")
        return False
    if not ok:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(buf.tobytes())
    except OSError:
        log.exception("session_capture: failed to write %s", path)
        return False
    return True


def _encode_video(frames: list[np.ndarray], path: Path, fps: float = 10.0) -> bool:
    """Encode a sequence of frames to MP4 (H.264). Returns True on success
    only when the writer was opened AND at least one frame was written AND
    the resulting file is non-empty."""
    if not frames:
        return False
    h, w = frames[0].shape[:2]
    fourcc = cv2.VideoWriter_fourcc(*"avc1")
    writer = cv2.VideoWriter(str(path), fourcc, fps, (w, h))
    if not writer.isOpened():
        log.error("session_capture: VideoWriter failed to open (codec avc1, %dx%d)",
                  w, h)
        writer.release()
        return False
    try:
        for frame in frames:
            writer.write(frame)
    finally:
        writer.release()
    if not path.exists() or path.stat().st_size == 0:
        log.error("session_capture: video file is empty after encode (%s)", path)
        return False
    return True


def _select_before_frame(
    lit: list[tuple[str, np.ndarray, float]],
) -> tuple[int, str, np.ndarray]:
    """Pick the "before" frame for the session.

    Algorithm:
      1. Find the first frame whose brightness is below
         ``OVEREXPOSED_THRESHOLD`` (auto-exposure has stepped down from
         the door-open white-out).
      2. Advance by ``FRAME_SETTLE_DELAY_S`` and pick the first frame at
         or after that target timestamp. This lands on a frame where the
         camera has fully settled and the user's hand is unlikely to be
         entering the frame yet.
      3. If no frame exists that far into the session (very short
         session), fall back to the last lit frame available.
      4. If every frame is overexposed (shouldn't happen in practice),
         fall back to the first frame.

    ``lit`` is ``[(ts, frame, brightness), ...]`` in chronological order.
    Returns ``(index, ts, frame)``.
    """
    # Step 1: find first well-exposed frame.
    first_exposed_idx = None
    first_exposed_dt = None
    for i, (ts, _frame, b) in enumerate(lit):
        if b < OVEREXPOSED_THRESHOLD:
            first_exposed_dt = _parse_iso(ts)
            first_exposed_idx = i
            break
    if first_exposed_idx is None or first_exposed_dt is None:
        ts0, frame0, _ = lit[0]
        return 0, ts0, frame0

    # Step 2: advance by the configured delay.
    target_dt = first_exposed_dt + timedelta(seconds=FRAME_SETTLE_DELAY_S)
    for i in range(first_exposed_idx, len(lit)):
        ts, frame, _b = lit[i]
        frame_dt = _parse_iso(ts)
        if frame_dt is not None and frame_dt >= target_dt:
            return i, ts, frame

    # Step 3: session is shorter than the delay — use the last available
    # lit frame rather than the still-overexposed first one.
    last_idx = len(lit) - 1
    ts_last, frame_last, _ = lit[last_idx]
    return last_idx, ts_last, frame_last


def _select_after_frame(
    lit: list[tuple[str, np.ndarray, float]],
    before_idx: int,
) -> tuple[int, str, np.ndarray]:
    """Pick the "after" frame for the session.

    Algorithm:
      1. Start from the last lit frame and step back ``FRAME_SETTLE_DELAY_S``
         so we don't catch the moment the door is already closing and AGC
         is reacting.
      2. If the session is too short for the settle delay (i.e. walking
         back lands at or before the "before" frame), fall back to the
         last lit frame — skipping the delay is better than returning a
         frame identical to before.

    ``lit`` is ``[(ts, frame, brightness), ...]`` in chronological order.
    ``before_idx`` is the index already picked by ``_select_before_frame``
    so we never return a frame at or before it.
    Returns ``(index, ts, frame)``.
    """
    last_idx = len(lit) - 1
    ts_last, _, _ = lit[last_idx]
    last_dt = _parse_iso(ts_last)
    if last_dt is None:
        # Bad ts format — degrade gracefully.
        return last_idx, ts_last, lit[last_idx][1]

    # Brightness-aware walk-back. The trailing frames of a session are
    # often dim because the door is mid-closing when _handle_close runs
    # (10-50ms delay) and AGC can also dip as the LIT_BRIGHTNESS_MIN
    # threshold is approached. Picking the nominally-last lit frame
    # lands us in that transition. Find the peak brightness across the
    # lit set, then walk back from the end until we hit a frame that's
    # at least 80% of peak — that's the last fully-lit scene.
    peak_brightness = max((b for _, _, b in lit), default=0.0)
    peak_cutoff = peak_brightness * 0.8
    chosen_idx = last_idx
    for i in range(last_idx, before_idx, -1):
        _ts_i, _frame_i, b_i = lit[i]
        if b_i >= peak_cutoff:
            chosen_idx = i
            break
    ts_chosen, _, _ = lit[chosen_idx]
    chosen_dt = _parse_iso(ts_chosen)
    anchor_dt = chosen_dt if chosen_dt is not None else last_dt

    # Then apply the settle delay relative to the chosen anchor (not
    # the nominally-last frame). This guarantees the pick is 2+ frames
    # back from whatever the door's "last fully-lit moment" was.
    target_dt = anchor_dt - timedelta(seconds=FRAME_SETTLE_DELAY_S)
    for i in range(chosen_idx, before_idx, -1):
        ts, frame, _b = lit[i]
        frame_dt = _parse_iso(ts)
        if frame_dt is not None and frame_dt <= target_dt:
            return i, ts, frame

    # Chosen frame itself is earlier than target (very short lit run).
    # Return chosen directly rather than a pre-before fallback.
    if chosen_idx > before_idx:
        ts, frame, _b = lit[chosen_idx]
        return chosen_idx, ts, frame

    # Session too short for the settle delay — use a frame STRICTLY after
    # before_idx so classifier never sees before == after.
    if before_idx + 1 < len(lit):
        i = before_idx + 1
        ts, frame, _ = lit[i]
        return i, ts, frame
    # Only 1 frame total — degenerate, log and return it.
    log.warning("session_capture: session too short for distinct before/after; "
                "using same frame for both")
    return last_idx, ts_last, lit[last_idx][1]


def _reconstruct_lit_from_ring(
    daemon: Any,
    session_dir: Path,
    open_dt: Optional[datetime],
    close_dt: Optional[datetime],
) -> list[tuple[str, str, float]]:
    """Fallback path: rebuild the session's lit-frame timeline from a
    ring snapshot and write JPEGs to disk.

    Only used when live archival didn't run — either because the daemon
    predates the on_frame hook (tests) or because `register()` couldn't
    subscribe. Mirrors the filter+pick+encode pipeline that used to live
    inline inside _handle_close, but returns the same
    ``[(ts, path, brightness), ...]`` shape as the live-archive branch
    so downstream code stays uniform.
    """
    try:
        snapshot = daemon.snapshot_ring()
    except Exception:
        log.exception("session_capture: snapshot_ring threw during fallback")
        return []
    close_bound_dt = (
        close_dt + timedelta(seconds=FRAME_CLOSE_TOLERANCE_S)
        if close_dt is not None
        else None
    )
    frames_dir = session_dir / "frames"
    try:
        frames_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        log.exception(
            "session_capture: failed to mkdir %s for ring fallback",
            frames_dir,
        )
        return []
    out: list[tuple[str, str, float]] = []
    for frame_ts, frame in snapshot:
        frame_dt = _parse_iso(frame_ts)
        if open_dt is not None and frame_dt is not None and frame_dt < open_dt:
            continue
        if close_bound_dt is not None and frame_dt is not None and frame_dt > close_bound_dt:
            continue
        try:
            b = compute_brightness(frame)
        except Exception:
            continue
        if b < LIT_BRIGHTNESS_MIN:
            continue
        f_path = frames_dir / f"{_safe_ts(frame_ts)}.jpg"
        if _encode_jpeg(frame, f_path):
            out.append((frame_ts, str(f_path.resolve()), float(b)))
    return out


def _cleanup_session_dir(session_dir: Path) -> None:
    """Remove an empty session directory. Silent on errors."""
    try:
        if session_dir.exists() and not any(session_dir.iterdir()):
            session_dir.rmdir()
    except OSError:
        pass


# ----------------------------------------------------------------- public

def register(
    daemon: CameraDaemon,
    sessions_root: str | Path,
    *,
    on_close_callback: Optional[Any] = None,
) -> None:
    """Subscribe the session-capture handler to the daemon.

    Frames land under ``<sessions_root>/<open_ts>/{before,after}.jpg`` and
    ``session.mp4``. Callbacks run on the daemon's brightness-watcher
    thread; encoding the video can take 1-2 seconds, which is acceptable
    because the watcher's cadence is only for open/close detection, not
    live frame capture.

    ``on_close_callback``, if provided, is invoked with the just-published
    session dict (copy) after each close. Use this to trigger post-close
    event processing in the scale-events pipeline. Exceptions from the
    callback are logged but do not break session capture.
    """
    root = Path(sessions_root)
    root.mkdir(parents=True, exist_ok=True)

    def _handle_open(ts_iso: str) -> None:
        global _CURRENT
        # Pre-create the frames directory so the on_frame callback can
        # write immediately without racing _handle_open to create it.
        session_dir = root / _safe_ts(ts_iso)
        frames_dir = session_dir / "frames"
        try:
            frames_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            log.exception(
                "session_capture: failed to create frames dir for open @ %s",
                ts_iso,
            )
        with _LOCK:
            if _CURRENT is not None:
                # Back-to-back open without a close — log and drop the
                # orphan so we don't leak its (empty) directory later.
                orphan_ts = _CURRENT.get("open_ts")
                log.warning(
                    "session_capture: orphan session at open_ts=%s dropped; "
                    "any pending scale_events referencing it will age out "
                    "via sweeper", orphan_ts,
                )
                log.warning(
                    "session_capture: open @ %s with existing open session "
                    "@ %s (dropping orphan)", ts_iso, orphan_ts,
                )
                if orphan_ts:
                    _cleanup_session_dir(root / _safe_ts(orphan_ts))
                    _lc(
                        orphan_ts,
                        actor="session_capture",
                        reason_code="session_orphan_dropped",
                        payload={"new_open_ts": ts_iso},
                    )
            if _CURRENT is None:
                pass  # (noop branch to keep diff surface small)
            _CURRENT = {
                "open_ts": ts_iso,
                "close_ts": None,
                "before_path": None,
                "after_path": None,
                "video_path": None,
                # Live-archive state: every lit frame captured while this
                # session is open is written to `frames_dir` by the
                # on-frame callback below. `lit_frames` accumulates the
                # (ts, path, brightness) tuples in chronological order.
                # We persist lit frames live instead of relying on a
                # ring-buffer snapshot at close, because the daemon's
                # ring is capped at 30s — long multi-item sessions used
                # to lose their opening frames, forcing every early
                # event to fall back to the session-wide after frame
                # (which uniformly showed whatever landed on the shelf
                # LAST, misattributing early-event weight deltas).
                "frames_dir": str(frames_dir.resolve()),
                "lit_frames": [],
                "frames_dropped": 0,
            }
        log.info("session_capture: session opened @ %s", ts_iso)
        _lc(
            ts_iso,
            actor="session_capture",
            reason_code="session_capture_opened",
            payload={"frames_dir": str(frames_dir.resolve())},
        )

    def _handle_frame(ts_iso: str, frame: np.ndarray) -> None:
        """Per-frame callback: live-archive lit frames to disk.

        Runs on the capture thread. Must be cheap (compute brightness +
        optional JPEG encode + append to list). No locks are held while
        writing the JPEG so concurrent readers of _CURRENT aren't
        blocked.
        """
        # Grab a consistent snapshot of the current-session state.
        with _LOCK:
            if _CURRENT is None:
                return
            frames_dir_str = _CURRENT.get("frames_dir")
            lit_frames_ref = _CURRENT.get("lit_frames")
            if frames_dir_str is None or lit_frames_ref is None:
                return
            if len(lit_frames_ref) >= LIVE_ARCHIVE_MAX_FRAMES:
                _CURRENT["frames_dropped"] = int(_CURRENT.get("frames_dropped", 0)) + 1
                return
        # Brightness gate: mirror _handle_close's LIT_BRIGHTNESS_MIN
        # filter so we only persist usable frames.
        try:
            b = compute_brightness(frame)
        except Exception:
            return
        if b < LIT_BRIGHTNESS_MIN:
            return
        # Write JPEG outside the lock.
        frames_dir = Path(frames_dir_str)
        out_path = frames_dir / f"{_safe_ts(ts_iso)}.jpg"
        if not _encode_jpeg(frame, out_path):
            return
        resolved = str(out_path.resolve())
        # Append under lock; recheck _CURRENT identity so a close+open
        # race doesn't accidentally merge frames into the next session.
        with _LOCK:
            if _CURRENT is None:
                # Session closed between brightness check and list append
                # — delete the now-orphaned JPEG and bail.
                try:
                    out_path.unlink()
                except OSError:
                    pass
                return
            if _CURRENT.get("frames_dir") != frames_dir_str:
                try:
                    out_path.unlink()
                except OSError:
                    pass
                return
            _CURRENT["lit_frames"].append((ts_iso, resolved, float(b)))
            # High-volume stream — only log when verbose AND every 100th frame
            # so the lifecycle table doesn't balloon. Count is a proxy — we
            # don't need millisecond precision on the timeline.
            if _LIFECYCLE_VERBOSE:
                count = len(_CURRENT["lit_frames"])
                if count % 100 == 0:
                    _lc(
                        _CURRENT.get("open_ts"),
                        actor="session_capture",
                        reason_code="frames_archive_tick",
                        payload={
                            "count": count,
                            "drop_count": int(_CURRENT.get("frames_dropped", 0)),
                        },
                    )

    def _handle_close(ts_iso: str) -> None:
        global _CURRENT
        # Swap _CURRENT out under the lock; everything after works on a
        # local reference so no concurrent reader can see partial state.
        with _LOCK:
            session = _CURRENT
            _CURRENT = None
        if session is None:
            log.warning("session_capture: close @ %s with no open session",
                        ts_iso)
            return

        open_ts = session["open_ts"]
        open_dt = _parse_iso(open_ts)
        close_dt = _parse_iso(ts_iso)
        session_dir = root / _safe_ts(open_ts)

        # Use live-archived lit frames (written to disk by
        # `_handle_frame` during the open session). This replaces the
        # previous ring-buffer snapshot path, which was silently bounded
        # by `CameraDaemon.config.ring_seconds` (default 30s) — sessions
        # longer than the ring would lose their opening minutes of
        # frames, making early-event `pick_event_frames` calls fall back
        # to `session.after_path` (the session-wide endpoint) and misattribute
        # weight deltas to whatever landed on the shelf last.
        #
        # Fallback for older tests / daemons without on_frame support:
        # if no live-archived lit frames were captured AND the daemon
        # still exposes snapshot_ring, reconstruct the old
        # ring-snapshot path so existing tests keep passing. New
        # production flow should always hit the live-archive branch.
        live_lit_raw = list(session.get("lit_frames") or [])
        if not live_lit_raw and hasattr(daemon, "snapshot_ring"):
            live_lit_raw = _reconstruct_lit_from_ring(
                daemon, session_dir, open_dt, close_dt,
            )
        live_lit: list[tuple[str, str, float]] = live_lit_raw
        close_bound_dt = (
            close_dt + timedelta(seconds=FRAME_CLOSE_TOLERANCE_S)
            if close_dt is not None
            else None
        )
        # Respect session window bounds: frames written before open_dt
        # or after close+tolerance shouldn't slip in (normally they
        # can't, because _handle_frame only appends while _CURRENT
        # exists, but belt-and-braces on clock jitter / race).
        filtered: list[tuple[str, str, float]] = []
        for f_ts, f_path, f_b in live_lit:
            f_dt = _parse_iso(f_ts)
            if open_dt is not None and f_dt is not None and f_dt < open_dt:
                continue
            if close_bound_dt is not None and f_dt is not None and f_dt > close_bound_dt:
                continue
            filtered.append((f_ts, f_path, f_b))
        live_lit = filtered

        dropped = int(session.get("frames_dropped", 0))
        if dropped:
            log.warning(
                "session_capture: session @ %s dropped %d frames over "
                "LIVE_ARCHIVE_MAX_FRAMES cap (%d); session was unusually "
                "long", open_ts, dropped, LIVE_ARCHIVE_MAX_FRAMES,
            )

        if not live_lit:
            log.warning("session_capture: close @ %s but no lit frames; "
                        "dropping session", ts_iso)
            _cleanup_session_dir(session_dir)
            return

        session_dir.mkdir(parents=True, exist_ok=True)

        # Re-load each lit frame from disk so the existing
        # _select_before_frame / _select_after_frame / video-encode
        # helpers can operate on ndarrays. This is a bit wasteful but
        # keeps the selection logic unchanged. The JPEGs were already
        # written by _handle_frame so this is decode-only.
        lit: list[tuple[str, np.ndarray, float]] = []
        for f_ts, f_path, f_b in live_lit:
            try:
                arr = np.fromfile(f_path, dtype=np.uint8)
                img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            except Exception:
                img = None
            if img is None:
                log.warning("session_capture: failed to reload %s", f_path)
                continue
            lit.append((f_ts, img, f_b))
        if not lit:
            log.warning("session_capture: close @ %s but no decodable lit "
                        "frames; dropping session", ts_iso)
            _cleanup_session_dir(session_dir)
            return

        # Before: first well-exposed frame + settle delay. After: last lit
        # frame minus settle delay. Both sides skip the AGC transient at
        # the ends of the session. Video: everything in `lit` that's not
        # overexposed (skip any residual burst).
        before_idx, before_ts, before_frame = _select_before_frame(lit)
        _after_idx, after_ts, after_frame = _select_after_frame(lit, before_idx)

        before_path = session_dir / "before.jpg"
        if not _encode_jpeg(before_frame, before_path):
            log.error("session_capture: failed to write before.jpg")
            _cleanup_session_dir(session_dir)
            return

        after_path = session_dir / "after.jpg"
        if not _encode_jpeg(after_frame, after_path):
            log.error("session_capture: failed to write after.jpg")
            # Before is on disk but no after — still unusable, clean up.
            try:
                before_path.unlink()
            except OSError:
                pass
            _cleanup_session_dir(session_dir)
            return

        # The per-frame JPEGs are already on disk under
        # session_dir/frames/ (written live by _handle_frame). Re-use
        # the `live_lit` list verbatim as the session's lit_frames
        # index, so pick_event_frames can map each event onto its own
        # before/after without the ring-size cap that used to strand
        # early events.
        lit_frames: list[tuple[str, str, float]] = list(live_lit)

        # Publish the session record to _CLOSED NOW — before the video
        # encode. Events waiting on this session (via
        # get_frames_for_event's polling loop) can match as soon as the
        # JPEGs are ready, which is within ~100ms of close. Video
        # encoding takes 1-2s and runs in a background thread; when it
        # finishes, we mutate the published record's video_path in place
        # (still under _LOCK, so readers re-fetching see the update).
        closed = {
            "open_ts": open_ts,
            "close_ts": ts_iso,
            "before_path": str(before_path.resolve()),
            "after_path": str(after_path.resolve()),
            "video_path": None,  # filled in by the background thread
            "before_ts": before_ts,
            "after_ts": after_ts,
            # lit_frames is a sorted [(ts_iso, jpg_path), ...] list covering
            # the full session. Used by pick_event_frames() to give each
            # event its own before/after based on its Pi-received ts.
            "lit_frames": lit_frames,
        }
        with _LOCK:
            _CLOSED.append(closed)
        log.info(
            "session_capture: closed session %s → %s (before_ts=%s, "
            "after_ts=%s) — encoding video in background",
            open_ts, ts_iso, before_ts, after_ts,
        )
        _lc(
            open_ts,
            actor="session_capture",
            reason_code="session_capture_closed",
            payload={
                "close_ts": ts_iso,
                "lit_frame_count": len(lit_frames),
                "before_ts": before_ts,
                "after_ts": after_ts,
            },
        )

        # Fire the on-close callback (e.g. classify any pending events
        # whose timestamp falls in this session's window). We pass a copy
        # so the callback can't mutate our internal record. Exceptions
        # are logged but never propagate — we don't want a bad callback
        # to break session capture.
        if on_close_callback is not None:
            try:
                on_close_callback(dict(closed))
            except Exception:
                log.exception(
                    "session_capture: on_close_callback raised for session %s",
                    open_ts,
                )

        # Video frames: skip leading overexposed frames so the video
        # matches the before-frame's viewing conditions.
        video_frames = [f for _, f, b in lit[before_idx:]
                        if b < OVEREXPOSED_THRESHOLD]
        lit = None  # let the rest of the list + its numpy frames GC

        def _encode_video_async(
            frames: list[np.ndarray],
            target_file: Path,
            session_open_ts: str,
        ) -> None:
            if not frames:
                return
            ok = _encode_video(frames, target_file)
            if ok:
                with _LOCK:
                    # Look up the session by its immutable open_ts key.
                    # If the session was evicted from _CLOSED while we
                    # encoded (10+ sessions closed during encode), there
                    # is no dict to mutate — log and drop the update.
                    target = None
                    for sess in _CLOSED:
                        if sess.get("open_ts") == session_open_ts:
                            target = sess
                            break
                    if target is not None:
                        target["video_path"] = str(target_file.resolve())
                    else:
                        log.warning(
                            "session_capture: encoder for open_ts=%s found "
                            "no matching session in _CLOSED (evicted?); "
                            "dropping update", session_open_ts,
                        )
                log.info("session_capture: video saved (%d frames) -> %s",
                         len(frames), target_file.name)
                _lc(
                    session_open_ts,
                    actor="session_capture",
                    reason_code="video_encoded",
                    payload={
                        "path": str(target_file.resolve()),
                        "frame_count": len(frames),
                    },
                )
            else:
                log.warning("session_capture: video encode failed for %s",
                            target_file.name)
                _lc(
                    session_open_ts,
                    actor="session_capture",
                    reason_code="video_encode_failed",
                    payload={"path": str(target_file)},
                )

        if video_frames:
            t = threading.Thread(
                target=_encode_video_async,
                args=(video_frames, session_dir / "session.mp4", open_ts),
                name=f"video-encode-{_safe_ts(open_ts)}",
                daemon=True,
            )
            t.start()

    def handle(transition: BrightnessTransition) -> None:
        if transition.kind == "open":
            _handle_open(transition.ts_iso)
        elif transition.kind == "close":
            _handle_close(transition.ts_iso)

    daemon.on_brightness_transition(handle)
    # Live-archive every captured frame while a session is open. The
    # callback itself gates on `_CURRENT is not None` so pre-open and
    # post-close frames are ignored without a separate subscribe/
    # unsubscribe dance.
    if hasattr(daemon, "on_frame"):
        daemon.on_frame(_handle_frame)
    else:
        # Older daemon shim (tests with fakes that predate on_frame).
        # Log once so the operator knows live-archive is inactive — the
        # session will still work via the old ring-snapshot path IF the
        # daemon still has snapshot_ring, but long sessions will lose
        # their opening frames as before.
        log.warning(
            "session_capture: daemon does not expose on_frame; live "
            "session archive disabled (long sessions may lose opening "
            "frames, causing early events to fall back to the "
            "session-wide after frame)",
        )


def get_frames_for_event(
    event_pi_ts: str,
    *,
    wait_for_close_s: float = 15.0,
    wait_for_video_s: float = 4.0,
    post_close_grace_s: float = POST_CLOSE_GRACE_S,
) -> tuple[Optional[dict], bool]:
    """Find the session record that contains ``event_pi_ts``.

    Correlation is by timestamp: the session must satisfy
    ``open_ts ≤ event_pi_ts ≤ close_ts + post_close_grace_s``. If a session
    is currently open and the event falls inside its open-to-now window,
    the call blocks up to ``wait_for_close_s`` for the close to complete.

    Returns ``(session_dict_or_None, matched)``. ``matched`` is True iff
    a session actually contains the event; False means either no session
    matched (drop the event visually) or the caller timed out waiting.
    Callers should NOT fall back to "most recent session" on mismatch —
    that was the old bug.

    The returned dict is a copy, safe to read without further locking.
    Keys: ``open_ts``, ``close_ts``, ``before_path``, ``after_path``,
    ``video_path``, ``before_ts``, ``after_ts``.
    """
    event_dt = _parse_iso(event_pi_ts)
    if event_dt is None:
        log.warning("session_capture: get_frames_for_event got unparseable "
                    "ts=%s", event_pi_ts)
        return None, False

    def _scan_closed() -> Optional[dict]:
        # Walk newest-first so back-to-back sessions disambiguate toward
        # the more recent match.
        for sess in reversed(_CLOSED):
            open_dt = _parse_iso(sess["open_ts"])
            close_dt = _parse_iso(sess["close_ts"])
            if open_dt is None or close_dt is None:
                continue
            grace_end = close_dt + timedelta(seconds=post_close_grace_s)
            if open_dt <= event_dt <= grace_end:
                return dict(sess)
        return None

    deadline = time.monotonic() + wait_for_close_s
    while True:
        with _LOCK:
            # Priority: if a session is currently open AND the event
            # falls inside its open-to-now window, the event belongs to
            # THAT session — even if a previous session's grace window
            # also covers event_dt. This handles the common case of an
            # event arriving during a new session while an old session's
            # 30s grace is still technically open. Without this check,
            # _scan_closed can match the old session first and attach
            # frames from the wrong physical interaction (observed: a
            # REMOVE session's video + frames attached to an ADD event
            # that happened ~30s later in a separate session).
            current_open_ts = _CURRENT["open_ts"] if _CURRENT else None
            current_contains_event = False
            if current_open_ts is not None:
                cur_open_dt = _parse_iso(current_open_ts)
                if cur_open_dt is not None and event_dt >= cur_open_dt:
                    current_contains_event = True

            # Only scan closed sessions when the event is NOT inside the
            # currently-open session. This leaves closed-grace matching
            # available for events that fire after close but before the
            # next open (ESP stability lag), while making sure newer
            # sessions reclaim events that physically happened during
            # them.
            match = None if current_contains_event else _scan_closed()
            if match is not None:
                break  # matched — fall through to video wait

        # No closed match. If the current session contains the event,
        # optionally wait for it to close; otherwise bail immediately.
        if current_contains_event:
            if time.monotonic() < deadline:
                time.sleep(0.1)
                continue
        return None, False

    # We have a matched session but its video may still be encoding in
    # the background. Poll briefly for video_path to be filled in so the
    # event's copy step can attach the MP4. This only affects events
    # that fire right around close time — events that arrive after the
    # encoder already finished see video_path immediately.
    video_deadline = time.monotonic() + wait_for_video_s
    while match.get("video_path") is None and time.monotonic() < video_deadline:
        time.sleep(0.1)
        with _LOCK:
            # The encoder thread mutates the ORIGINAL dict in _CLOSED, not
            # the copy returned by the first scan — so we have to re-scan
            # under the lock and rebind `match` to the fresh copy. Without
            # this, the outer `while` keeps checking the stale copy's
            # video_path (always None) and burns the full poll budget.
            refreshed = _scan_closed()
            if refreshed is not None:
                match = refreshed
                if match.get("video_path") is not None:
                    break
    return match, True


def pick_event_frames(
    session: dict,
    event_pi_ts: str,
    prior_event_pi_ts: Optional[str] = None,
) -> tuple[Optional[str], Optional[str], Optional[str], Optional[str]]:
    """Select per-event before/after frames within a session.

    Invariants enforced by this picker:

        1. Session-boundary guard (B2):
           ``session.open_ts + SESSION_BOUNDARY_GUARD_S <= frame.ts
           <= event_N.scale_ts``. Frames earlier than the session open
           are NEVER returned — this prevents a cross-session leak
           where a new session whose live ``lit_frames`` is still short
           could otherwise inherit a frame from a prior (already
           closed) session via the back-compat walk.

        2. Chain requirement (B1):
           ``event_N.before_frame.ts >= prior_event_{N-1}.scale_ts -
           EVENT_AFTER_LOOKBACK_S``. Event N's "before" is the prior
           event's "after", so the two views form a visual diff of
           JUST this event's change.

        3. Forward-progress gap (B1):
           For rapid back-to-back events (~3-4s apart), the naive
           ``event_N - EVENT_AFTER_LOOKBACK_S`` "after" anchor can land
           BEFORE the prior event's stability ts — which means both
           event N-1's after and event N's after would resolve to the
           same frame (or worse, the prior event's "before"). Clamp
           event N's "after" target to be at least ``MIN_AFTER_CHAIN_GAP_S``
           after the prior event's stability ts.

    Sessions that contain multiple ESP stability events (user adds/removes
    several items in one door-open period) need each event to see its own
    physical change, not the session-wide boundaries. This function maps
    a specific event's timestamp onto the session's persisted lit-frame
    timeline:

        - ``after``  = frame at ``event_pi_ts - EVENT_AFTER_LOOKBACK_S``.
          The ESP declares stability only after ~1s of scale samples
          within tolerance, so a frame 1s before the stability ts
          corresponds to the BEGINNING of the stable period — the
          earliest moment this event's physical placement/removal had
          completed. Picking deeper into the stable window risks
          catching the user's hand reaching in with the NEXT item
          (observed: event 1's "after" showed item 2 being placed).
        - ``before`` = frame at ``prior_event_pi_ts - EVENT_AFTER_LOOKBACK_S``
          when a prior event exists in this session — same rationale as
          ``after``, applied to the prior event's "settled" moment so
          the two views form a visual diff of THIS event's change.
          Else session-open + FRAME_SETTLE_DELAY_S (the AGC settle).

    Returns ``(before_ts, before_path, after_ts, after_path)``. Any
    field may be ``None`` if the session has no retained frame timeline
    or the requested point is outside the covered range — callers fall
    back to ``session["before_path"]`` / ``session["after_path"]``.
    """
    lit_frames_raw = session.get("lit_frames") or []
    if not lit_frames_raw:
        return None, None, None, None

    # Back-compat: old records stored (ts, path) 2-tuples before the
    # brightness field was added. Normalize to (ts, path, brightness)
    # with a sentinel brightness so the peak-cutoff logic degrades
    # gracefully into "any frame qualifies".
    lit_frames: list[tuple[str, str, float]] = []
    for entry in lit_frames_raw:
        if len(entry) >= 3:
            lit_frames.append((entry[0], entry[1], float(entry[2])))
        else:
            lit_frames.append((entry[0], entry[1], 255.0))

    event_dt = _parse_iso(event_pi_ts)
    if event_dt is None:
        return None, None, None, None

    # Session-boundary guard (B2). If open_ts parses, any frame earlier
    # than ``open_ts + SESSION_BOUNDARY_GUARD_S`` is disqualified —
    # prevents a new session from inheriting retained frames of the
    # prior session. If open_ts is missing / unparseable, fall back to
    # ``None`` so the guard is a no-op (matches prior behavior rather
    # than dropping every frame).
    open_dt = _parse_iso(session.get("open_ts") or "")
    session_floor_dt: Optional[datetime] = None
    if open_dt is not None:
        session_floor_dt = open_dt + timedelta(seconds=SESSION_BOUNDARY_GUARD_S)

    # Brightness cutoff: only pick frames that are at least 80% of the
    # session's peak brightness. The trailing frames of a session are
    # often dim because the door is mid-closing, and AGC dips as the
    # scene darkens. Without this filter the "after" for a post-close
    # event can land on a nearly-black frame (observed).
    peak = max((b for _, _, b in lit_frames), default=255.0)
    peak_cutoff = peak * 0.8

    def _in_session(f_dt: datetime) -> bool:
        """Session-boundary filter (B2): frame must not precede open."""
        if session_floor_dt is None:
            return True
        return f_dt >= session_floor_dt

    def _pick_before_target(
        target_dt: datetime,
        floor_dt: Optional[datetime] = None,
    ) -> tuple[Optional[str], Optional[str]]:
        """Last frame at-or-before ``target_dt`` that meets the brightness
        cutoff, the session-boundary guard, AND (if provided) the
        ``floor_dt`` lower bound.

        The ``floor_dt`` parameter exists for the B1 chain invariant:
        when a prior event's stability ts is close to ``target_dt`` (or
        past it after clamping), the caller can pass ``chain_floor``
        here to guarantee the picked frame doesn't precede it.
        """
        chosen: tuple[Optional[str], Optional[str]] = (None, None)
        for ts_iso, path, b in lit_frames:
            f_dt = _parse_iso(ts_iso)
            if f_dt is None:
                continue
            if not _in_session(f_dt):
                # Skip frames earlier than session open — prevents
                # cross-session leak through retained lit_frames.
                continue
            if floor_dt is not None and f_dt < floor_dt:
                continue
            if f_dt > target_dt:
                break
            if b >= peak_cutoff:
                chosen = (ts_iso, path)
        # If no frame landed in [floor_dt, target_dt], fall back to the
        # first frame at-or-after ``floor_dt`` (still bounded by
        # ``event_dt`` via the outer clamp). This gives the chain
        # invariant priority over the "at-or-before target" shape when
        # the two conflict (sparse frames near the event).
        if chosen[1] is None and floor_dt is not None:
            chosen = _pick_after_target(floor_dt)
        return chosen

    def _pick_after_target(target_dt: datetime) -> tuple[Optional[str], Optional[str]]:
        """First frame at-or-after target_dt that meets the brightness cutoff
        AND the session-boundary guard."""
        for ts_iso, path, b in lit_frames:
            f_dt = _parse_iso(ts_iso)
            if f_dt is None:
                continue
            if not _in_session(f_dt):
                continue
            if f_dt >= target_dt and b >= peak_cutoff:
                return ts_iso, path
        return None, None

    # After: pick at event_pi_ts - EVENT_AFTER_LOOKBACK_S so we land at
    # the START of the stable window (earliest moment this event's
    # placement had completed, before any subsequent user activity).
    after_target = event_dt - timedelta(seconds=EVENT_AFTER_LOOKBACK_S)

    # Chain requirement (B1): if a prior event exists, clamp after_target
    # forward so it's never earlier than the prior event's stability ts
    # plus MIN_AFTER_CHAIN_GAP_S. Without this, rapid events (~3-4s
    # apart) can share an "after" frame with their predecessor, leaving
    # every event after the first with an incorrect (stale) view.
    prior_dt: Optional[datetime] = None
    if prior_event_pi_ts:
        prior_dt = _parse_iso(prior_event_pi_ts)
    chain_floor: Optional[datetime] = None
    if prior_dt is not None:
        chain_floor = prior_dt + timedelta(seconds=MIN_AFTER_CHAIN_GAP_S)
        if after_target < chain_floor:
            after_target = chain_floor
    # Also clamp to the event's own ts — "after" must never be later
    # than the stability ts itself (frames past event_dt reflect
    # activity that happened AFTER this event settled).
    if after_target > event_dt:
        after_target = event_dt
    # Finally clamp to session floor — never return a pre-open frame.
    if session_floor_dt is not None and after_target < session_floor_dt:
        after_target = session_floor_dt
    # Pass chain_floor through so the picker can enforce the B1
    # invariant even when frames are sparse between the prior event
    # and this event (picks the frame JUST AFTER the floor in that case).
    after_ts, after_path = _pick_before_target(after_target, floor_dt=chain_floor)

    # Before: prior event's settled state (their "after"), else session
    # open + settle delay. Use the same lookback as after so the before
    # frame for event N+1 equals the after frame for event N (chained
    # frames — each event's before is the prior event's after).
    if prior_dt is not None:
        before_target = prior_dt - timedelta(seconds=EVENT_AFTER_LOOKBACK_S)
        # Session-boundary clamp: never rewind past session open.
        if session_floor_dt is not None and before_target < session_floor_dt:
            before_target = session_floor_dt
        # Chain floor (mirrors the B1 clamp on ``after_target`` above):
        # for TIGHT chains (events closer than 2 * EVENT_AFTER_LOOKBACK_S),
        # the naive ``prior_dt - lookback`` walk-back lands BEFORE
        # prior_dt itself — meaning event N's "before" would show a
        # state that INCLUDES items the prior event already removed,
        # and the classifier sees both events' combined diff as if it
        # were just event N's. Observed 2026-04-16: slow 3-item lift
        # triggered event 1, then a cream-cheese lift triggered event
        # 2 only 0.96s later on the scale's stabilization timeline; the
        # picker walked back for event 2's "before" by 1.0s, landing at
        # a frame where all 4 items were still present.
        #
        # For non-chained events the old semantic holds: event N's
        # "before" = prior event's "after" (at prior_dt - lookback). For
        # tight chains we fall forward to the first frame at-or-after
        # ``prior_dt + MIN_AFTER_CHAIN_GAP_S`` — the earliest frame
        # captured after the prior event's stability ts, which is as
        # close to "just event N's change" as the timeline allows.
        chain_before_floor = prior_dt + timedelta(seconds=MIN_AFTER_CHAIN_GAP_S)
        if before_target < chain_before_floor:
            before_ts, before_path = _pick_after_target(chain_before_floor)
        else:
            before_ts, before_path = _pick_before_target(before_target)
        if before_path is not None:
            return before_ts, before_path, after_ts, after_path

    # No usable prior event — session open + settle delay, first
    # fully-lit frame.
    if open_dt is not None:
        open_target = open_dt + timedelta(seconds=FRAME_SETTLE_DELAY_S)
        # open_target is definitionally >= session_floor_dt
        # (FRAME_SETTLE_DELAY_S >= SESSION_BOUNDARY_GUARD_S by design),
        # but _pick_after_target applies the guard defensively anyway.
        before_ts, before_path = _pick_after_target(open_target)
        if before_path is not None:
            return before_ts, before_path, after_ts, after_path

    # Last resort: first lit frame that meets the cutoff AND the
    # session-boundary guard, else first in-session frame.
    for ts_iso, path, b in lit_frames:
        f_dt = _parse_iso(ts_iso)
        if f_dt is None or not _in_session(f_dt):
            continue
        if b >= peak_cutoff:
            return ts_iso, path, after_ts, after_path
    for ts_iso, path, _b in lit_frames:
        f_dt = _parse_iso(ts_iso)
        if f_dt is None or not _in_session(f_dt):
            continue
        return ts_iso, path, after_ts, after_path
    # Every retained frame is outside the session window (shouldn't
    # happen — _handle_close filters these out — but tests using
    # hand-built session dicts can hit it). Return None rather than
    # leak a foreign frame.
    return None, None, after_ts, after_path


def get_last_closed_session() -> Optional[dict]:
    """Return a snapshot of the most recently closed session, or None.

    Used by the diagnostic dump endpoint for a live peek at what the
    event handler would see. Kept for backward compatibility; event
    handlers should use :func:`get_frames_for_event` instead.
    """
    with _LOCK:
        return dict(_CLOSED[-1]) if _CLOSED else None


def reset() -> None:
    """Clear all in-memory session state.

    Called by the admin wipe path so the ``_CURRENT`` / ``_CLOSED`` deque
    don't hold references to sessions whose JPEGs and MP4 have just been
    deleted from disk. Safe to call any time — it just drops any open
    session record and empties the closed-session ring buffer.
    """
    global _CURRENT
    with _LOCK:
        _CURRENT = None
        _CLOSED.clear()


# Backward-compatible alias for existing test imports. New call sites
# should prefer :func:`reset`.
_reset_for_tests = reset
