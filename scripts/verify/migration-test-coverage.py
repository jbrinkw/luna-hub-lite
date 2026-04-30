#!/usr/bin/env python3
"""
Migration → pgTAP test coverage gate.

For every .sql file in supabase/migrations/:
  • If it has a "-- no-test: <reason>" header comment → exempt (pass)
  • If ANY table or function it introduces has a corresponding pgTAP test,
    OR any identifier it introduces (constraint name, column, function) is
    mentioned in a pgTAP test → pass
  • Otherwise → FAIL (needs a -- no-test: header or a new test)

Exit 0  — all migrations covered or explicitly exempted
Exit 1  — one or more uncovered migrations (list printed to stdout)
"""

import os
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Repo layout helpers
# ---------------------------------------------------------------------------

def find_repo_root() -> Path:
    here = Path(__file__).resolve().parent
    return here.parent.parent  # scripts/verify/ → ../../


def load_test_corpus(tests_dir: Path) -> dict[str, str]:
    """Return {relative_path: content} for every *.test.sql under tests_dir."""
    corpus: dict[str, str] = {}
    for path in sorted(tests_dir.rglob("*.test.sql")):
        rel = str(path.relative_to(tests_dir))
        try:
            corpus[rel] = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            pass
    return corpus


# ---------------------------------------------------------------------------
# Header analysis
# ---------------------------------------------------------------------------

def has_no_test_header(content: str) -> tuple[bool, str]:
    """
    Return (True, reason) when the migration carries an explicit exemption:
      -- no-test: <reason>
    Only the first 30 lines are scanned.
    """
    for line in content.splitlines()[:30]:
        stripped = line.strip()
        m = re.match(r"--\s*no-test\s*:\s*(.+)", stripped, re.IGNORECASE)
        if m:
            return True, m.group(1).strip()
        if stripped and not stripped.startswith("--"):
            break
    return False, ""


# ---------------------------------------------------------------------------
# SQL artifact extraction
# ---------------------------------------------------------------------------

_CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\.(\w+)",
    re.IGNORECASE,
)
_CREATE_FN_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+\w+\.(\w+)\s*\(",
    re.IGNORECASE,
)
# Named constraints, columns, and trigger names introduced by this migration
_CONSTRAINT_RE = re.compile(r"CONSTRAINT\s+(\w+)", re.IGNORECASE)
_ADD_COLUMN_RE = re.compile(r"ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\b", re.IGNORECASE)
_CREATE_TRIGGER_RE = re.compile(r"CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\b", re.IGNORECASE)


def extract_created_tables(content: str) -> list[tuple[str, str]]:
    return [(m.group(1).lower(), m.group(2).lower()) for m in _CREATE_TABLE_RE.finditer(content)]


def extract_created_functions(content: str) -> list[str]:
    return [m.group(1).lower() for m in _CREATE_FN_RE.finditer(content)]


def extract_named_identifiers(content: str) -> list[str]:
    """
    Extract identifiers from ALTER TABLE DDL: constraint names, added columns,
    trigger names. Used as a fallback corpus search when no CREATE TABLE/FUNCTION
    is present.
    """
    ids: list[str] = []
    ids += [m.group(1).lower() for m in _CONSTRAINT_RE.finditer(content)]
    ids += [m.group(1).lower() for m in _ADD_COLUMN_RE.finditer(content)]
    ids += [m.group(1).lower() for m in _CREATE_TRIGGER_RE.finditer(content)]
    return list(dict.fromkeys(ids))  # deduplicate, preserve order


# ---------------------------------------------------------------------------
# Metadata-only classification (no behavioral surface to test)
# ---------------------------------------------------------------------------

def strip_sql_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", "", sql)


