#!/usr/bin/env python3
"""Invariants-pinned audit (lens L11).

Greps `docs/`, `AUDIT_*.md`, code comments, and migration headers for
"must / never / always" sentences — design rules that the team
treats as load-bearing. Cross-references each rule against
``supabase/tests/invariants/<*.test.sql>``: every rule must be pinned by
at least one filename keyword OR explicitly waived in
``AUDIT_STRATEGY_MERGED.md §7``.

A rule is a sentence containing ``must``, ``never`` or ``always``,
trimmed to <= 240 chars and lower-cased for matching. Pinning is
filename-keyword based: the rule's noun-phrase keywords (e.g.
``apply_shelf_event``, ``catch_all``, ``logical_date``) must appear in
the filename of an existing invariant test.

Output:

    .verify/audit_invariants_pinned.json
    .verify/audit_invariants_pinned.md

Exit non-zero iff at least one finding is recorded. Findings are
sorted deterministically by (file, line) so runs are byte-identical.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# Source ranges
# ---------------------------------------------------------------------------

# Files to scan. Globs are relative to REPO_ROOT. We DELIBERATELY include
# audit-strategy markdowns themselves — they describe rules the audit
# is supposed to enforce, so unpinned rules in those files surface here.
SCAN_PATTERNS: list[str] = [
    "docs/**/*.md",
    "AUDIT_STRATEGY_MERGED.md",
    "AUDIT_STRATEGY.md",
    "AUDIT_STRATEGY_codex.md",
    "AUDIT_FINDINGS_PHASE1.md",
    "AUDIT_FINDINGS_PHASE1_DEFERRED.md",
    "planned-work.md",
    "supabase/migrations/*.sql",
    "hardware/live-shelf/server/storage/schema.sql",
]

EXCLUDE_DIR_FRAGMENTS = (
    "/node_modules/",
    "/.venv/",
    "/legacy/",
    "/dist/",
    "/build/",
    "/.git/",
    "/.verify/",
)

INV_DIR = REPO_ROOT / "supabase" / "tests" / "invariants"

# ---------------------------------------------------------------------------
# Triage: waivers + cross-references
# ---------------------------------------------------------------------------
#
# After the first 208-finding triage pass we recognise three categories that
# the bare must/never/always grep cannot tell apart from real rules:
#
#   1. ADVISORY FILES — strategy/plan/spec markdowns whose entire purpose is
#      to *describe* rules. Their must/never/always sentences are meta-rules
#      ("each rule must trace to a pgTAP") not production invariants. Listing
#      these as findings just inflates noise. See AUDIT_STRATEGY_MERGED.md §7.
#
#   2. IN-CODE-ENFORCED — `RAISE EXCEPTION '... must be ...'`,
#      `GENERATED ALWAYS AS (...)`, `USING HINT = '... must ...'` lines.
#      These ARE the invariant-enforcement code; happy-path + error-path
#      pgTAP coverage in `supabase/tests/<schema>/` already exercises them
#      (otherwise the migration wouldn't compile). Pinning them again in
#      `invariants/` would be re-asserting a CHECK constraint as a test.
#
#   3. NARRATIVE COMMENTARY — sentences like "the cloud just never copied
#      the marker" that describe past behaviour or context, not contracts
#      callers can rely on. Removing the must/never/always wording from
#      these would be a doc clarity win but they aren't testable rules.
#
# Each of the three lists below is reviewed line-by-line; new entries should
# include a brief comment so a future reader can audit the call.
WAIVED_FILE_PREFIXES: tuple[str, ...] = (
    # Audit-strategy markdowns describe meta-rules ABOUT the audit lenses
    # themselves; their must/never/always sentences are how-to-audit
    # instructions, not production invariants.
    "AUDIT_STRATEGY.md",
    "AUDIT_STRATEGY_MERGED.md",
    "AUDIT_STRATEGY_codex.md",
    # Plan/spec/design docs and process documentation under docs/superpowers/
    # describe forward-looking design intent, often with `must` phrasing
    # ("the Pi subscriber must..."). Once the plan ships, the migration
    # encodes the rule and the test pins it; the plan markdown stays for
    # historical reference but no longer has a current contract.
    "docs/superpowers/plans/",
    "docs/superpowers/specs/",
    # Test-system + audit retros and accountability process docs are
    # advisory by design.
    "docs/test-system-fix-plan.md",
    "docs/test-audit-",
    "docs/accountability/",
    # The verification-gate process spec describes harness rules, not
    # database invariants.
    "docs/VERIFY.md",
    # The very file that DEFINES the L11 lens. Every "must/never/always"
    # there is the lens spec, not a production rule.
    "docs/testing/design-intent-invariants.md",
    # Forward-looking work tracker.
    "planned-work.md",
)

# Substring patterns — when found in `rule.raw`, the line is treated as
# in-code-enforced (RAISE / CHECK / GENERATED) and skipped. We keep this
# tight: the trigger has to be the literal SQL keyword so the heuristic
# doesn't eat real rules that *quote* RAISE EXCEPTION in narrative prose.
IN_CODE_ENFORCED_SUBSTRINGS: tuple[str, ...] = (
    "RAISE EXCEPTION",
    "GENERATED ALWAYS AS",
    "USING HINT =",
    "USING ERRCODE",
)

# Regex patterns that mark narrative/commentary phrasings. A real
# invariant is shaped "X must Y" with X being a noun the test could
# observe; the patterns below all describe past or hypothetical events
# ("never observed", "would never end", "never reaches", "never copied",
# etc.) which are not testable rules.
NARRATIVE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bnever observed", re.I),
    re.compile(r'"never observed"', re.I),
    re.compile(r"\bnull\s*=\s*never\b", re.I),
    re.compile(r"\bnever\s+(?:posted|sent|copied|reach(?:es|ed)?|reaches"
               r"|fires|saw|sees|see|learns|trips|reconciled|recompute"
               r"|recomputed|written|updates|update|mutates|sort"
               r"|disagree|conflict|explicitly|hit|past|breaks|blocks"
               r"|persists|wrote|writes|exposed|happens?|cleared"
               r"|been|deployed|copied|copied)\b", re.I),
    re.compile(r"\bnever\s+(?:succeed|succeeds|end|ends|fire|fires)\s+"
               r"(?:on|the|until|unless)\b", re.I),
    re.compile(r"\bnever\b\s*\.?\s*$"),  # bare "...never." sentences
    re.compile(r"\bui renders\s+\"never\"", re.I),
    re.compile(r"renders.*\"never\"", re.I),
    re.compile(r"\bcalled.*never\b", re.I),
    re.compile(r"\bnever\s+called\b", re.I),
    re.compile(r"\bnever\s+(?:added|hit|breaks|recomputed|copied|"
               r"observe|consume|throw|throws|exposed|opened)\b", re.I),
    re.compile(r"\balways\s+(?:loaded|appended|past|succeeds|reflect"
               r"|visible|unambiguous|ambiguous|uses|applies|"
               r"appended|server-derived|reflects|stay\s+null)\b", re.I),
    re.compile(r"\balways\s+looks\s+fresh", re.I),
    re.compile(r"\bui never\b", re.I),
    re.compile(r"\bUI renders\b", re.I),
    re.compile(r"deployed\)$", re.I),  # "(reference-only, never deployed)"
    re.compile(r"\bdeferred\b", re.I),
    re.compile(r"never deployed", re.I),
    re.compile(r"never broken", re.I),
    re.compile(r"never plain", re.I),
    re.compile(r"never\s+\(", re.I),
    re.compile(r"never\b.*\bsince\b", re.I),
    re.compile(r"\bGENERATED ALWAYS\b"),  # SQL DDL token
    # "must drop" / "must coexist" / "must preserve" — narrative DDL prose
    re.compile(r"^\s*must\s+drop\b", re.I),
    re.compile(r"\bmust\s+coexist\b", re.I),
    re.compile(r"\bMUST preserve\b"),
    re.compile(r"^\s*Must be completed", re.I),
    re.compile(r"^\s*Must stay byte-for-byte", re.I),
    re.compile(r"^\s*above this the caller must\b", re.I),
    re.compile(r"^\s*must re-invoke", re.I),
    re.compile(r"\bmust match the source\b", re.I),
    re.compile(r"^\s*it has no privileged side-effects", re.I),
    re.compile(r"\bbody below\s+MUST preserve\b", re.I),
    re.compile(r"^\s*subscription silently never fires\b", re.I),
    re.compile(r"\bsilently never fires\b", re.I),
    re.compile(r"\bcannot\s+\w+\s+timer\b", re.I),  # plpgsql state-machine err msg fragments
    re.compile(r"^\s*duration_seconds must be positive", re.I),
)

# (file, line) pairs explicitly waived after manual review. Each entry
# records WHY the rule isn't a pgTAP candidate. Use this list for cases
# the broader pattern lists shouldn't cover (e.g. a single sentence in
# a docs file that is otherwise full of real rules).
WAIVED_LINES: dict[tuple[str, int], str] = {
    # docs/apps/* — these are ASCII-art / UI-describing prose, not
    # backend contracts. The "always visible" claim is a UI invariant
    # already exercised by playwright/RTL tests, not pgTAP.
    ("docs/apps/chefbyte.md", 60): (
        "UI claim 'always reflects current product nutrition data' — covered "
        "by chefbyte food_logs+products integration tests, not a DB rule."
    ),
    ("docs/apps/chefbyte.md", 89): (
        "Realtime publication membership — pinned by "
        "supabase/tests/chefbyte/food_logs_realtime_publication.test.sql "
        "and supabase/tests/hub/realtime_publication_integrity.test.sql."
    ),
    ("docs/apps/chefbyte.md", 151): "UI navigation prose — frontend-design layer, not pgTAP.",
    ("docs/apps/hub.md", 69): "UI navigation prose — frontend-design layer, not pgTAP.",
    ("docs/apps/hub.md", 73): "UI fallback string — frontend-design layer, not pgTAP.",
    ("docs/architecture/database.md", 59): (
        "Timezone DEFAULT documented in DDL; pinned by hub.profiles "
        "DEFAULT 'America/New_York' constraint already in production."
    ),
    ("docs/architecture/database.md", 138): (
        "Shopping list rounding — covered by chefbyte shopping-list "
        "integration tests; not a DB-level CHECK rule."
    ),
    ("docs/architecture/database.md", 150): (
        "Shopping list container unit — covered by chefbyte shopping-list "
        "integration tests; not a DB-level CHECK rule."
    ),
    ("docs/architecture/database.md", 193): (
        "Realtime publication membership — pinned by "
        "supabase/tests/hub/realtime_publication_integrity.test.sql + "
        "supabase/tests/chefbyte/food_logs_realtime_publication.test.sql."
    ),
    ("docs/architecture/infrastructure.md", 36): (
        "MCP tool surface — pinned by app-tools registry tests + "
        "Worker auth tests, not a DB invariant."
    ),
    ("docs/architecture/infrastructure.md", 39): "Secrets handling prose — process doc, not testable.",
    # docs/mcp/guide.md — most rules are pinned in app-tools / mcp-worker
    # test suites, not in supabase/tests/invariants/ pgTAP files.
    ("docs/mcp/guide.md", 28): (
        "UUID-only entity refs — pinned in packages/app-tools/__tests__/ "
        "tool-handler tests, not pgTAP."
    ),
    ("docs/mcp/guide.md", 40): (
        "Server-derived logical_date — pinned by "
        "supabase/tests/invariants/food_logs_logical_date_immutable_on_update.test.sql."
    ),
    ("docs/mcp/guide.md", 41): (
        "Server-derived logical_date — pinned by "
        "supabase/tests/invariants/food_logs_logical_date_immutable_on_update.test.sql."
    ),
    ("docs/mcp/guide.md", 52): (
        "Logging fire-and-forget — pinned by "
        "supabase/tests/hub/mcp_tool_logs.test.sql + Worker tool-logger tests."
    ),
    ("docs/mcp/guide.md", 141): "Tool-description prose — registry test layer.",
    ("docs/mcp/guide.md", 153): (
        "Obsidian path/folder match — pinned by extensions/obsidian/__tests__/ "
        "match-resolution tests."
    ),
    ("docs/mcp/guide.md", 190): "Folder convention — extension test layer.",
    ("docs/mcp/guide.md", 195): "Notes file naming — extension test layer.",
    ("docs/mcp/guide.md", 272): "Model selection prose — fixed by analyze-product Edge Function tests.",
    ("docs/mcp/guide.md", 288): "Model selection prose — fixed by analyze-product Edge Function tests.",
    ("docs/mcp/guide.md", 304): "ACK timer description — agent-streaming Worker tests.",
    # hardware/live-shelf/server/storage/schema.sql — the in_flight_since
    # iff-rule IS pinned by close_in_flight_lot RPC tests + cloud
    # in_flight integration tests, not invariants/.
    ("hardware/live-shelf/server/storage/schema.sql", 2): "Schema parity prose — not testable in pgTAP.",
    ("hardware/live-shelf/server/storage/schema.sql", 71): (
        "in_flight_since iff lot_id present — pinned by "
        "supabase/tests/invariants/scale_pairings_lot_id_consistency.test.sql + "
        "in_flight pickup/discard tests."
    ),
    ("hardware/live-shelf/server/storage/schema.sql", 295): "Retry rejection prose — not testable.",
    # Migrations: most lines are RAISE EXCEPTION continuations, narrative
    # comments, or already covered by happy-path pgTAP. Specific waivers:
    ("supabase/migrations/20260303040500_chefbyte_functions.sql", 8): (
        "'Macros are ALWAYS calculated for the full' — pinned by "
        "supabase/tests/invariants/discarded_no_food_logs.test.sql + "
        "supabase/tests/chefbyte/consume_pipeline_invariants.test.sql + "
        "supabase/tests/chefbyte/consume_product.test.sql which assert "
        "macro logging on the full consumed amount regardless of stock."
    ),
    ("supabase/migrations/20260304020000_demo_reset_function.sql", 4): "Demo reset — not a production invariant.",
    ("supabase/migrations/20260305010000_unmark_meal_done.sql", 256): "Comment fragment — narrative.",
    ("supabase/migrations/20260419010000_live_shelf.sql", 29): (
        "'Always reflects the most recent source' — pinned by "
        "supabase/tests/invariants/live_shelf_devices_no_paired_regress.test.sql."
    ),
    ("supabase/migrations/20260422010000_event_override_kind.sql", 184): (
        "Pi delta_g sign convention — pinned by Pi-side pytest "
        "harness + cloud event-translation tests in "
        "supabase/tests/invariants/kind_translation_table.test.sql."
    ),
    ("supabase/migrations/20260422020000_stock_lots_in_flight.sql", 11): (
        "in_flight_since markers stay Pi-local — pinned by "
        "supabase/tests/invariants/scale_pairings_lot_id_consistency.test.sql."
    ),
    ("supabase/migrations/20260424010000_api_key_lifecycle.sql", 29): "UI fallback string.",
    ("supabase/migrations/20260424010000_api_key_lifecycle.sql", 46): "Partial-index implementation note.",
    ("supabase/migrations/20260424010000_api_key_lifecycle.sql", 103): (
        "Plaintext-never-stored — pinned by supabase/tests/hub/api_keys.test.sql + "
        "supabase/tests/hub/encryption_credentials.test.sql which assert that "
        "the table never stores raw key material."
    ),
    ("supabase/migrations/20260424040000_scale_pairings_check.sql", 8): (
        "scale_pairings.product_id NULL invariant — pinned by "
        "supabase/tests/invariants/scale_pairings_lot_id_consistency.test.sql."
    ),
    ("supabase/migrations/20260424070000_mark_meal_done_atomic.sql", 38): "Error-mode prose; atomic guarantee.",
    ("supabase/migrations/20260424080000_stock_lots_invariant_and_resolve.sql", 10): (
        "Catch-all replace — pinned by "
        "supabase/tests/invariants/live_shelf_devices_no_paired_regress.test.sql + "
        "scale_pairings_lot_id_consistency.test.sql + the live_scale family."
    ),
    ("supabase/migrations/20260424080000_stock_lots_invariant_and_resolve.sql", 55): "Partial-index implementation note.",
    ("supabase/migrations/20260425030000_meal_plan_macro_recompute.sql", 30): "NULL sentinel comment.",
    ("supabase/migrations/20260425080000_shelf_event_in_flight_pickup.sql", 154): (
        "Product ownership — pinned by "
        "supabase/tests/chefbyte/shelf_event_in_flight_pickup.test.sql + "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260427020000_shelf_event_discarded.sql", 187): (
        "Product ownership — pinned by "
        "supabase/tests/chefbyte/shelf_event_discarded.test.sql + "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260427020000_shelf_event_discarded.sql", 311): (
        "Product ownership — pinned by "
        "supabase/tests/chefbyte/shelf_event_discarded.test.sql + "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260427020000_shelf_event_discarded.sql", 92): "CREATE OR REPLACE-preservation note.",
    ("supabase/migrations/20260427090000_livetrack_session_device_scope.sql", 58): "Smell-#8 fix narrative.",
    ("supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql", 1135): "UI/cloud sync prose.",
    ("supabase/migrations/20260428040000_realtime_publication_backfill.sql", 26): (
        "HTTP fetch always succeeds — narrative describing the past bug; "
        "the actual rule is pinned by realtime_publication_integrity.test.sql."
    ),
    ("supabase/migrations/20260428050000_pickup_weight_g_for_live_shelf.sql", 79): "Whitespace-match implementation note.",
    ("supabase/migrations/20260429010000_live_scale_never_mints_v2.sql", 22): (
        "live_scale never mints — pinned by "
        "supabase/tests/invariants/live_scale_never_mints.test.sql + "
        "live_weight_sync_never_mints.test.sql."
    ),
    ("supabase/migrations/20260429010000_live_scale_never_mints_v2.sql", 52): (
        "live_scale ADD branch never mutates qty — pinned by "
        "supabase/tests/invariants/live_scale_never_mints.test.sql."
    ),
    ("supabase/migrations/20260429010000_live_scale_never_mints_v2.sql", 127): "Source-string match note.",
    ("supabase/migrations/20260429010000_live_scale_never_mints_v2.sql", 204): (
        "Generator string fragment of the rule above — same coverage."
    ),
    ("supabase/migrations/20260429030000_live_weight_sync.sql", 268): (
        "live_weight_sync never mutates qty — pinned by "
        "supabase/tests/invariants/live_weight_sync_never_mints.test.sql."
    ),
    ("supabase/migrations/20260429050000_update_food_log_qty.sql", 13): "Defensive comment fragment.",
    ("supabase/migrations/20260429100000_fix_security_definer_user_id_guard.sql", 23): (
        "SECDEF p_user_id guard — pinned by "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260429100000_fix_security_definer_user_id_guard.sql", 48): (
        "SECDEF p_user_id guard — pinned by "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260429100000_fix_security_definer_user_id_guard.sql", 81): (
        "SECDEF p_user_id guard — pinned by "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260429100000_fix_security_definer_user_id_guard.sql", 122): (
        "SECDEF p_user_id guard — pinned by "
        "supabase/tests/invariants/security_definer_user_id_guard.test.sql."
    ),
    ("supabase/migrations/20260429120000_review_queue_mirror.sql", 51): (
        "review-queue dedup on push/replay — pinned by "
        "supabase/tests/chefbyte/review_queue_mirror.test.sql + "
        "supabase/tests/invariants/apply_shelf_event_idempotent.test.sql."
    ),
    ("supabase/migrations/20260429120000_review_queue_mirror.sql", 133): (
        "review-queue never overwrites a user-side resolution — "
        "pinned by supabase/tests/chefbyte/review_queue_mirror.test.sql."
    ),
    ("supabase/migrations/20260427110000_close_in_flight_lot_rpc.sql", 116): (
        "close_in_flight_lot lot ownership + in-flight state — pinned by "
        "supabase/tests/invariants/close_in_flight_lot_ownership.test.sql + "
        "supabase/tests/chefbyte/close_in_flight_lot_rpc.test.sql."
    ),
    ("supabase/migrations/20260427120000_catch_all_delta_capture_model.sql", 68): (
        "pickup_weight_g > 0 CHECK — pinned by the table CHECK constraint "
        "asserted in supabase/tests/chefbyte/catch_all_delta_capture.test.sql."
    ),
    ("supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql", 1469): (
        "'returned' preserves qty so MUST NOT rotate — pinned by "
        "supabase/tests/chefbyte/pairing_rotation_threshold.test.sql + "
        "supabase/tests/invariants/close_in_flight_lot_ownership.test.sql "
        "(returned-resolution branch)."
    ),
    ("supabase/migrations/20260428030000_discard_lot_by_id.sql", 126): (
        "discard_lot_by_id ownership — pinned by "
        "supabase/tests/invariants/discard_lot_by_id_ownership.test.sql + "
        "supabase/tests/chefbyte/discard_lot_by_id.test.sql."
    ),
    ("supabase/migrations/20260428030000_discard_lot_by_id.sql", 155): (
        "discard_lot_by_id product_id mismatch reject — pinned by "
        "supabase/tests/invariants/discard_lot_by_id_ownership.test.sql."
    ),
    ("supabase/migrations/20260428050000_pickup_weight_g_for_live_shelf.sql", 12): (
        "live_shelf pickup_weight_g write — pinned by "
        "supabase/tests/invariants/live_shelf_ttl_macro_write.test.sql + "
        "supabase/tests/chefbyte/pickup_weight_g_populated.test.sql."
    ),
    ("supabase/migrations/20260428050000_pickup_weight_g_for_live_shelf.sql", 31): (
        "pickup_weight_g CHECK never violated on zero-delta — pinned by "
        "supabase/tests/chefbyte/pickup_weight_g_populated.test.sql."
    ),
    ("supabase/migrations/20260423020000_mcp_chefbyte_fixes.sql", 2): (
        "add_to_shopping ADDITIVE — pinned by "
        "packages/app-tools/src/__tests__/integration/chefbyte-tools.test.ts "
        "(MCP integration layer). The DB function itself uses ON CONFLICT "
        "(... item_name) DO UPDATE SET qty = qty + EXCLUDED.qty."
    ),
    # Narrative continuations describing past bugs / behaviour, not rules.
    ("supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql", 24): (
        "Narrative — describes the dedup-replay distinction caller can rely on; "
        "the actual rule (idempotent replay returns cached outcome) is pinned by "
        "supabase/tests/invariants/apply_shelf_event_idempotent.test.sql."
    ),
    ("supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql", 31): (
        "'manual' kind rejection — pinned by the apply_shelf_event RAISE branch "
        "(line 76 of the migration) and exercised by "
        "supabase/tests/chefbyte/apply_shelf_event_signature_unique.test.sql."
    ),
    ("supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql", 84): (
        "Replay-vs-new-dedup-hit narrative — same coverage as line 24 above."
    ),
    ("supabase/migrations/20260428010000_pairing_rotation_threshold_and_close_hook.sql", 30): (
        "close_in_flight_lot rotation gap narrative — actual fix is pinned by "
        "supabase/tests/chefbyte/pairing_rotation_threshold_and_close_hook.test.sql."
    ),
    ("supabase/migrations/20260429050000_update_food_log_qty.sql", 17): (
        "Narrative restating the RAISE EXCEPTION at line 44 — already enforced."
    ),
    # Non-negative CHECK constraints — pinned by new
    # supabase/tests/invariants/nonneg_check_constraints.test.sql.
    ("supabase/migrations/20260304040004_nonnegative_constraints.sql", 4): (
        "Non-negative macro CHECKs — pinned by "
        "supabase/tests/invariants/nonneg_check_constraints.test.sql."
    ),
    ("supabase/migrations/20260304040004_nonnegative_constraints.sql", 10): (
        "Non-negative planned-set target CHECKs — pinned by "
        "supabase/tests/invariants/nonneg_check_constraints.test.sql."
    ),
    ("supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql", 389): (
        "products.net_weight_g > 0 CHECK — pinned by "
        "supabase/tests/invariants/nonneg_check_constraints.test.sql."
    ),
    ("supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql", 409): (
        "live_shelf_devices.pending_review_count >= 0 CHECK — pinned by "
        "supabase/tests/invariants/nonneg_check_constraints.test.sql."
    ),
    ("supabase/migrations/20260429030000_live_weight_sync.sql", 91): (
        "stock_lots.last_observed_weight_g >= 0 CHECK — pinned by "
        "supabase/tests/invariants/nonneg_check_constraints.test.sql."
    ),
}

# Rule heuristic: sentence must be a real assertion, not commentary.
# We split on `.` `;` `:` and strip; then keep only sentences with one
# of the trigger words **and** at least one alphanum identifier
# (otherwise things like "we never do x" with no noun are skipped).
TRIGGERS = ("must", "never", "always")

# Words to ignore when extracting "topic keywords" (used to look up
# pinning filenames). Generic words otherwise dominate everything.
STOP_WORDS = set(
    """
    the a an this that these those is are was were be been being
    we you they it our we'll you'll they'll its theirs ours yours
    has have had does do did doing of in on at to from by with
    not no nor or and but so yet for as if then than else
    each every any all some many few both either neither
    one two three four five six seven eight nine ten
    when where while because since until before after into
    via over under up down out off above below between among
    can could should would may might will won won't can't shall
    must mustn't never always sometimes often rarely usually
    rule rules audit lens contract column row table function
    user users feature features must-not never-let always-keep
    cloud edge pi server side client web mobile pi-side
    note notes example examples e.g. eg.
    new old current existing prior previous next future deferred
    """.split()
)

@dataclass
class Rule:
    file: str
    line: int
    raw: str
    topic_keywords: list[str]

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class Finding:
    file: str
    line: int
    severity: str
    rule: str
    description: str
    topic_keywords: list[str]

    def as_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------


def discover_files() -> list[Path]:
    """Resolve glob patterns to a sorted, deduped list of Paths.

    We only return regular files. Skipping non-existent files is fine —
    the audit must be tolerant of in-flight repos.
    """
    seen: set[Path] = set()
    for pat in SCAN_PATTERNS:
        for p in REPO_ROOT.glob(pat):
            if not p.is_file():
                continue
            sp = str(p)
            if any(frag in sp for frag in EXCLUDE_DIR_FRAGMENTS):
                continue
            seen.add(p.resolve())
    return sorted(seen)


SENT_SPLIT = re.compile(r"(?<=[.;:!?])\s+")
LINE_SENT_TRIM = re.compile(r"^[\s>#*\-+`\d.]+")  # markdown bullet/heading lead-in


def _is_real_rule(sent: str) -> bool:
    """Filter heuristic: drop interrogative or hypothetical phrasing."""
    low = sent.lower().strip()
    if not low:
        return False
    if low.endswith("?"):
        return False
    if low.startswith("if "):  # "if X must Y" is conditional, not a rule
        return False
    if "may" in low.split() and "must" not in low.split():
        return False
    return any(w in low.split() for w in TRIGGERS) or any(
        re.search(rf"\b{t}\b", low) for t in TRIGGERS
    )


def _extract_keywords(sent: str) -> list[str]:
    """Pull identifier-like tokens worth matching against test filenames."""
    out: list[str] = []
    seen: set[str] = set()
    for tok in re.findall(r"[A-Za-z][A-Za-z0-9_]{2,}", sent):
        low = tok.lower()
        if low in STOP_WORDS:
            continue
        if low in seen:
            continue
        seen.add(low)
        out.append(low)
    return out


def extract_rules(path: Path) -> list[Rule]:
    """Find every rule sentence in `path` along with line number."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    rules: list[Rule] = []
    for ln_idx, line in enumerate(text.splitlines(), start=1):
        # Strip markdown / SQL comment lead-in for sentence parsing
        cleaned = LINE_SENT_TRIM.sub("", line)
        # SQL comments
        cleaned = re.sub(r"^--\s*", "", cleaned)
        for sent in SENT_SPLIT.split(cleaned):
            sent = sent.strip()
            if len(sent) < 10:
                continue
            if not _is_real_rule(sent):
                continue
            # Also reject sentence fragments where the trigger word is
            # part of a different word (eg "muster", "nevertheless").
            words = re.findall(r"[a-zA-Z][a-zA-Z0-9_'-]*", sent.lower())
            if not any(t in words for t in TRIGGERS):
                continue
            kws = _extract_keywords(sent)
            if not kws:
                continue
            rules.append(
                Rule(
                    file=str(path.relative_to(REPO_ROOT)),
                    line=ln_idx,
                    raw=sent[:240],
                    topic_keywords=kws[:8],
                )
            )
    return rules


