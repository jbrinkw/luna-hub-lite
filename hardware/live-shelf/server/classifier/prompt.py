"""Prompt assembly for the classifier.

Implements §7.1 of hardware/live-shelf/docs/plan.md. Produces an
Anthropic messages-API payload (system + user-content blocks) arranged so
the cache-stable prefix precedes the per-event fresh content:

    [CACHED PREFIX]
      system prompt →
      weight/direction text →
      candidate JSON + reference images   <-- cache_control breakpoint

    [FRESH PER-EVENT]
      before image →
      after image →
      instruction

The candidate metadata + reference images stay warm across every event
in a session (same shelf inventory), while the before/after frames and
instruction rotate per event. Previously the frames came first, which
busted the cache every call because the cached prefix still included
the fresh per-event bytes.
"""

from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any, Literal, Optional

from .models import Candidate, ScaleEvent

logger = logging.getLogger(__name__)

# Anthropic images API caps base64-encoded images at ~5 MiB per block. We
# downscale anything larger to avoid a 400 from the API. 5 * 1024 * 1024
# expressed as the raw-bytes threshold — base64 adds ~33% overhead, so we
# target the raw-bytes ceiling that still fits comfortably after encoding.
MAX_IMAGE_BYTES = 5 * 1024 * 1024

# Anthropic's vision docs recommend ≤1568px on the longest edge for best
# quality/latency tradeoff. We use it as the downscale target.
MAX_IMAGE_DIMENSION = 1568

SYSTEM_PROMPT = """\
You are identifying items that moved onto or off of a single shelf based on
before/after images and a weight change. You will be given a ranked list of
candidate items. Pick the single best matching candidate (or "unknown"), plus
an action and a confidence value.

IMPORTANT — how to read the images:
The before and after images span an entire SESSION window (from when the user
opened the door/drawer to when they closed it), not just the single event you
are classifying. Multiple items may have changed between the two frames — the
user may have removed one item and added a different one, rearranged things,
or swapped items around. You are being asked about ONE specific event inside
that session, identified by its weight delta (sign + magnitude).

EVIDENCE MODEL — two sources, both first-class:
You have two independent sources of evidence and should expect them to
converge on the same answer:
  - VISUAL EVIDENCE: what appeared / disappeared / moved between the frames.
  - WEIGHT EVIDENCE: the signed delta_g and the expected_weight_g of each
    candidate. A subset of candidates whose weights sum to |delta| within a
    few percent is strong arithmetic evidence of exactly which item(s)
    changed. Catalog weights are ground truth and are cheap to check.
When both sources agree, commit with high confidence. When one source is
noisy (cluttered scene, partial occlusion, items behind items, dim lighting)
a clean signal from the other source is enough to commit — do NOT downgrade
to "unknown" just because part of the scene is hard to read. The answer may
still be fully determined by the other evidence source.

DIRECTION SEMANTICS:
  - ADD (positive delta): identify the single item that APPEARS in the AFTER
    frame but is NOT in the BEFORE frame, with a mass matching the delta.
  - REMOVE (negative delta): identify every item present in the BEFORE frame
    but missing from the AFTER frame, whose masses sum to the magnitude of
    the delta. Multi-item REMOVEs are common — populate "multi_match" with
    every candidate that left and set "item_id" to the HIGHEST-WEIGHT member
    of that set. A populated multi_match must NEVER be paired with
    item_id = "unknown"; item_id names the primary/largest removed item.

IN_FLIGHT CANDIDATES (ADD events):
A candidate with why_candidate="in_flight" is a specific lot the user just
picked UP from the shelf and is expected to put back — possibly partially
consumed. Its expected_weight_g is what the container weighed when it LEFT
the shelf (the pickup weight), NOT the catalog / full weight. For an ADD
event on a shelf that has an in_flight candidate:

  - If the added mass is LESS THAN OR EQUAL TO the in_flight candidate's
    expected_weight_g (within ~15% tolerance), this is almost certainly
    the SAME lot coming back — the user drank, ate, or otherwise consumed
    some of it. PREFER this candidate with action="added". Do NOT pick a
    catalog candidate of the same product just because its "full" weight
    is closer to the delta — a partially consumed returning bottle is
    the DEFAULT interpretation, not an edge case.
  - If the added mass is SIGNIFICANTLY HEAVIER than the in_flight
    expected_weight_g (ratio > 1.15), the user has likely put something
    different in the slot. Only then prefer a catalog candidate.
  - Return action="added" even for a returning in-flight lot — the
    handler recognises the lot id and computes consumption automatically.

WHEN TO USE "unknown":
Only when the evidence genuinely does not converge on any answer — no subset
of candidates fits the weight delta AND no interpretable visual change is
available. Do not use "unknown" as a safety valve for partial occlusion,
minor visual ambiguity, or uncertainty about which exact candidate instance
(when there are duplicate SKUs) — if the weight arithmetic pins down the
set, commit.

Valid actions:
  - "removed": the item left the shelf
  - "added": the item was newly placed on the shelf
  - "added_to_existing": contents were added to an item already on the shelf (topped up)
  - "unknown": cannot determine confidently

Respond with STRICT JSON matching this schema:
{
  "item_id": string,          // candidate_id or "UNKNOWN"
  "action": string,           // one of the valid actions above
  "confidence": number,       // 0.0 to 1.0
  "reasoning": string,        // one or two sentences
  "multi_match": [            // only for REMOVE events with multi-item pickups
    {"candidate_id": string, "confidence": number}
  ]
}

Do not include any text outside the JSON object."""


