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
    _is_in_pool,
    _run_pass,
    classify_catch_all_with_fallback,
)
from server.classifier.candidate_pool import UNKNOWN_SENTINEL  # noqa: E402
from server.classifier.models import (  # noqa: E402
    UNKNOWN_CANDIDATE_ID,
    Candidate,
    ClassificationResult,
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
        # Audit B-HIGH-4 (2026-05-04): pass-1 telemetry preserves the
        # hallucinated id even though the orchestrator rejected it —
        # operators correlate "why did certify NOT fire here" with the
        # raw model output. Distinguishes this case from "pass-1 returned
        # UNKNOWN" cleanly: the raw id is the hallucinated one, not the
        # UNKNOWN sentinel. A regression that collapses the meta stamp
        # alongside the result would lose this signal silently.
        assert result.meta.get("catch_all_pass1_item_id") == "lot-fake-not-in-pool", (
            "pass-1 hallucination must be preserved in meta even when "
            "the orchestrator's pool-membership guard rejects the result"
        )
        assert float(result.meta.get("catch_all_pass1_confidence") or 0) >= 0.9, (
            "raw pass-1 confidence must round-trip to meta — operators "
            "use it to distinguish low-confidence misses (skip pass-2 "
            "blame) from high-confidence hallucinations (suspect prompt)"
        )

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


# ---------------------------------------------------------------------------
# Audit C-MED-3 (2026-05-04): _is_in_pool lot-id-only match.
#
# ``_is_in_pool`` checks BOTH ``candidate_id`` and ``lot_id`` on each pool
# entry. The catch-all pool builders currently set them equal, so every
# integration test today exercises the candidate_id path. If a future
# builder ever distinguishes the two — e.g. uses a product-keyed
# candidate_id while leaving the cloud lot_id as the classifier-visible
# token — the lot_id-only match path becomes the only thing that catches
# the resulting in-pool ids. Pin it directly so a refactor that drops
# the lot_id branch fails immediately.
# ---------------------------------------------------------------------------


class TestIsInPoolLotIdMatch:
    """Direct unit tests for the ``_is_in_pool`` membership helper."""

    def _make_candidate(
        self,
        *,
        candidate_id: str | None,
        lot_id: str | None,
    ) -> Candidate:
        """Build a minimal Candidate carrying just the two id fields."""
        return Candidate(
            candidate_id=candidate_id or "",
            name="x",
            brand=None,
            expected_weight_g=None,
            container_type=None,
            why_candidate="inventory_only",
            reference_image_paths=(),
            rank_score=0.0,
            product_id=None,
            lot_id=lot_id,
        )

    def _make_result(self, item_id: str) -> ClassificationResult:
        return ClassificationResult(
            item_id=item_id,
            action="added",
            confidence=0.9,
            reasoning="stub",
            secondary_candidates=(),
            multi_match=(),
            candidate_pool_used=(),
            meta={},
        )

    def test_lot_id_match_alone_accepts_when_candidate_id_differs(self):
        """Result item_id matches ONLY by ``lot_id`` (not ``candidate_id``)
        → ``_is_in_pool`` returns True.

        Mutation guard: dropping the second ``c.lot_id`` branch in
        ``_is_in_pool`` makes this test fail because the ``candidate_id``
        comparison alone never matches the cloud-keyed lot id.

        This codifies the future-proofing the helper provides for any
        refactor that gives candidates a product-keyed candidate_id while
        keeping the lot_id as the classifier-visible token.
        """
        pool = [
            self._make_candidate(
                candidate_id="prod-keyed-id",  # NOT what the model returns
                lot_id="cloud-lot-xyz",        # this IS what the model returns
            ),
        ]
        result = self._make_result("cloud-lot-xyz")
        assert _is_in_pool(result, pool) is True, (
            "lot_id branch must accept the result when only lot_id "
            "matches the model's returned id — the candidate_id branch "
            "is irrelevant in this configuration"
        )

    def test_candidate_id_match_alone_still_accepts(self):
        """Symmetric pin: when candidate_id matches but lot_id is None
        (legacy single-id pool), the membership check still succeeds.
        Mutation guard: dropping the candidate_id branch breaks this.
        """
        pool = [
            self._make_candidate(
                candidate_id="cand-only",
                lot_id=None,
            ),
        ]
        result = self._make_result("cand-only")
        assert _is_in_pool(result, pool) is True

    def test_neither_branch_matches_returns_false(self):
        """A result item_id that matches NO entry on either branch
        is correctly rejected — the hallucination guard fires."""
        pool = [
            self._make_candidate(candidate_id="cand-1", lot_id="lot-1"),
            self._make_candidate(candidate_id="cand-2", lot_id="lot-2"),
        ]
        result = self._make_result("totally-unrelated")
        assert _is_in_pool(result, pool) is False

    def test_unknown_sentinel_is_in_pool_short_circuits(self):
        """The UNKNOWN sentinel id always "matches" because the caller
        checks UNKNOWN separately. Pin so a refactor that tightens the
        check doesn't break the orchestrator's UNKNOWN handling."""
        pool = [
            self._make_candidate(candidate_id="cand-1", lot_id="lot-1"),
        ]
        result = self._make_result(UNKNOWN_CANDIDATE_ID)
        assert _is_in_pool(result, pool) is True


# ---------------------------------------------------------------------------
# Audit C-MED-4 (2026-05-04): _run_pass sentinel-only pool short-circuit.
#
# ``classify_catch_all_with_fallback`` checks ``len(pool) <= 1`` at TWO
# layers: the outer orchestrator (line ~265, ~315) AND the inner
# ``_run_pass`` helper (line ~108). The outer checks gate which passes
# fire; the inner check is defense in depth — it skips the API call
# (and the lifecycle row) when called with a sentinel-only pool. A
# regression that drops the inner check but keeps the outer would still
# pass every existing test (because the outer always short-circuits
# first). Pin the inner directly.
# ---------------------------------------------------------------------------


class TestRunPassSentinelShortCircuit:
    """Direct unit tests for ``_run_pass`` with a sentinel-only pool."""

    def test_run_pass_skips_api_call_on_sentinel_only_pool(self, frame_paths):
        """``_run_pass`` MUST return None and MUST NOT call the client
        when its pool contains only the UNKNOWN sentinel.

        Mutation guard: dropping the ``if len(pool) <= 1`` short-circuit
        from ``_run_pass`` (catch_all_fallback.py:108) makes the helper
        attempt the Anthropic call, which the FakeClient raises on.
        Existing tests can't catch this regression because the orchestrator
        layer also short-circuits on empty pools and never invokes
        ``_run_pass`` in that case.
        """
        before, after = frame_paths

        class _RaisingClient:
            """Asserts ``send`` is never called."""

            def __init__(self):
                self.calls: list = []

            def send(self, payload, *, model=None):
                self.calls.append({"payload": payload, "model": model})
                raise AssertionError(
                    "_run_pass MUST NOT invoke the client when the pool "
                    "is sentinel-only — the inner short-circuit is the "
                    "second-line defense behind the orchestrator's "
                    "outer gating"
                )

        client = _RaisingClient()
        ctx = ClassifierContext(
            source=_CatchAllSource(),
            anthropic_client=client,
            shelf_id="catch_all",
        )
        sentinel_only_pool = [UNKNOWN_SENTINEL]

        result = _run_pass(
            _add_event(before, after, delta=600.0),
            ctx,
            sentinel_only_pool,
            instruction_note="test sentinel short-circuit",
            model=None,
            pass_label="catch_all_pass1",
        )

        assert result is None, (
            "sentinel-only pool must return None so the orchestrator's "
            "fallback logic can synthesise the appropriate UNKNOWN result"
        )
        assert client.calls == [], (
            "no API call should fire on a sentinel-only pool — the "
            "model has nothing to match against"
        )

    def test_run_pass_skips_api_call_on_completely_empty_pool(
        self, frame_paths,
    ):
        """Symmetric pin: even a totally empty pool (no sentinel either)
        short-circuits the same way. Defends against a regression that
        only checks for sentinel presence rather than length."""
        before, after = frame_paths

        class _RaisingClient:
            def send(self, payload, *, model=None):
                raise AssertionError(
                    "empty pool must short-circuit before the API call"
                )

        client = _RaisingClient()
        ctx = ClassifierContext(
            source=_CatchAllSource(),
            anthropic_client=client,
            shelf_id="catch_all",
        )

        result = _run_pass(
            _add_event(before, after, delta=600.0),
            ctx,
            [],  # totally empty
            instruction_note="test empty short-circuit",
            model=None,
            pass_label="catch_all_pass1",
        )
        assert result is None


# ---------------------------------------------------------------------------
# Audit D-LOW-1 (2026-05-04): per-pass instruction-note routing.
#
# ``_run_pass`` prepends a pass-specific text note to the candidate JSON
# so the model reads the pass intent first. The note carries different
# wording for pass-1 (CERTIFIED) vs pass-2 (UNCERTIFIED) — operators rely
# on the wording to debug stuck classifications. Existing tests assert
# the orchestrator's outputs; none pin the per-pass note routing. A
# regression that swaps pass-1/pass-2 notes would be invisible.
# ---------------------------------------------------------------------------


def test_pass1_note_lands_on_pass1_payload_and_pass2_note_on_pass2(
    frame_paths,
):
    """Both passes fire → pass-1 payload carries the CERTIFIED note,
    pass-2 carries the UNCERTIFIED note. Pins the per-pass instruction
    routing.

    Mutation guard: swapping the two ``pass1_note`` / ``pass2_note``
    string assignments in ``classify_catch_all_with_fallback`` makes
    this test fail because the instruction note prepended to each
    payload reads the wrong pass label.
    """
    before, after = frame_paths
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

    classify_catch_all_with_fallback(_add_event(before, after, delta=600.0), ctx)

    assert len(client.calls) == 2, (
        "expected both passes to fire — pass-1 UNKNOWN drives pass-2"
    )
    pass1_payload = client.calls[0]["payload"]
    pass2_payload = client.calls[1]["payload"]
    # First text block of the user message carries the per-pass note
    # (the orchestrator inserts it at index 0 of the content list).
    pass1_first_text = pass1_payload["messages"][0]["content"][0]["text"]
    pass2_first_text = pass2_payload["messages"][0]["content"][0]["text"]

    assert "PASS 1 of 2" in pass1_first_text, (
        "pass-1 note must label the pass — operators read this in raw "
        "Anthropic logs to triage which pass yielded which result"
    )
    assert "CERTIFIED" in pass1_first_text, (
        "pass-1 note must say CERTIFIED — distinguishes from pass-2's "
        "UNCERTIFIED note even when the model doesn't read either label"
    )
    assert "PASS 2 of 2" in pass2_first_text, (
        "pass-2 note must label the pass"
    )
    assert "UNCERTIFIED" in pass2_first_text, (
        "pass-2 note must say UNCERTIFIED — the certify-on-pass-2-match "
        "auto-import semantics depend on this distinction"
    )

    # Defense in depth: pass-1 note must NOT contain pass-2's wording
    # and vice versa (catches a swap regression even if both labels
    # were collapsed to a single template).
    assert "PASS 2 of 2" not in pass1_first_text
    assert "PASS 1 of 2" not in pass2_first_text


# ---------------------------------------------------------------------------
# Audit B-HIGH-3 SKIP rationale (2026-05-04, documented for future reference).
#
# The audit suggested an opt-in live-SDK smoke test for
# ``classify_catch_all_with_fallback`` — analogous to
# ``test_live_anthropic_smoke`` in ``test_classify.py``. We deliberately
# do NOT add one for the orchestrator. Reasoning:
#
#   * The single-pass live test in ``test_classify.py`` already
#     exercises the Anthropic SDK boundary end-to-end on every release;
#     a second opt-in test here would burn API quota for the same
#     coverage.
#   * The orchestrator's value-add over the single-pass classifier is
#     entirely in its FALLBACK LOGIC (pass-1 → pass-2 routing, certify
#     auto-import gating). That logic is unit-tested above with a
#     scripted fake client — driving it through a real model adds
#     cost (~2 API calls per CI run) without adding coverage.
#   * A regression in the SDK boundary itself would already fail the
#     existing live smoke test.
#
# If the orchestrator EVER acquires SDK-specific quirks (e.g. its own
# retry/timeout config, a model-version pin different from the single-
# pass path, custom multipart shaping) — add the live smoke test then.
# Until that happens it would be testing the same boundary twice.
# ---------------------------------------------------------------------------