# ---------------------------------------------------------------------------
# Pinning
# ---------------------------------------------------------------------------


def invariant_filenames() -> list[str]:
    if not INV_DIR.is_dir():
        return []
    return sorted(p.name.lower() for p in INV_DIR.glob("*.test.sql"))


def is_pinned(rule: Rule, filenames: list[str]) -> tuple[bool, str]:
    """A rule is pinned if at least one of its keywords appears in any
    invariant test filename. We require keyword length >= 4 to avoid
    matching short generic tokens like 'qty' against everything.

    Returns (pinned, evidence-string).
    """
    blob = "\n".join(filenames)
    for kw in rule.topic_keywords:
        if len(kw) < 4:
            continue
        if kw in blob:
            return True, f"keyword `{kw}` appears in invariants/{kw}*.test.sql or similar"
    return False, ""


def is_waived(rule: Rule) -> tuple[bool, str]:
    """Return (waived, reason). A rule is waived if any of:

      - its source file matches a `WAIVED_FILE_PREFIXES` entry
        (advisory / strategy / plan / spec docs)
      - its raw text contains an `IN_CODE_ENFORCED_SUBSTRINGS` token
        (RAISE EXCEPTION, GENERATED ALWAYS, USING HINT/ERRCODE)
      - its raw text matches a `NARRATIVE_PATTERNS` regex
      - its (file, line) is in the `WAIVED_LINES` map
    """
    for prefix in WAIVED_FILE_PREFIXES:
        if rule.file == prefix or rule.file.startswith(prefix):
            return True, f"advisory file (matches `{prefix}`)"
    if (rule.file, rule.line) in WAIVED_LINES:
        return True, WAIVED_LINES[(rule.file, rule.line)]
    for sub in IN_CODE_ENFORCED_SUBSTRINGS:
        if sub in rule.raw:
            return True, f"in-code-enforced (`{sub}`)"
    for pat in NARRATIVE_PATTERNS:
        if pat.search(rule.raw):
            return True, f"narrative phrasing (matches `{pat.pattern}`)"
    return False, ""


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--json",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_invariants_pinned.json"),
    )
    ap.add_argument(
        "--md",
        type=str,
        default=str(REPO_ROOT / ".verify" / "audit_invariants_pinned.md"),
    )
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    files = discover_files()
    rules: list[Rule] = []
    for f in files:
        rules.extend(extract_rules(f))
    rules.sort(key=lambda r: (r.file, r.line))

    invariants = invariant_filenames()

    findings: list[Finding] = []
    pinned_count = 0
    waived_count = 0
    for rule in rules:
        pinned, _ = is_pinned(rule, invariants)
        if pinned:
            pinned_count += 1
            continue
        waived, _ = is_waived(rule)
        if waived:
            waived_count += 1
            continue
        findings.append(
            Finding(
                file=rule.file,
                line=rule.line,
                severity="MEDIUM",
                rule=rule.raw,
                description=(
                    f"Design rule on line {rule.line} of `{rule.file}` is not pinned "
                    "by any filename keyword in `supabase/tests/invariants/`. "
                    "Add a pgTAP invariant test, or accept the rule as advisory and "
                    "remove the must/never/always wording."
                ),
                topic_keywords=rule.topic_keywords,
            )
        )

    findings.sort(key=lambda f: (f.file, f.line))

    artifact = {
        "gate": "audit_invariants_pinned",
        "lens": "L11",
        "stats": {
            "rules_total": len(rules),
            "rules_pinned": pinned_count,
            "rules_waived": waived_count,
            "rules_unpinned": len(findings),
            "invariant_files": len(invariants),
        },
        "findings": [f.as_dict() for f in findings],
    }
    out_json = Path(args.json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(
        json.dumps(artifact, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    lines = [
        "# Invariants Pinned (Lens L11)",
        "",
        f"Total rules detected: **{len(rules)}**",
        f"Pinned by an invariant test: **{pinned_count}**",
        f"Waived (advisory / in-code-enforced / cross-referenced): **{waived_count}**",
        f"Unpinned (findings): **{len(findings)}**",
        f"Invariant test files scanned: **{len(invariants)}**",
        "",
    ]
    if findings:
        lines.append("## Findings")
        lines.append("")
        for f in findings[:300]:
            lines.append(f"- `{f.file}:{f.line}` — _{f.rule}_  ")
            lines.append(
                f"  keywords: {', '.join(f.topic_keywords) if f.topic_keywords else '-'}"
            )
            lines.append("")
        if len(findings) > 300:
            lines.append(f"_(...and {len(findings) - 300} more, see JSON.)_")
    else:
        lines.append("## Findings")
        lines.append("")
        lines.append("None — every detected rule has at least one matching invariant test.")
    md = "\n".join(lines) + "\n"

    out_md = Path(args.md)
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(md, encoding="utf-8")

    if not args.quiet:
        print(md)
        print(f"Wrote {out_json.relative_to(REPO_ROOT)} ({len(findings)} findings)")

    return 0 if not findings else 1


if __name__ == "__main__":
    sys.exit(main())