CATCH_ALL_SYSTEM_PROMPT = """\
You are identifying ONE item that was just placed on a countertop scale.
You will be given a SINGLE image of the scale (taken at the moment the
ESP declared the weight stable) plus a measured weight in grams. You
will also be given a ranked list of candidate items (recently-tracked
lots + items in the user's inventory). Pick the single best matching
candidate, OR pick "unknown" when no candidate visibly matches.

IMPORTANT — how to read the input:
This is NOT a delta event. There is no "before" frame and no "after"
frame. The image shows the scale RIGHT NOW with whatever item was just
placed on it. The measured weight is the absolute reading on the scale,
not a difference between two states. Catch-all events are
single-moment captures — one item, one weight, one image.

EVIDENCE MODEL — visual is primary, weight is supporting:
  - VISUAL EVIDENCE: what item is visible on the scale in the image.
    The countertop scale is small and the camera is mounted close, so
    a single item should fill most of the frame. Identify it by
    appearance: shape, color, label/branding, container type.
  - WEIGHT EVIDENCE: the measured_weight_g is the scale reading. Use
    it as a sanity check on your visual identification — if the visual
    says "milk gallon" but the weight is 50g, something is wrong.
    Each candidate carries an ``expected_weight_g`` that may be the
    catalog full weight OR the lot's last-known weight. Catch-all
    items vary in fill level (a partially-consumed bottle of soda
    weighs less than a full one), so a 30-50% mismatch with catalog
    weight is NORMAL and should not be a reason to downgrade to
    unknown. Wide tolerance on weight; commit on visual.

WHEN TO USE "unknown":
  - The image is empty / shows only the scale surface (no item placed).
  - The item visible is not in the candidate list (e.g. a brand-new
    SKU the user hasn't intaked yet).
  - The image is too dark, blurry, or occluded to identify the item.
Do NOT use "unknown" just because the weight doesn't perfectly match
a candidate's catalog weight — partial fills are common and the visual
identification is what matters.

Valid actions:
  - "added": the item was placed on the scale (this is the normal case
    for catch-all events with a positive weight delta).
  - "removed": the item was taken off the scale (catch-all REMOVE
    events are rare — usually the user picks the bottle up to put it
    away after measuring).
  - "unknown": cannot identify the item visible (or no item visible).

Respond with STRICT JSON matching this schema:
{
  "item_id": string,          // candidate_id or "UNKNOWN"
  "action": string,           // "added", "removed", or "unknown"
  "confidence": number,       // 0.0 to 1.0
  "reasoning": string         // one or two sentences naming what you see
}

Do not include any text outside the JSON object. multi_match and
secondary_candidates are NOT used for catch-all events."""


