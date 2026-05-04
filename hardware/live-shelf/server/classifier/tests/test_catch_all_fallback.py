"""Two-pass catch-all classifier orchestrator tests.

Covers :func:`server.classifier.catch_all_fallback.classify_catch_all_with_fallback`:

  1. High-confidence pass-1 hit → no pass-2 fired; meta stamps
     ``catch_all_pass=1`` + ``needs_certify=False``.
  2. Pass-1 UNKNOWN + high-confidence pass-2 → pass-2 wins; meta
     stamps ``catch_all_pass=2`` + ``needs_certify=True``.
  3. Pass-1 low-confidence + high-confidence pass-2 → pass-2 wins.
  4. Pass-1 UNKNOWN + pass-2 UNKNOWN → final UNKNOWN; meta stamps
     ``catch_all_pass=2`` + ``needs_certify=False``.
  5. Pass-1 UNKNOWN + pass-2 returns out-of-pool id → treat as UNKNOWN.
  6. Pass-1 pool empty (no certified inventory, no in-flight) → skip
     directly to pass-2 without an API call for pass-1.
  7. Pass-1 returns out-of-pool id → treat as low-confidence + try pass-2.
  8. Both pools empty → synthetic UNKNOWN; both API calls skipped.

Anthropic client is mocked. Reference images are tiny in-memory JPEGs
the prompt builder reads with PIL.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.classifier.anthropic_client import ClassifierCallResult  # noqa: E402
from server.classifier.catch_all_fallback import (  # noqa: E402
    LOW_CONFIDENCE_THRESHOLD,
    classify_catch_all_with_fallback,
)
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    ClassifierContext,
    LotCandidate,
    ScaleEvent,
)


# --- Fixtures -------------------------------------------------------------

_TINY_JPEG = bytes.fromhex("FFD8FFE000104A4649460001010000480048000000FFD9")


@pytest.fixture
def frame_paths(tmp_path: Path) -> tuple[str, str]:
    after = tmp_path / "after.jpg"
    after.write_bytes(_TINY_JPEG)
    # Catch-all uses a single after-frame; before is None / empty
    # because catch-all is single-frame by design (see catch_all_prompt).
    before = tmp_path / "before.jpg"
    before.write_bytes(_TINY_JPEG)
    return str(before), str(after)


def _add_event(before: str, after: str, *, delta: float = 600.0) -> ScaleEvent:
    """Build a representative catch-all ADD event."""
    return ScaleEvent(
        event_id="evt_catchall_1",
        session_id="sesn_catchall",
        ts="2026-05-03T12:00:00.000Z",
        delta_g=delta,
        before_weight_g=0.0,
        after_weight_g=delta,
        direction="add",
        before_frame_path=before,
        after_frame_path=after,
    )


def _lot(
    lot_id: str,
    *,
    weight_g: float = 500.0,
    name: str | None = None,
    status: str = "out",
) -> LotCandidate:
    return LotCandidate(
        lot_id=lot_id,
        product_id=f"p-{lot_id}",
        name=name or f"Item {lot_id}",
        brand=None,
        expected_weight_g=weight_g,
        container_type="bottle",
        status=status,
        reference_image_paths=(),
    )


class _FakeClient:
    """Anthropic client stub — scripts replies in order."""

    def __init__(self, responses: list[Any]) -> None:
        self._responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def send(
        self, payload: dict[str, Any], *, model: str | None = None,
    ) -> ClassifierCallResult:
        self.calls.append({"payload": payload, "model": model})
        if not self._responses:
            raise AssertionError("FakeClient: out of scripted responses")
        nxt = self._responses.pop(0)
        if isinstance(nxt, ClassifierCallResult):
            return nxt
        return ClassifierCallResult(
            text=str(nxt),
            model=model or "claude-sonnet-4-6",
            usage={"input_tokens": 100, "output_tokens": 20},
            raw=None,
        )


class _CatchAllSource:
    """Minimal CandidateSource for the two-pass orchestrator.

    Only the catch-all-specific methods matter — pass-1 reads
    ``get_catch_all_in_flight_lots`` + ``get_catch_all_certified_user_inventory_lots``;
    pass-2 reads only ``get_catch_all_uncertified_user_inventory_lots``.
    """

    def __init__(
        self,
        *,
        in_flight: list[LotCandidate] | None = None,
        certified: list[LotCandidate] | None = None,
        uncertified: list[LotCandidate] | None = None,
    ) -> None:
        self._in_flight = list(in_flight or ())
        self._certified = list(certified or ())
        self._uncertified = list(uncertified or ())
        self.calls = {"certified": 0, "uncertified": 0, "in_flight": 0}

    def has_catalog(self) -> bool:
        return True

    def get_catch_all_in_flight_lots(self):
        self.calls["in_flight"] += 1
        return list(self._in_flight)

    def get_catch_all_certified_user_inventory_lots(self):
        self.calls["certified"] += 1
        return list(self._certified)

    def get_catch_all_uncertified_user_inventory_lots(self):
        self.calls["uncertified"] += 1
        return list(self._uncertified)

    # Live-shelf surface — never queried by the catch-all orchestrator.
    def get_on_shelf_lots(self, shelf_id=None):
        return []

    def get_recently_out_lots(self, window_seconds, shelf_id=None):
        return []

    def get_in_flight_lots(self, max_age_seconds=None, shelf_id=None):
        return []

    def get_certified_not_on_shelf(self):
        return []


def _resp(item_id: str, *, confidence: float, action: str = "added") -> str:
    """JSON shape the classifier parser expects."""
    return json.dumps(
        {
            "item_id": item_id,
            "action": action,
            "confidence": confidence,
            "reasoning": "stub",
        }
    )


# --- Tests ----------------------------------------------------------------


class TestPass1Wins:
    def test_pass1_high_confidence_skips_pass2(self, frame_paths) -> None:
        """Pass-1 returns a confident, in-pool match → no pass-2 call.

        Meta stamps ``catch_all_pass=1`` and ``needs_certify=False`` so
        the dispatch path skips the certify auto-import block.
        """
        before, after = frame_paths
        client = _FakeClient([_resp("lot-cert-1", confidence=0.95)])
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after, delta=600.0), ctx,
        )

        assert result.item_id == "lot-cert-1"
        assert result.confidence == pytest.approx(0.95)
        # Only ONE Anthropic call — pass-2 was not fired.
        assert len(client.calls) == 1
        assert result.meta.get("catch_all_pass") == 1
        assert result.meta.get("needs_certify") is False
        # Pass-1 audit field always populated.
        assert result.meta.get("catch_all_pass1_item_id") == "lot-cert-1"
        # Pass-2 was NOT consulted.
        assert source.calls["uncertified"] == 0
        # Audit B-HIGH-1 (2026-05-04): pass-2 fields MUST BE ABSENT
        # when pass-1 wins. The orchestrator's deliberate non-stamping
        # of pass-2 telemetry on pass-1 wins is the implicit signal
        # downstream operators use to read "this was a pass-1 win,
        # certify side effect didn't fire". A regression that
        # always-stamps pass-2 fields (e.g. None) would muddy the
        # audit trail and make "why did certify fire?" harder.
        assert "catch_all_pass2_item_id" not in result.meta, (
            "pass-1 win must NOT stamp pass-2 telemetry — operators "
            "rely on the absence of pass-2 fields to identify pass-1 wins"
        )
        assert "catch_all_pass2_confidence" not in result.meta


class TestPass2Wins:
    def test_pass1_unknown_pass2_high_confidence_pass2_wins(self, frame_paths) -> None:
        """Pass-1 UNKNOWN, pass-2 confident in-pool → pass-2 wins.

        Meta stamps ``catch_all_pass=2`` and ``needs_certify=True`` so
        the dispatch path issues the certify auto-import push.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
                _resp("lot-uncert-1", confidence=0.92),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=300.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after, delta=600.0), ctx,
        )

        assert result.item_id == "lot-uncert-1"
        assert result.confidence == pytest.approx(0.92)
        # Both passes fired.
        assert len(client.calls) == 2
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is True
        # Both passes' audit fields populated.
        assert result.meta.get("catch_all_pass1_item_id") == UNKNOWN_CANDIDATE_ID
        assert result.meta.get("catch_all_pass2_item_id") == "lot-uncert-1"

    def test_pass1_low_confidence_pass2_high_confidence_pass2_wins(
        self, frame_paths,
    ) -> None:
        """Pass-1 below LOW_CONFIDENCE_THRESHOLD, pass-2 above → pass-2 wins.

        Confirms the orchestrator triggers pass-2 on low confidence,
        not just on UNKNOWN. Threshold is 0.75 so 0.5 is firmly below.
        """
        assert LOW_CONFIDENCE_THRESHOLD == 0.75
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp("lot-cert-1", confidence=0.5),
                _resp("lot-uncert-1", confidence=0.9),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == "lot-uncert-1"
        assert result.confidence == pytest.approx(0.9)
        assert len(client.calls) == 2
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is True