def classify_metadata_only(content: str) -> tuple[bool, str]:
    """
    Return (True, reason) for migrations that have no testable behavior:
      dead migrations, index-only, publication-only, backfill-UPDATE-only,
      DROP-only, schema/grant-only.
    Returns (False, '') for anything that has behavioral code.
    """
    if re.search(r"DEAD MIGRATION", content, re.IGNORECASE):
        return True, "dead/no-op migration — logic lives in a later CREATE OR REPLACE"

    clean = strip_sql_comments(content)
    stmts = [s.strip() for s in clean.split(";") if s.strip()]
    if not stmts:
        return True, "empty migration"

    _no_beh = re.compile(
        r"^("
        r"CREATE\s+SCHEMA|"
        r"GRANT|"
        r"REVOKE|"
        r"COMMENT|"
        r"SET\s+search_path|"
        r"ALTER\s+DEFAULT\s+PRIVILEGES|"
        r"BEGIN|COMMIT|ROLLBACK|"
        r"DO\s+\$"
        r")\b",
        re.IGNORECASE,
    )
    _index = re.compile(r"^CREATE\s+(?:UNIQUE\s+)?INDEX\b", re.IGNORECASE)
    _pub = re.compile(r"^ALTER\s+PUBLICATION\b", re.IGNORECASE)
    _ext = re.compile(r"^CREATE\s+EXTENSION\b", re.IGNORECASE)
    _update = re.compile(r"^UPDATE\b", re.IGNORECASE)
    _alter_table = re.compile(r"^ALTER\s+TABLE\b", re.IGNORECASE)
    _alter_fn = re.compile(r"^ALTER\s+FUNCTION\b", re.IGNORECASE)
    _drop = re.compile(r"^DROP\b", re.IGNORECASE)
    _select = re.compile(r"^SELECT\b", re.IGNORECASE)
    _perform = re.compile(r"^PERFORM\b", re.IGNORECASE)
    _create_type = re.compile(r"^CREATE\s+TYPE\b", re.IGNORECASE)
    _create_trigger = re.compile(r"^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\b", re.IGNORECASE)

    def _no_behavior(s: str) -> bool:
        return bool(
            _no_beh.match(s) or _index.match(s) or _pub.match(s) or _ext.match(s)
            or _update.match(s) or _alter_table.match(s) or _alter_fn.match(s)
            or _drop.match(s) or _select.match(s) or _perform.match(s)
            or _create_type.match(s) or _create_trigger.match(s)
        )

    all_no_beh = all(_no_behavior(s) for s in stmts)
    if not all_no_beh:
        return False, ""

    has_index = any(_index.match(s) for s in stmts)
    has_pub = any(_pub.match(s) for s in stmts)
    has_update = any(_update.match(s) for s in stmts)
    has_drop = any(_drop.match(s) for s in stmts)

    if has_index and not has_update:
        return True, "index-only migration — behavioral coverage via table tests"
    if has_pub:
        return True, "publication membership change — covered by realtime_publication_integrity.test.sql"
    if has_update and not any(
        re.compile(r"^CREATE\s+(?:TABLE|FUNCTION|TRIGGER|TYPE)\b", re.IGNORECASE).match(s)
        for s in stmts
    ):
        return True, "data-backfill migration — one-time UPDATE, no new schema objects"
    if has_drop and not any(
        re.compile(r"^(CREATE|ALTER\s+TABLE)\b", re.IGNORECASE).match(s)
        for s in stmts
    ):
        return True, "DROP-only migration — objects removed, no new behavior to test"
    return True, "schema/DDL-only migration — no testable behavioral surface"


# ---------------------------------------------------------------------------
# Test coverage checks
# ---------------------------------------------------------------------------

def corpus_mentions_token(token: str, corpus: dict[str, str]) -> bool:
    """True if any test file mentions token as a word boundary (case-insensitive)."""
    pattern = re.compile(r"\b" + re.escape(token) + r"\b", re.IGNORECASE)
    return any(pattern.search(text) for text in corpus.values())


def corpus_mentions_function(name: str, corpus: dict[str, str]) -> bool:
    """
    True if any test file references this function.
    Checks:
      - '<name>(' — direct call
      - '<name>_trigger' — trigger function referenced by its trigger name
      - '<name>' as a standalone word (e.g. in a comment citing the migration)
    """
    # Direct call pattern
    call_pattern = re.compile(re.escape(name) + r"\s*\(", re.IGNORECASE)
    if any(call_pattern.search(text) for text in corpus.values()):
        return True
    # Trigger name pattern: trigger functions are often cited as <fn>_trigger
    trigger_pattern = re.compile(
        re.escape(name) + r"_trigger\b", re.IGNORECASE
    )
    if any(trigger_pattern.search(text) for text in corpus.values()):
        return True
    return False


def corpus_mentions_table(schema: str, table: str, corpus: dict[str, str], tests_dir: Path) -> bool:
    """
    True if:
      - A test file exists at tests/<schema>/<table>*.test.sql, OR
      - A test file exists at tests/invariants/<table>*.test.sql, OR
      - Any test file text mentions the table name as a word.
    """
    for sub in (schema, "invariants"):
        sub_dir = tests_dir / sub
        if sub_dir.exists():
            for f in sub_dir.iterdir():
                if f.name.lower().startswith(table) and f.name.endswith(".test.sql"):
                    return True
    word_re = re.compile(r"\b" + re.escape(table) + r"\b", re.IGNORECASE)
    return any(word_re.search(text) for text in corpus.values())