CATCH_ALL_INSTRUCTION_TEXT = (
    "Look at the single image of the countertop scale. Identify the "
    "ONE item visible on the scale, matching it to the closest entry "
    "in the candidate list. Use the measured weight as a sanity check, "
    "not as a primary discriminator — countertop items are often "
    "partially consumed and can weigh significantly less than their "
    "catalog full weight. "
    ""
    "If the image is empty (just the scale surface), shows an item "
    "that does NOT appear in the candidate list, or is too dark/blurry "
    "to identify, return item_id=\"UNKNOWN\" with action=\"unknown\". "
    ""
    "For a normal catch-all placement event, return action=\"added\". "
    "For the rare case of a removal, return action=\"removed\". "
    ""
    "Return ONLY the JSON object — no markdown, no prose, no code "
    "fences. Do NOT include multi_match or secondary_candidates — "
    "catch-all events identify exactly one item."
)


INSTRUCTION_TEXT = (
    "Compare the before and after frames side by side. For an ADD event, "
    "identify the item that APPEARS in the after frame but is NOT in the "
    "before frame. For a REMOVE event, identify every item present in the "
    "before frame but missing from the after frame. "
    ""
    "Cross-check your visual reading against weight arithmetic. The picked "
    "item (or the set of picked items for multi_match) should have catalog "
    "weights summing to |delta_g| within ~10% tolerance. If the visual "
    "reading and the weight math disagree, prefer the answer that a subset "
    "of the candidate list cleanly accounts for — catalog weights are "
    "ground truth. Convergent visual + weight evidence should give high "
    "confidence; a clean signal from either source alone (when the other "
    "is noisy from occlusion, clutter, or dim lighting) is still enough "
    "to commit. "
    ""
    "Do NOT pick a candidate just because its catalog weight matches the "
    "delta if that candidate is visibly present in BOTH frames — that item "
    "was not involved in this event. Do not pick an item that is absent "
    "from both frames. "
    ""
    "For ADD events, if any candidate has why_candidate=\"in_flight\", the "
    "user just lifted that specific lot and its expected_weight_g is the "
    "pickup weight. If the placed mass is <= that pickup weight (within "
    "~15%), pick the in_flight candidate with action=\"added\" — this is "
    "the same item returning, possibly partially consumed. Do NOT pick a "
    "catalog candidate of the same SKU in this case. "
    ""
    "For REMOVE events that account for more than one candidate, populate "
    "\"multi_match\" with every candidate that left. Set \"item_id\" to "
    "the highest-weight member of multi_match. A non-empty multi_match "
    "must NEVER be paired with item_id = \"unknown\". "
    ""
    "Return \"unknown\" only when the evidence genuinely does not converge "
    "on any answer — no subset of candidates fits the weight delta AND no "
    "interpretable visual change is available. Do not use \"unknown\" as "
    "a safety valve for partial occlusion or minor ambiguity when the "
    "rest of the evidence is clean. "
    ""
    "Return ONLY the JSON object — no markdown, no prose, no code fences."
)


# --- Image loading ---------------------------------------------------------


def _guess_media_type(path: str) -> str:
    """Best-effort media-type detection. Falls back to image/jpeg."""

    guess, _ = mimetypes.guess_type(path)
    if guess and guess.startswith("image/"):
        return guess
    # Frames are usually JPEG from the camera daemon; default to jpeg.
    return "image/jpeg"