class TestBothFail:
    def test_both_pass_unknown_returns_unknown(self, frame_paths) -> None:
        """Pass-1 + pass-2 both UNKNOWN → final UNKNOWN, no certify push.

        Meta stamps ``catch_all_pass=2`` (last attempted) and
        ``needs_certify=False`` so the dispatch path falls through to
        the legacy review queue path WITHOUT pushing certified=true.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert len(client.calls) == 2
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False

    def test_pass2_out_of_pool_id_treated_as_unknown(self, frame_paths) -> None:
        """Pass-2 returns an id not in its candidate pool → reject, UNKNOWN.

        Hallucination guard: a model that confidently invents an
        out-of-pool id MUST NOT trigger the certify auto-import. The
        orchestrator falls back to pass-1's UNKNOWN result.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
                _resp("lot-fake-not-in-pool", confidence=0.95),
            ]
        )
        source = _CatchAllSource(
            uncertified=[_lot("lot-uncert-real", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        # The hallucinated id is rejected; final result is UNKNOWN-shaped.
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False


class TestPoolEdges:
    def test_empty_pass1_skips_directly_to_pass2(self, frame_paths) -> None:
        """No certified inventory + no in-flight → skip pass-1 API call.

        The orchestrator detects an empty pass-1 pool (sentinel-only)
        and skips straight to pass-2 — no wasted API call.
        """
        before, after = frame_paths
        # Only ONE response queued — if pass-1 were called this would
        # raise "out of scripted responses".
        client = _FakeClient([_resp("lot-uncert-1", confidence=0.92)])
        source = _CatchAllSource(
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == "lot-uncert-1"
        assert len(client.calls) == 1, (
            "pass-1 must skip the API call when its pool is empty"
        )
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is True

    def test_empty_pass2_returns_pass1_result(self, frame_paths) -> None:
        """Pass-1 UNKNOWN + empty pass-2 pool → return pass-1 UNKNOWN as-is.

        No certify push, ``catch_all_pass=2`` so operators can see the
        second pass was at least considered.
        """
        before, after = frame_paths
        client = _FakeClient(
            [_resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown")]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            # No uncertified inventory.
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == UNKNOWN_CANDIDATE_ID
        # Pass-1 fired; pass-2 short-circuited (no API call) because
        # its pool was empty.
        assert len(client.calls) == 1
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False

    def test_both_pools_empty_synthesises_unknown(self, frame_paths) -> None:
        """No inventory at all → synthetic UNKNOWN; both API calls skipped.

        Defensive shape: dispatch path needs SOMETHING to log even
        when the user has no inventory mirrored locally.
        """
        before, after = frame_paths
        client = _FakeClient([])  # never used
        source = _CatchAllSource()
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == UNKNOWN_CANDIDATE_ID
        assert client.calls == [], "no API calls should fire on empty pools"
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False


class TestPass1Hallucination:
    def test_pass1_out_of_pool_id_falls_through_to_pass2(self, frame_paths) -> None:
        """Pass-1 returns a high-confidence but out-of-pool id → try pass-2.

        Treats hallucinated pass-1 ids as if they were low-confidence,
        so the pass-2 fallback still gets a chance to find the right
        product. If pass-2 also fails, final result is UNKNOWN.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp("lot-fake-not-in-pool", confidence=0.95),
                _resp("lot-uncert-1", confidence=0.92),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-real", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == "lot-uncert-1"
        assert len(client.calls) == 2
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is True

    def test_pass1_hallucinated_id_collapses_to_unknown_when_pass2_misses(
        self, frame_paths,
    ) -> None:
        """Audit 1-HIGH-1 (2026-05-04): pass-1 high-conf hallucination
        → orchestrator MUST return UNKNOWN as the final ``item_id`` even
        when pass-2 also fails.

        Pre-fix: ``pass1`` was preserved as the fallback base when both
        passes missed, so the hallucinated id leaked downstream. The
        ``_classify_recorded_event`` reader would mark the event
        "classified" on confidence alone, while the pool-membership
        guard skipped lot mutation — yielding a classified-but-unapplied
        event with no review row.

        Post-fix: the hallucinated id collapses to UNKNOWN before the
        fallback base selection, but stays in
        ``meta['catch_all_pass1_item_id']`` for operator audit.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp("lot-fake-not-in-pool", confidence=0.95),
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-real", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-real", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        # Final item_id MUST NOT be the hallucinated id. Downstream
        # apply paths read this — leaking the hallucinated id is the
        # exact bug the audit identified.
        assert result.item_id == UNKNOWN_CANDIDATE_ID, (
            "BUG: pass-1 hallucinated id leaked through to the final "
            "result. The orchestrator must collapse out-of-pool pass-1 "
            "ids to UNKNOWN before the fallback base selection."
        )
        assert result.action == "unknown"
        # Telemetry: the raw hallucinated id must STILL be visible so
        # operators can see "pass-1 said X (we rejected it)".
        assert result.meta.get("catch_all_pass1_item_id") == "lot-fake-not-in-pool", (
            "audit trail: the hallucinated id must be preserved in "
            "meta['catch_all_pass1_item_id'] even though the result "
            "collapsed to UNKNOWN"
        )
        assert result.meta.get("catch_all_pass1_confidence") == pytest.approx(0.95)
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False
        # Both passes fired (pass-2 was given a chance after the pass-1
        # hallucination collapsed to UNKNOWN).
        assert len(client.calls) == 2

    def test_pass2_hallucinated_id_does_not_leak_with_pass1_unknown(
        self, frame_paths,
    ) -> None:
        """Audit 1-HIGH-1 mirror: pass-2 hallucination must collapse too.

        Companion to the pass-1 test above. When pass-1 returns UNKNOWN
        (legitimately) and pass-2 returns a high-confidence out-of-pool
        id, the orchestrator must collapse pass-2's hallucinated result
        to UNKNOWN before the fallback base selection. Pre-fix, the
        warning was logged but ``pass2`` itself remained set to the
        out-of-pool result — though the existing code used ``base = pass1``
        in the both-failed branch, so the leak was less severe than the
        pass-1 case. We pin both shapes for defense in depth.
        """
        before, after = frame_paths
        client = _FakeClient(
            [
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
                _resp("lot-fake-pass2", confidence=0.93),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-real", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-real", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after), ctx,
        )

        assert result.item_id == UNKNOWN_CANDIDATE_ID
        # Pass-2 raw id stamped for telemetry.
        assert result.meta.get("catch_all_pass2_item_id") == "lot-fake-pass2"
        assert result.meta.get("catch_all_pass2_confidence") == pytest.approx(0.93)
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("needs_certify") is False

    def test_orchestrator_emits_classifier_prompt_prepared_per_pass(
        self, frame_paths,
    ) -> None:
        """Round-2 audit N-MED-1 (2026-05-04): the orchestrator must
        emit a ``classifier_prompt_prepared`` lifecycle row for every
        pass it runs, restoring the observability hook the legacy
        single-pass ``classify_event`` used to provide.

        Operators correlate per-pass prompt hashes with eventual
        classification outcomes for triage. Pre-fix, catch-all ADD
        events emitted ZERO prompt-prepared rows because the orchestrator
        bypassed ``classify.py`` entirely.

        Mutation guard: removing the ``_classify_lc(... reason_code=
        "classifier_prompt_prepared")`` call from ``_run_pass`` makes
        this test fail. Renaming the variant labels also fails it
        (audit-log filters depend on the per-pass distinction).
        """
        before, after = frame_paths
        # Pass-1 UNKNOWN drives a real pass-2 call so we get TWO
        # prompt_prepared rows. The cert/uncert pools both have lots
        # so neither pass short-circuits on len(pool)<=1.
        client = _FakeClient(
            [
                _resp(UNKNOWN_CANDIDATE_ID, confidence=0.1, action="unknown"),
                _resp("lot-uncert-1", confidence=0.92),
            ]
        )
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            uncertified=[_lot("lot-uncert-1", weight_g=600.0)],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        captured: list[dict] = []

        def _sink(event_id, *, actor, reason_code, payload=None):
            captured.append({
                "event_id": event_id,
                "actor": actor,
                "reason_code": reason_code,
                "payload": payload or {},
            })

        import server.classifier.classify as classify_mod
        prev_sink = classify_mod._LIFECYCLE_SINK
        classify_mod.set_lifecycle_sink(_sink)
        try:
            classify_catch_all_with_fallback(
                _add_event(before, after, delta=600.0), ctx,
            )
        finally:
            classify_mod.set_lifecycle_sink(prev_sink)

        prepared = [
            c for c in captured
            if c["reason_code"] == "classifier_prompt_prepared"
        ]
        assert len(prepared) == 2, (
            "expected one classifier_prompt_prepared row per pass; "
            f"got {len(prepared)}"
        )
        variants = [p["payload"].get("prompt_variant") for p in prepared]
        assert variants == ["catch_all_pass1", "catch_all_pass2"], (
            "prompt_variant labels must distinguish the two passes "
            "(operators rely on this for audit-log filters)"
        )
        # Both rows carry pool_size + prompt_hash, mirroring the
        # legacy classify_event payload shape.
        for row in prepared:
            assert isinstance(row["payload"].get("pool_size"), int)
            assert row["payload"].get("pool_size") > 0
            assert isinstance(row["payload"].get("prompt_hash"), str)
            assert len(row["payload"]["prompt_hash"]) > 0

    def test_pass1_hallucination_with_empty_pass2_preserves_raw_id_in_meta(
        self, frame_paths,
    ) -> None:
        """Round-2 audit N-MED-2 (2026-05-04): pass-1 returns a
        high-confidence id NOT in pass-1's pool AND the user has no
        uncertified inventory (pass-2 pool is sentinel-only) → the
        orchestrator MUST short-circuit on the empty pass-2 pool and
        return UNKNOWN with the hallucinated id preserved in meta for
        operator audit ("why did certify NOT fire — was it a
        hallucination or a clean UNKNOWN?").

        Pre-fix risk: dropping the ``pass1_raw_item_id`` capture in the
        empty-pass-2 short-circuit branch (catch_all_fallback.py) would
        silently lose the hallucination signal in this combination.
        Existing tests run pass-2 OR have a legitimate pass-1 UNKNOWN —
        neither covers this seam.
        """
        before, after = frame_paths
        # Pass-1 confidently hallucinates an id NOT in the pass-1 pool.
        client = _FakeClient(
            [
                _resp("lot-fake-not-in-pool", confidence=0.95),
            ]
        )
        # Certified inventory exists (so pass-1 has real candidates),
        # but NO uncertified inventory → pass-2 pool is sentinel-only
        # → orchestrator short-circuits without a second API call.
        source = _CatchAllSource(
            certified=[_lot("lot-cert-1", weight_g=600.0)],
            uncertified=[],
        )
        ctx = ClassifierContext(
            source=source, anthropic_client=client, shelf_id="catch_all",
        )

        result = classify_catch_all_with_fallback(
            _add_event(before, after, delta=600.0), ctx,
        )

        # Outcome: UNKNOWN result (the hallucinated id never leaked).
        assert result.item_id == UNKNOWN_CANDIDATE_ID
        # Only ONE API call (pass-1) — pass-2 short-circuited.
        assert len(client.calls) == 1
        # Telemetry: pass-1 raw id preserved so operators can see WHY
        # the orchestrator returned UNKNOWN. This is the core
        # mutation-guard for N-MED-2 — dropping the ``pass1_raw_item_id``
        # capture in the empty-pass-2 short-circuit branch breaks this.
        assert result.meta.get("catch_all_pass1_item_id") == "lot-fake-not-in-pool"
        assert result.meta.get("catch_all_pass1_confidence") == pytest.approx(0.95)
        # ``catch_all_pass = 2`` per the orchestrator's "pass-2 was at
        # least considered" contract; pass-2 telemetry is None/0.0 to
        # signal "considered but didn't run" (vs "ran and matched
        # nothing", which would be a non-None item_id with confidence 0).
        assert result.meta.get("catch_all_pass") == 2
        assert result.meta.get("catch_all_pass2_item_id") is None
        assert result.meta.get("catch_all_pass2_confidence") == 0.0
        # No certify push downstream — the result is UNKNOWN, not a
        # confident pass-2 win.
        assert result.meta.get("needs_certify") is False