def corpus_cites_migration(migration_name: str, corpus: dict[str, str]) -> bool:
    """
    True if any test file explicitly references this migration by filename
    (e.g. 'Migration: 20260425050000_api_keys_max_10.sql').
    """
    stem = migration_name.rstrip(".sql") if migration_name.endswith(".sql") else migration_name
    # Match the timestamp prefix as the unique ID
    timestamp_re = re.compile(re.escape(stem[:14]), re.IGNORECASE)  # first 14 chars = timestamp
    return any(timestamp_re.search(text) for text in corpus.values())


def migration_has_any_coverage(
    migration_name: str,
    tables: list[tuple[str, str]],
    functions: list[str],
    corpus: dict[str, str],
    tests_dir: Path,
) -> bool:
    """
    Return True if at least ONE artifact (table, function) from this migration
    has a corresponding pgTAP test, OR if any test explicitly cites the migration
    filename (for trigger functions and similar indirect test relationships).
    OR logic across all checks.
    """
    # Direct migration citation in a test file
    if corpus_cites_migration(migration_name, corpus):
        return True
    for schema, table in tables:
        if corpus_mentions_table(schema, table, corpus, tests_dir):
            return True
    for fn in functions:
        if corpus_mentions_function(fn, corpus):
            return True
    return False


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> int:
    repo = find_repo_root()
    migrations_dir = repo / "supabase" / "migrations"
    tests_dir = repo / "supabase" / "tests"

    if not migrations_dir.exists():
        print(f"ERROR: migrations dir not found: {migrations_dir}", file=sys.stderr)
        return 1
    if not tests_dir.exists():
        print(f"ERROR: tests dir not found: {tests_dir}", file=sys.stderr)
        return 1

    migration_files = sorted(migrations_dir.glob("*.sql"))
    corpus = load_test_corpus(tests_dir)

    exempt: list[tuple[str, str]] = []
    covered: list[str] = []
    uncovered: list[tuple[str, str]] = []

    for mig_path in migration_files:
        name = mig_path.name
        content = mig_path.read_text(encoding="utf-8", errors="replace")

        # 1. Explicit no-test header wins immediately.
        has_header, _ = has_no_test_header(content)
        if has_header:
            exempt.append((name, ""))
            continue

        # 2. Extract testable artifacts.
        tables = extract_created_tables(content)
        functions = extract_created_functions(content)

        # 3. Has tables or functions → check OR coverage.
        if tables or functions:
            if migration_has_any_coverage(name, tables, functions, corpus, tests_dir):
                covered.append(name)
            else:
                # Build hint
                missing_tables = [
                    f"{s}.{t}" for s, t in tables
                    if not corpus_mentions_table(s, t, corpus, tests_dir)
                ]
                missing_fns = [
                    fn for fn in functions
                    if not corpus_mentions_function(fn, corpus)
                ]
                parts: list[str] = []
                if missing_tables:
                    parts.append(f"no test for table(s): {', '.join(missing_tables)}")
                if missing_fns:
                    parts.append(f"no test mentions fn(s): {', '.join(missing_fns)}")
                uncovered.append((name, "; ".join(parts) or "no matching test"))
            continue

        # 4. No CREATE TABLE / CREATE FUNCTION found.
        #    Try: named identifiers (constraints, columns, triggers) in corpus.
        named_ids = extract_named_identifiers(content)
        if named_ids:
            if any(corpus_mentions_token(token, corpus) for token in named_ids):
                covered.append(name)
                continue

        # 5. Fall back to metadata-only classification.
        meta, meta_reason = classify_metadata_only(content)
        if meta:
            uncovered.append((name, f"needs annotation: -- no-test: {meta_reason}"))
        else:
            # Not metadata-only, not covered — flag it.
            stem = re.sub(r"^\d+_", "", mig_path.stem)
            parts2 = [p for p in re.split(r"_", stem) if len(p) > 3]
            if any(corpus_mentions_token(p, corpus) for p in parts2):
                covered.append(name)
            else:
                uncovered.append((name, "no CREATE TABLE/FUNCTION and no identifier match in tests"))

    # ---------------------------------------------------------------------------
    # Report
    # ---------------------------------------------------------------------------
    total = len(migration_files)
    print(f"==> migration-test-coverage: {total} migrations scanned")
    print(f"    Exempt (-- no-test:)  : {len(exempt)}")
    print(f"    Covered by pgTAP      : {len(covered)}")
    print(f"    Uncovered             : {len(uncovered)}")
    print()

    if uncovered:
        print("FAIL — uncovered migrations (add '-- no-test: <reason>' header or write a pgTAP test):")
        for filename, detail in uncovered:
            print(f"  {filename}")
            print(f"    → {detail}")
        return 1

    print("PASS — every migration is covered or explicitly exempted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