def _downscale_jpeg(data: bytes, max_dim: int = MAX_IMAGE_DIMENSION) -> bytes:
    """Downscale ``data`` so the longest edge is <= ``max_dim``.

    Uses cv2 (already a project dependency for the camera daemon). Returns
    the re-encoded JPEG bytes. Falls back to the original bytes if cv2 is
    somehow unavailable or decoding fails — the caller's size check will
    still apply if we couldn't shrink it.
    """

    try:
        import cv2  # type: ignore[import-untyped]
        import numpy as np  # type: ignore[import-untyped]
    except ImportError:  # pragma: no cover - defensive
        logger.warning("cv2/numpy unavailable; cannot downscale image")
        return data

    try:
        arr = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img is None:
            logger.warning("cv2 failed to decode image for downscale")
            return data
        h, w = img.shape[:2]
        longest = max(h, w)
        if longest <= max_dim:
            return data
        scale = max_dim / float(longest)
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
        # JPEG quality 85 — perceptually near-lossless, ~10x smaller than 100.
        ok, buf = cv2.imencode(".jpg", resized, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            logger.warning("cv2 failed to re-encode downscaled image")
            return data
        return bytes(buf.tobytes())
    except Exception:  # pragma: no cover - defensive
        logger.exception("downscale failed; sending original image")
        return data


def _encode_image_block(path: str | os.PathLike[str]) -> dict[str, Any]:
    """Read ``path`` and return an Anthropic image content block.

    Uses base64 source — the alternative "url" source isn't appropriate
    because these frames live on the Pi's filesystem.

    Raises ``FileNotFoundError`` if the path doesn't exist, and
    ``ValueError`` if the file is empty. If the file exceeds
    ``MAX_IMAGE_BYTES`` we downscale via cv2 to keep the request within
    the Anthropic images-API per-block limit.
    """

    p = Path(path)
    try:
        data = p.read_bytes()
    except FileNotFoundError:
        raise
    except OSError as exc:
        # Turn low-level IO errors into something the caller can log +
        # handle (scale_events.py marks the event failed on exception).
        raise OSError(f"failed to read image {p}: {exc}") from exc

    if not data:
        raise ValueError(f"image file is empty: {p}")

    if len(data) > MAX_IMAGE_BYTES:
        logger.warning(
            "image %s is %d bytes (> %d); downscaling to max dim %dpx",
            p.name,
            len(data),
            MAX_IMAGE_BYTES,
            MAX_IMAGE_DIMENSION,
        )
        data = _downscale_jpeg(data, MAX_IMAGE_DIMENSION)
        if len(data) > MAX_IMAGE_BYTES:
            # Even after downscale we're still over — log but send anyway;
            # the API will reject with a clear error and the event will be
            # marked failed upstream.
            logger.warning(
                "image %s still %d bytes after downscale; sending anyway",
                p.name,
                len(data),
            )

    encoded = base64.standard_b64encode(data).decode("ascii")
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": _guess_media_type(str(p)),
            "data": encoded,
        },
    }


def _weight_text(
    delta_g: float,
    direction: str,
    candidates: Optional[list[Candidate]] = None,
) -> str:
    """Human-readable weight context for the classifier.

    Includes:
      - The scale delta + direction summary
      - A bullet list of each candidate's expected weight (salient vs
        buried in the candidate JSON block)
      - For REMOVE events with |delta| > largest single candidate, hint
        that this is likely a multi-item removal and show the combined
        weight the classifier should try to match
    """

    if delta_g > 0:
        summary = "shelf gained"
    elif delta_g < 0:
        summary = "shelf dropped"
    else:
        summary = "no net change"

    lines = [
        f"Weight change: {delta_g:+.1f} g ({summary})",
        f"Event direction: {direction}",
    ]

    if candidates:
        # Reference candidates by positional index (#1, #2, ...) rather
        # than name/id — names can be attacker-controlled via product
        # registration and would become a prompt-injection surface if
        # interpolated into text blocks. The full name + weight + id
        # still appear in the structured candidate JSON immediately
        # below, so the model has everything it needs to match "#2" to
        # "Philadelphia Cream Cheese" via the JSON block.
        weight_lines = []
        weighted_weights: list[float] = []
        for i, c in enumerate(candidates):
            if c.expected_weight_g is None:
                continue
            w = float(c.expected_weight_g)
            weighted_weights.append(w)
            weight_lines.append(f"  - candidate #{i + 1}: ~{w:.1f} g")
        if weight_lines:
            lines.append("")
            lines.append("Candidate reference weights (by index):")
            lines.extend(weight_lines)

        # Multi-item hint: if this is a REMOVE and |delta| exceeds the
        # largest single candidate weight, prompt the classifier to
        # consider multi_match combinations.
        if direction == "remove" and weighted_weights:
            abs_delta = abs(delta_g)
            largest = max(weighted_weights)
            if abs_delta > largest * 1.15:
                total_if_all = sum(weighted_weights)
                lines.append("")
                lines.append(
                    f"Note: |delta|={abs_delta:.1f}g exceeds the largest "
                    f"single candidate ({largest:.1f}g). Combined weight "
                    f"of all candidates: {total_if_all:.1f}g. Consider "
                    f"whether multiple items were removed in one motion "
                    f"and return them via multi_match."
                )

    return "\n".join(lines)


# --- Main entry point ------------------------------------------------------


