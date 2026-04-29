#!/usr/bin/env python3
"""Symmetry-matrix audit (lens L1).

Walks the codebase emitting an ``(entity x feature)`` grid as JSON +
markdown. The grid pins the systemic "feature exists for entity A but
not entity B" class of bugs (catch-all single-frame classifier
orphaned, live_scale auto-register missing on Pi, etc).

Each cell is one of:

    "present"  — implementation found
    "missing"  — implementation NOT found and not waived
    "waived"   — listed in MERGED §7 / WAIVERS

A "missing" cell becomes a finding. The script exits non-zero iff at
least one finding is recorded.

Outputs:

    .verify/audit_symmetry_matrix.json   machine-readable artifact
    .verify/audit_symmetry_matrix.md     human-readable report
                                          (printed to stdout in tty
                                           mode; --quiet suppresses)

Usage::

    python3 scripts/audit_symmetry_matrix.py
    python3 scripts/audit_symmetry_matrix.py --json /tmp/out.json
    python3 scripts/audit_symmetry_matrix.py --quiet

Determinism contract: identical repo state → byte-identical JSON +
markdown (sorted keys, sorted entities, sorted features, no wall-clock
data).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Entity + Feature taxonomy
# ---------------------------------------------------------------------------
#
# Entities are the three shelf "kinds" the system understands plus their
# Pi-local synonyms. The matrix detects the asymmetry that's bitten the
# product before — e.g. cloud says "live_scale" while Pi says
# "single_item" and the translator drops a column.

# Each feature is implemented as a probe function that returns True iff
# the entity has that feature wired. Probes do NOT execute code — they
# scan source files. This keeps the audit fast and side-effect-free.

# ---------------------------------------------------------------------------
# Source-file readers (fail soft so a renamed file produces a finding,
# not a crash).
# ---------------------------------------------------------------------------


def _read(rel: str) -> str:
    p = REPO_ROOT / rel
    try:
        return p.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


# Lazy cache so each probe pays the I/O once.
_FILE_CACHE: dict[str, str] = {}


def src(rel: str) -> str:
    if rel not in _FILE_CACHE:
        _FILE_CACHE[rel] = _read(rel)
    return _FILE_CACHE[rel]


# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------
#
# A probe takes the entity name and returns True iff the feature is
# implemented for that entity. Probe names map to the feature column
# label.


def _kind_present_in(text: str, entity: str) -> bool:
    """Quoted occurrence of the entity kind."""
    return bool(re.search(rf"['\"]{re.escape(entity)}['\"]", text))


def _kind_word_in(text: str, entity: str) -> bool:
    """Word-boundary occurrence of the entity kind.

    Used by probes that scan template / HTML / URL contexts where the
    kind appears as a bare token (e.g. ``shelf=catch_all`` query
    string, ``id="live-shelf-preview"`` element id, jinja conditional
    ``{% if catch_all_enabled %}``). ``catch_all``, ``live_shelf``,
    ``live_scale``, ``single_item`` are unique enough as identifiers
    that a word-boundary match has very low false-positive risk; we
    deliberately accept hyphen variants for HTML element ids by
    swapping ``_`` ↔ ``-`` and matching either form.
    """
    pattern = re.escape(entity).replace("_", "[-_]")
    return bool(re.search(rf"(?<![A-Za-z0-9]){pattern}(?![A-Za-z0-9])", text))


def probe_apply_shelf_event_branch(entity: str) -> bool:
    """Cloud: ``private.apply_shelf_event`` has a branch handling this kind."""
    text = "\n".join(
        src(p)
        for p in (
            "supabase/migrations/20260419050000_shelf_ingest_hardening.sql",
            "supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql",
            "supabase/migrations/20260424090000_shelf_invariants.sql",
        )
    )
    return _kind_present_in(text, entity)


def probe_outbox_emit_helper(entity: str) -> bool:
    """Pi: cloud_outbox emit path mentions this kind."""
    text = "\n".join(
        src(p)
        for p in (
            "hardware/live-shelf/server/cloud/integration.py",
            "hardware/live-shelf/server/cloud/outbox.py",
            "hardware/live-shelf/server/cloud/_kind_translate.py",
        )
    )
    return _kind_present_in(text, entity)


def probe_pi_handler(entity: str) -> bool:
    """Pi: a handler / dispatch path mentions this kind."""
    text = "\n".join(
        src(p)
        for p in (
            "hardware/live-shelf/server/handlers/scale_events.py",
            "hardware/live-shelf/server/handlers/weight.py",
            "hardware/live-shelf/server/intake/routes.py",
        )
    )
    return _kind_present_in(text, entity)


def probe_pi_storage_table(entity: str) -> bool:
    """Pi: the SQLite schema has a CHECK constraint listing this kind."""
    text = src("hardware/live-shelf/server/storage/schema.sql")
    return _kind_present_in(text, entity)


def probe_cloud_pairings_sync(entity: str) -> bool:
    """Pi: pairings_sync_poller (or its translation table) mentions this kind.

    The poller centralised cloud↔Pi vocabulary translation in
    ``cloud/_kind_translate.py`` (Phase 1 audit L10/HIGH fix). Both files
    count for symmetry purposes — the poller delegates to the table and
    re-quoting every literal in both files would duplicate the source of
    truth.
    """
    text = "\n".join(
        src(p)
        for p in (
            "hardware/live-shelf/server/cloud/pairings_sync_poller.py",
            "hardware/live-shelf/server/cloud/_kind_translate.py",
        )
    )
    return _kind_present_in(text, entity)


def probe_classifier_prompt(entity: str) -> bool:
    """Classifier prompt scaffolding mentions this kind."""
    text = "\n".join(
        src(p)
        for p in (
            "hardware/live-shelf/server/classifier/prompt.py",
            "hardware/live-shelf/server/classifier/classify.py",
            "hardware/live-shelf/server/classifier/candidate_pool.py",
            "hardware/live-shelf/server/classifier/cloud_candidate_source.py",
        )
    )
    return _kind_present_in(text, entity)


def probe_pi_ui_section(entity: str) -> bool:
    """Pi-served UI templates render this kind somewhere.

    Templates use the kind as a bare token in URL query strings
    (``shelf=catch_all``), HTML element ids (``id="live-shelf-preview"``)
    and jinja conditionals (``{% if catch_all_enabled %}``) rather than
    as a Python-quoted literal, so we match by word boundary. Hyphen
    variants of underscore-cased kinds count (HTML id convention).
    """
    base = REPO_ROOT / "hardware" / "live-shelf" / "server" / "web" / "templates"
    if not base.is_dir():
        return False
    for path in sorted(base.glob("*.html")):
        try:
            if _kind_word_in(path.read_text(encoding="utf-8"), entity):
                return True
        except OSError:
            continue
    return False


def probe_pgtap_invariant(entity: str) -> bool:
    """At least one pgTAP invariant test references this kind by literal."""
    inv_dir = REPO_ROOT / "supabase" / "tests" / "invariants"
    if not inv_dir.is_dir():
        return False
    for path in sorted(inv_dir.glob("*.test.sql")):
        if _kind_present_in(path.read_text(encoding="utf-8"), entity):
            return True
    return False


def probe_auto_register(entity: str) -> bool:
    """Cloud edge fn auto-registers a device row for this kind on first heartbeat."""
    text = src("supabase/functions/shelf-ingest/index.ts")
    # Auto-register paths are conditional on shelf_id / kind literals.
    return _kind_present_in(text, entity)


def probe_weight_sync_to_cloud(entity: str) -> bool:
    """``weight_sync_poller`` (Pi) mentions this kind so cloud weight survives a Pi reboot."""
    text = src("hardware/live-shelf/server/cloud/weight_sync_poller.py")
    return _kind_present_in(text, entity)


def probe_harness_scenario(entity: str) -> bool:
    """At least one harness scenario filename mentions this kind."""
    sc_dir = REPO_ROOT / "scripts" / "harness" / "scenarios"
    if not sc_dir.is_dir():
        return False
    needle = entity.lower()
    return any(needle in p.name for p in sc_dir.glob("*.py"))


PROBES: list[tuple[str, Callable[[str], bool]]] = [
    ("apply_shelf_event_branch", probe_apply_shelf_event_branch),
    ("auto_register", probe_auto_register),
    ("classifier_prompt", probe_classifier_prompt),
    ("cloud_pairings_sync", probe_cloud_pairings_sync),
    ("harness_scenario", probe_harness_scenario),
    ("outbox_emit_helper", probe_outbox_emit_helper),
    ("pgTAP_invariant", probe_pgtap_invariant),
    ("pi_handler", probe_pi_handler),
    ("pi_storage_table", probe_pi_storage_table),
    ("pi_UI_section", probe_pi_ui_section),
    ("weight_sync_to_cloud", probe_weight_sync_to_cloud),
]

ENTITIES: list[str] = sorted(["live_shelf", "catch_all", "live_scale", "single_item"])

# Cells we accept as missing (e.g. by spec). Flat list; render-time looks
# up the (entity, feature) tuple. Keep this short — every entry should
# have a one-line rationale referencing AUDIT_STRATEGY_MERGED.md or a
# design doc.
WAIVERS: dict[tuple[str, str], str] = {
    # live_scale is the cloud-side name; single_item is the Pi-side
    # alias. Mirrors translate at the boundary, so each one is allowed
    # to be absent in the OTHER side's storage.
    ("single_item", "apply_shelf_event_branch"): (
        "translated to 'live_scale' at edge fn entry — see _kind_translate.py"
    ),
    ("live_scale", "pi_storage_table"): (
        "Pi schema uses 'single_item' literal; translator handles boundary"
    ),
    ("live_scale", "pi_handler"): (
        "Pi handlers dispatch on 'single_item'; cloud term reserved for outbound payloads"
    ),
    ("live_scale", "outbox_emit_helper"): (
        "outbox payloads use Pi 'single_item' kind, translator rewrites at /event POST"
    ),
    ("live_scale", "pi_UI_section"): (
        "Pi dashboard renders 'single_item' panels; cloud term not user-facing"
    ),
    ("live_scale", "weight_sync_to_cloud"): (
        "weight_sync_poller is Pi-internal and uses Pi 'single_item' literal"
    ),
    # Catch-all has its own delta-capture stream
    # (catch_all_first_measurement / _second_measurement event pair, see
    # migrations 20260427120000 / 20260427130000) so the
    # weight_sync_poller deliberately filters it OUT to avoid duplicate
    # cloud events. See poller docstring "Scope" section.
    ("catch_all", "weight_sync_to_cloud"): (
        "catch-all uses delta-capture event pair; weight_sync_poller scope excludes it"
    ),
    # The classifier is camera-driven (Anthropic vision over a
    # before/after frame pair). Live-scale rigs (cloud term `live_scale`,
    # Pi term `single_item`) are HX711 load-cell-only with no camera, so
    # the classifier prompt machinery genuinely doesn't apply to either
    # synonym. See classifier/classify.py: only `live_shelf` and
    # `catch_all` shelf_ids reach the prompt builder.
    ("live_scale", "classifier_prompt"): (
        "live_scale is cameraless (HX711-only); classifier is shelf/catch_all only"
    ),
    ("single_item", "classifier_prompt"): (
        "Pi-side alias of live_scale; cameraless rig, no classifier prompt"
    ),
    # Auto-register lives in the cloud edge function
    # (`supabase/functions/shelf-ingest/index.ts`) which speaks the cloud
    # vocabulary `{live_shelf, live_scale, catch_all}`. The Pi-only
    # `single_item` literal genuinely never appears in the edge fn — the
    # translator at scale_events.py:3279 maps it to `live_scale` before
    # the cloud sees it.
    ("single_item", "auto_register"): (
        "auto-register is cloud-side (uses 'live_scale'); 'single_item' is Pi-only literal"
    ),
}


# ---------------------------------------------------------------------------
# Finding model + render
# ---------------------------------------------------------------------------


@dataclass
class Finding:
    entity: str
    feature: str
    severity: str
    description: str

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Cell:
    entity: str
    feature: str
    status: str  # "present" | "missing" | "waived"
    detail: str = ""

    def as_dict(self) -> dict:
        return asdict(self)


def build_matrix() -> tuple[list[Cell], list[Finding]]:
    cells: list[Cell] = []
    findings: list[Finding] = []
    for entity in ENTITIES:
        for feature, probe in PROBES:
            present = bool(probe(entity))
            key = (entity, feature)
            if present:
                cells.append(Cell(entity=entity, feature=feature, status="present"))
            elif key in WAIVERS:
                cells.append(
                    Cell(entity=entity, feature=feature, status="waived", detail=WAIVERS[key])
                )
            else:
                cells.append(Cell(entity=entity, feature=feature, status="missing"))
                findings.append(
                    Finding(
                        entity=entity,
                        feature=feature,
                        severity="HIGH",
                        description=(
                            f"Entity `{entity}` has no implementation cell for "
                            f"feature `{feature}` and the gap is not waived in "
                            "AUDIT_STRATEGY_MERGED.md §7. Either implement, or "
                            "add an explicit WAIVERS entry with rationale."
                        ),
                    )
                )
    cells.sort(key=lambda c: (c.entity, c.feature))
    findings.sort(key=lambda f: (f.entity, f.feature))
    return cells, findings


def render_markdown(cells: list[Cell], findings: list[Finding]) -> str:
    lines = [
        "# Symmetry Matrix (Lens L1)",
        "",
        "Generated by `scripts/audit_symmetry_matrix.py`. Each cell shows whether "
        "an entity has the named feature wired. `missing` cells become findings "
        "unless explicitly waived in `AUDIT_STRATEGY_MERGED.md §7`.",
        "",
        "Legend: `+` present, `-` missing, `~` waived.",
        "",
    ]
    features = [name for name, _ in sorted(PROBES, key=lambda kv: kv[0])]
    header = ["entity"] + features
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join("---" for _ in header) + " |")
    by_pair = {(c.entity, c.feature): c for c in cells}
    sym = {"present": "+", "missing": "-", "waived": "~"}
    for entity in ENTITIES:
        row = [entity]
        for feat in features:
            cell = by_pair.get((entity, feat))
            row.append(sym.get(cell.status if cell else "", "?"))
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")

    if findings:
        lines.append(f"## Findings ({len(findings)})")
        lines.append("")
        for f in findings:
            lines.append(f"### [{f.severity}] {f.entity} :: {f.feature}")
            lines.append("")
            lines.append(f.description)
            lines.append("")
    else:
        lines.append("## Findings")
        lines.append("")
        lines.append("None — every (entity x feature) cell is present or waived.")
        lines.append("")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--json",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_symmetry_matrix.json"),
        help="Path to write JSON artifact (default: .verify/audit_symmetry_matrix.json)",
    )
    ap.add_argument(
        "--md",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_symmetry_matrix.md"),
        help="Path to write markdown report",
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    cells, findings = build_matrix()

    artifact = {
        "gate": "audit_symmetry_matrix",
        "lens": "L1",
        "entities": ENTITIES,
        "features": [name for name, _ in sorted(PROBES, key=lambda kv: kv[0])],
        "cells": [c.as_dict() for c in cells],
        "findings": [f.as_dict() for f in findings],
    }
    out_json = Path(args.json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    md = render_markdown(cells, findings)
    out_md = Path(args.md)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md, encoding="utf-8")

    if not args.quiet:
        print(md)
        print(f"\nWrote {out_json.relative_to(REPO_ROOT)} ({len(findings)} findings)")

    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