def build_messages_payload(
    event: ScaleEvent,
    candidates: list[Candidate],
    *,
    enable_system_cache: bool = True,
    enable_candidate_cache: bool = True,
) -> dict[str, Any]:
    """Assemble the full ``messages.create(...)`` payload.

    Args:
        event: The scale event being classified. Must carry both frame paths.
        candidates: Ranked candidate pool (as built by
            :mod:`candidate_pool`). The order is preserved in the JSON.
        enable_system_cache: Apply ``cache_control: ephemeral`` to the
            system prompt so subsequent classifier calls in the same session
            hit the prompt cache (see §7.3).
        enable_candidate_cache: Apply ``cache_control: ephemeral`` on the
            candidate metadata + reference-image block so the shelf
            registry stays warm across events in a session (§7.3). The
            per-event before/after frames are always fresh tokens.

    Returns:
        A dict with ``system`` and ``messages`` keys suitable for passing
        (via ``**payload``) to ``Anthropic().messages.create(...)``.
    """

    # --- System block with optional cache breakpoint ----------------------
    if enable_system_cache:
        system: list[dict[str, Any]] | str = [
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ]
    else:
        system = SYSTEM_PROMPT

    # --- User content blocks ---------------------------------------------
    # Ordering is deliberate: the cache-stable prefix (candidate JSON +
    # reference images) comes FIRST so the cache breakpoint can live at
    # its end and the whole prefix stays warm across events in a session.
    # Fresh per-event content (weight delta, before/after frames,
    # instruction) is appended AFTER the breakpoint.
    #
    # Nothing per-event belongs above the breakpoint — even the tiny weight
    # text would otherwise be cached with the wrong delta on event #2.
    user_content: list[dict[str, Any]] = []

    # 1. Candidate JSON + inlined reference images (CACHE-STABLE prefix).
    #    Build one block per candidate so each reference image is co-located
    #    with the candidate that owns it.
    candidate_payload = [c.to_prompt_dict() for c in candidates]
    header_text = (
        "Candidates (ranked by likelihood):\n"
        + json.dumps(candidate_payload, indent=2, sort_keys=False)
    )
    user_content.append({"type": "text", "text": header_text})

    # Inline reference images per candidate so the classifier can visually
    # compare. We emit a small "candidate X reference" header before each
    # group so the mapping stays unambiguous in the model's view.
    for index, candidate in enumerate(candidates):
        if not candidate.reference_image_paths:
            continue
        # Fix 5: do NOT interpolate candidate name / id into free text.
        # The structured JSON block above already carries both values
        # (so the model can look them up), and any hostile characters in
        # a product name become a prompt-injection surface once embedded
        # directly into the user turn. Keep the inline header minimal.
        user_content.append(
            {
                "type": "text",
                "text": f"[candidate #{index + 1} reference images]",
            }
        )
        for ref_path in candidate.reference_image_paths:
            user_content.append(_encode_image_block(ref_path))

    # Cache breakpoint: apply cache_control to the last candidate/reference
    # block so the entire shelf-registry prefix (system + candidate JSON +
    # reference images) caches as one unit. Everything AFTER this block is
    # fresh per-event content.
    if enable_candidate_cache and user_content:
        # The current last block is either the JSON text header (if no ref
        # images) or the final reference image block. Content blocks in the
        # messages API support `cache_control` the same way system blocks do.
        user_content[-1] = {
            **user_content[-1],
            "cache_control": {"type": "ephemeral"},
        }

    # 2. Scale delta + direction text (fresh — after cache breakpoint).
    user_content.append(
        {
            "type": "text",
            "text": _weight_text(event.delta_g, event.direction, candidates),
        }
    )

    # 3. Per-event before frame image (fresh — after cache breakpoint).
    if event.before_frame_path:
        user_content.append(_encode_image_block(event.before_frame_path))
        user_content.append({"type": "text", "text": "[above: before frame]"})

    # 4. Per-event after frame image (fresh — after cache breakpoint).
    if event.after_frame_path:
        user_content.append(_encode_image_block(event.after_frame_path))
        user_content.append({"type": "text", "text": "[above: after frame]"})

    # 5. Final instruction (fresh — after cache breakpoint).
    user_content.append({"type": "text", "text": INSTRUCTION_TEXT})

    return {
        "system": system,
        "messages": [
            {
                "role": "user",
                "content": user_content,
            }
        ],
    }


def _catch_all_weight_text(
    delta_g: float,
    after_weight_g: float,
    candidates: Optional[list[Candidate]] = None,
) -> str:
    """Catch-all weight context.

    The scale's absolute reading (``after_weight_g``) is the primary
    signal — it's the measured mass of the item on the countertop —
    and ``delta_g`` is included as a secondary diagnostic for the
    rare case where the user adjusted an already-on-scale item. We
    list candidate reference weights as a sanity check, but make it
    clear they're flexible (partial fill is normal for catch-all).
    """

    lines = [
        f"Measured weight on scale: {after_weight_g:.1f} g",
    ]
    if abs(delta_g - after_weight_g) > 1.0:
        # Only mention delta if it's distinct from the absolute reading
        # (e.g. an item was already on the scale and the user added
        # more). Most catch-all events have delta == after_weight (item
        # placed on empty scale).
        lines.append(f"Weight change since last reading: {delta_g:+.1f} g")

    if candidates:
        weight_lines: list[str] = []
        for i, c in enumerate(candidates):
            if c.expected_weight_g is None:
                continue
            w = float(c.expected_weight_g)
            weight_lines.append(f"  - candidate #{i + 1}: ~{w:.1f} g")
        if weight_lines:
            lines.append("")
            lines.append(
                "Candidate reference weights (catalog full weight or "
                "last-known weight; partial fills are common — wide "
                "tolerance):"
            )
            lines.extend(weight_lines)

    return "\n".join(lines)


def build_catch_all_messages_payload(
    event: ScaleEvent,
    candidates: list[Candidate],
    *,
    enable_system_cache: bool = True,
    enable_candidate_cache: bool = True,
) -> dict[str, Any]:
    """Assemble a single-frame catch-all classifier payload.

    Differences from :func:`build_messages_payload`:
      - Uses :data:`CATCH_ALL_SYSTEM_PROMPT` (single-moment framing,
        visual-primary, no delta math).
      - Uses :func:`_catch_all_weight_text` (absolute scale reading,
        not before/after delta).
      - Sends ONLY the after frame (the single captured image).
        ``event.before_frame_path`` is ignored — catch-all events have
        no before frame by design (single-moment events).
      - Uses :data:`CATCH_ALL_INSTRUCTION_TEXT` (identify the item in
        this image; no multi_match/secondary).
    """

    # System block
    if enable_system_cache:
        system: list[dict[str, Any]] | str = [
            {
                "type": "text",
                "text": CATCH_ALL_SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ]
    else:
        system = CATCH_ALL_SYSTEM_PROMPT

    user_content: list[dict[str, Any]] = []

    # 1. Candidate JSON + reference images (cache-stable prefix).
    candidate_payload = [c.to_prompt_dict() for c in candidates]
    header_text = (
        "Candidates (ranked by likelihood):\n"
        + json.dumps(candidate_payload, indent=2, sort_keys=False)
    )
    user_content.append({"type": "text", "text": header_text})

    for index, candidate in enumerate(candidates):
        if not candidate.reference_image_paths:
            continue
        user_content.append(
            {
                "type": "text",
                "text": f"[candidate #{index + 1} reference images]",
            }
        )
        for ref_path in candidate.reference_image_paths:
            user_content.append(_encode_image_block(ref_path))

    if enable_candidate_cache and user_content:
        user_content[-1] = {
            **user_content[-1],
            "cache_control": {"type": "ephemeral"},
        }

    # 2. Weight context (fresh per-event).
    user_content.append(
        {
            "type": "text",
            "text": _catch_all_weight_text(
                event.delta_g, event.after_weight_g, candidates,
            ),
        }
    )

    # 3. Single frame (the after frame is the capture). Single-moment
    # event — there is no before frame to send.
    if event.after_frame_path:
        user_content.append(_encode_image_block(event.after_frame_path))
        user_content.append(
            {"type": "text", "text": "[above: scale image at stability]"}
        )

    # 4. Final instruction.
    user_content.append({"type": "text", "text": CATCH_ALL_INSTRUCTION_TEXT})

    return {
        "system": system,
        "messages": [
            {
                "role": "user",
                "content": user_content,
            }
        ],
    }


# Convenience for tests / callers that don't want the full payload dict.
def build_system_prompt() -> str:
    """Return the raw shelf system prompt text (for inspection)."""

    return SYSTEM_PROMPT


def build_catch_all_system_prompt() -> str:
    """Return the raw catch-all system prompt text (for inspection)."""

    return CATCH_ALL_SYSTEM_PROMPT
