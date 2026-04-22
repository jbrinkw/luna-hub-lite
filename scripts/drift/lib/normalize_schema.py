#!/usr/bin/env python3
"""Normalize a PostgreSQL schema dump to a canonical text form.

This is the core of the nightly AST-diff gate (VERIFY.md "Gate: Drift →
Nightly"). It takes a raw `pg_dump --schema-only` or `supabase db dump
--schema-only --linked` output and produces a normalized version that:

  1. Strips comments (-- line and /* block */).
  2. Strips blank lines and trailing whitespace.
  3. Strips role/privilege stanzas that legitimately differ between
     local dev creds and prod (GRANT, REVOKE, ALTER ... OWNER TO,
     CREATE ROLE, ALTER ROLE, ALTER DEFAULT PRIVILEGES, SET ROLE,
     RESET ROLE, REASSIGN OWNED, DROP OWNED).
  4. Strips `SET` session-config stanzas that are dump-meta, not schema
     (SET statement_timeout, SET client_encoding, etc.). This also
     absorbs the "search_path dialect" divergence — both local and
     prod emit their own SET search_path prefixes and they differ by
     whitespace / casing / ordering across CLI versions.
  5. Sorts top-level DDL blocks deterministically by (block-kind,
     object-identity) so the order of CREATE FUNCTION, CREATE TABLE,
     CREATE TRIGGER, etc. does not cause false-positive diffs. Prod
     pg_dump and local supabase dump frequently differ only in
     ordering.
  6. Normalizes whitespace inside function bodies: collapses runs of
     whitespace to single spaces so that e.g. a trailing semicolon on
     a new line versus same line doesn't diff.

The output is the contract: what the normalizer IGNORES is what drift
in ignored stanzas looks like — i.e. invisible. If someone rotates a
database password or changes GRANTs on prod, that is INTENTIONALLY
ignored. See scripts/drift/README.md for the full list.

Usage:
  python3 normalize_schema.py <input.sql>      # writes normalized to stdout
  python3 normalize_schema.py < input.sql      # stdin mode
  python3 normalize_schema.py --self-test      # meta-internal sanity

Exit codes:
  0 — normalized output written to stdout
  1 — input unreadable or empty
"""

from __future__ import annotations

import re
import sys


# -----------------------------------------------------------------------------
# Stanzas we drop entirely (single-statement DDL that diverges legitimately
# between local and prod). The pattern matches the first keyword of a
# statement; the full statement (through the terminating semicolon on its own
# or at end of line) is consumed.
# -----------------------------------------------------------------------------
DROP_STANZA_PATTERNS: list[re.Pattern[str]] = [
    # Privileges and ownership.
    re.compile(r"^\s*GRANT\b", re.IGNORECASE),
    re.compile(r"^\s*REVOKE\b", re.IGNORECASE),
    re.compile(r"^\s*ALTER\s+.*OWNER\s+TO\b", re.IGNORECASE),
    re.compile(r"^\s*ALTER\s+DEFAULT\s+PRIVILEGES\b", re.IGNORECASE),
    re.compile(r"^\s*CREATE\s+ROLE\b", re.IGNORECASE),
    re.compile(r"^\s*ALTER\s+ROLE\b", re.IGNORECASE),
    re.compile(r"^\s*DROP\s+ROLE\b", re.IGNORECASE),
    re.compile(r"^\s*SET\s+ROLE\b", re.IGNORECASE),
    re.compile(r"^\s*RESET\s+ROLE\b", re.IGNORECASE),
    re.compile(r"^\s*REASSIGN\s+OWNED\b", re.IGNORECASE),
    re.compile(r"^\s*DROP\s+OWNED\b", re.IGNORECASE),
    # Session-config SETs from pg_dump preamble — not schema.
    # This also absorbs SET search_path divergences between CLI versions.
    re.compile(r"^\s*SET\s+\w+\s*=", re.IGNORECASE),
    re.compile(r"^\s*SELECT\s+pg_catalog\.set_config\b", re.IGNORECASE),
    # COMMENT ON — metadata, not structural. Strip to avoid noise.
    re.compile(r"^\s*COMMENT\s+ON\b", re.IGNORECASE),
]

# -----------------------------------------------------------------------------
# Line-level filters (applied after we've broken the file into top-level
# statements).
# -----------------------------------------------------------------------------
SQL_LINE_COMMENT = re.compile(r"--[^\n]*")
SQL_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)


def strip_comments(sql: str) -> str:
    """Remove -- line comments and /* ... */ block comments.

    Naive implementation: it does NOT honor SQL string literals that contain
    `--` or `/*`. For schema dumps this is safe because pg_dump quotes
    identifiers and literals with $$ or E'' and the comment tokens won't
    appear inside them in idiomatic output.
    """
    sql = SQL_BLOCK_COMMENT.sub("", sql)
    sql = SQL_LINE_COMMENT.sub("", sql)
    return sql


def split_top_level_statements(sql: str) -> list[str]:
    """Split on semicolons that terminate top-level statements.

    Respects PostgreSQL dollar-quoted strings (for function bodies). Does
    NOT fully parse — this is a pragmatic tokenizer targeting pg_dump output
    where dollar-quoting is used consistently for function/procedure bodies.
    """
    statements: list[str] = []
    buf: list[str] = []
    i = 0
    n = len(sql)
    in_dollar: str | None = None  # the current dollar-tag, e.g. "$$" or "$BODY$"
    in_single_quote = False

    while i < n:
        ch = sql[i]

        # If inside a dollar-quoted block, look only for the close-tag.
        if in_dollar is not None:
            if sql.startswith(in_dollar, i):
                buf.append(in_dollar)
                i += len(in_dollar)
                in_dollar = None
                continue
            buf.append(ch)
            i += 1
            continue

        # If inside a single-quote string, look for the close quote (handle
        # doubled escapes '').
        if in_single_quote:
            if ch == "'" and i + 1 < n and sql[i + 1] == "'":
                buf.append("''")
                i += 2
                continue
            if ch == "'":
                in_single_quote = False
                buf.append(ch)
                i += 1
                continue
            buf.append(ch)
            i += 1
            continue

        # Detect dollar-quote opening tag: $...$
        if ch == "$":
            # Grab the tag: $<identifier?>$
            m = re.match(r"\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$", sql[i:])
            if m:
                tag = m.group(0)
                buf.append(tag)
                i += len(tag)
                in_dollar = tag
                continue

        # Detect single-quote opening.
        if ch == "'":
            in_single_quote = True
            buf.append(ch)
            i += 1
            continue

        # Top-level semicolon → end of statement.
        if ch == ";":
            buf.append(ch)
            statements.append("".join(buf).strip())
            buf = []
            i += 1
            continue

        buf.append(ch)
        i += 1

    tail = "".join(buf).strip()
    if tail:
        statements.append(tail)
    return [s for s in statements if s]


def should_drop(stmt: str) -> bool:
    """Return True if the statement is in an ignored category."""
    # A statement may have leading whitespace/newlines — match on first
    # non-empty line.
    first_line = next((ln for ln in stmt.splitlines() if ln.strip()), "")
    # Also check the first 120 chars flat (some pg_dump lines have newline
    # mid-statement before the keyword).
    head = stmt[:256]
    for pat in DROP_STANZA_PATTERNS:
        if pat.match(first_line) or pat.match(head):
            return True
    return False


def normalize_whitespace(stmt: str) -> str:
    """Collapse runs of whitespace (inc. newlines) inside a statement.

    Preserves dollar-quoted function bodies verbatim for human-readability
    UNTIL the final line-join pass — but since we ultimately sort and diff
    statements as one-line-each, collapsing is safe.
    """
    # Strip trailing semicolons to canonicalize.
    stmt = stmt.rstrip().rstrip(";").rstrip()
    # Collapse all runs of whitespace to single space.
    stmt = re.sub(r"\s+", " ", stmt)
    return stmt.strip()


# -----------------------------------------------------------------------------
# Sort key extraction. Each statement kind gets a stable (kind_rank, name)
# tuple so the final statement list has a deterministic order regardless of
# how pg_dump laid them out.
# -----------------------------------------------------------------------------
KIND_ORDER: dict[str, int] = {
    "CREATE SCHEMA":       10,
    "CREATE EXTENSION":    11,
    "CREATE TYPE":         20,
    "CREATE DOMAIN":       21,
    "CREATE SEQUENCE":     30,
    "CREATE TABLE":        40,
    "ALTER TABLE":         41,
    "CREATE INDEX":        50,
    "CREATE UNIQUE INDEX": 51,
    "CREATE VIEW":         60,
    "CREATE MATERIALIZED VIEW": 61,
    "CREATE FUNCTION":     70,
    "CREATE OR REPLACE FUNCTION": 70,
    "CREATE PROCEDURE":    71,
    "CREATE OR REPLACE PROCEDURE": 71,
    "CREATE TRIGGER":      80,
    "CREATE POLICY":       90,
    "CREATE PUBLICATION":  100,
    "CREATE SUBSCRIPTION": 101,
    "CREATE RULE":         110,
}

KIND_REGEX = re.compile(
    r"^\s*(CREATE\s+OR\s+REPLACE\s+FUNCTION|CREATE\s+OR\s+REPLACE\s+PROCEDURE|"
    r"CREATE\s+UNIQUE\s+INDEX|CREATE\s+MATERIALIZED\s+VIEW|"
    r"CREATE\s+SCHEMA|CREATE\s+EXTENSION|CREATE\s+TYPE|CREATE\s+DOMAIN|"
    r"CREATE\s+SEQUENCE|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|"
    r"CREATE\s+VIEW|CREATE\s+FUNCTION|CREATE\s+PROCEDURE|CREATE\s+TRIGGER|"
    r"CREATE\s+POLICY|CREATE\s+PUBLICATION|CREATE\s+SUBSCRIPTION|CREATE\s+RULE)",
    re.IGNORECASE,
)

IDENTITY_REGEX = re.compile(
    r"^\s*(?:CREATE\s+(?:OR\s+REPLACE\s+)?[A-Z\s]+?)\s+"
    r"(IF\s+NOT\s+EXISTS\s+)?"
    r"([A-Za-z0-9_.\"]+(?:\s*\([^)]*\))?)",
    re.IGNORECASE,
)


def sort_key(stmt: str) -> tuple[int, str]:
    """Build a (kind_rank, identity) sort key for a statement.

    For CREATE FUNCTION, the identity includes the argument list so that
    overloads are sorted deterministically.
    """
    m = KIND_REGEX.match(stmt)
    if not m:
        # Unknown kind — dump at the end in lexicographic order.
        return (999, stmt[:80].lower())
    kind_raw = re.sub(r"\s+", " ", m.group(1).upper())
    kind_rank = KIND_ORDER.get(kind_raw, 500)

    # Identity: from end of KIND keyword up through first ( arg-list ) or
    # first whitespace.
    after_kind = stmt[m.end():].lstrip()
    # Strip "IF NOT EXISTS" if present.
    after_kind = re.sub(r"^IF\s+NOT\s+EXISTS\s+", "", after_kind, flags=re.IGNORECASE)

    # For CREATE FUNCTION, identity = name + arg-type-list. Grab up to
    # closing paren.
    ident = ""
    if kind_raw in ("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION",
                    "CREATE PROCEDURE", "CREATE OR REPLACE PROCEDURE"):
        # name(args)
        depth = 0
        started = False
        for ch in after_kind:
            ident += ch
            if ch == "(":
                depth += 1
                started = True
            elif ch == ")":
                depth -= 1
                if started and depth == 0:
                    break
    else:
        # Up to first whitespace.
        m2 = re.match(r"[^\s(]+", after_kind)
        if m2:
            ident = m2.group(0)
        else:
            ident = after_kind[:80]

    # Normalize identity whitespace.
    ident = re.sub(r"\s+", " ", ident).strip().lower()
    return (kind_rank, ident)


def normalize(sql: str) -> str:
    """Main entrypoint. Returns normalized schema as one statement per line."""
    sql = strip_comments(sql)
    statements = split_top_level_statements(sql)

    kept: list[str] = []
    for stmt in statements:
        if should_drop(stmt):
            continue
        norm = normalize_whitespace(stmt)
        if not norm:
            continue
        kept.append(norm)

    # Deterministic sort so pg_dump ordering divergence doesn't diff.
    kept.sort(key=sort_key)
    return "\n".join(kept) + ("\n" if kept else "")


# -----------------------------------------------------------------------------
# Self-test (tiny, internal — the real meta-test lives in tests/).
# -----------------------------------------------------------------------------
def _self_test() -> int:
    tests = []

    # Comments stripped.
    tests.append((
        "CREATE TABLE foo(id int); -- trailing comment\n/* block */ CREATE TABLE bar(id int);",
        "CREATE TABLE bar(id int)\nCREATE TABLE foo(id int)\n",
    ))
    # GRANT stripped.
    tests.append((
        "CREATE TABLE foo(id int);\nGRANT ALL ON foo TO postgres;",
        "CREATE TABLE foo(id int)\n",
    ))
    # SET search_path stripped.
    tests.append((
        "SET search_path = public, pg_catalog;\nCREATE TABLE foo(id int);",
        "CREATE TABLE foo(id int)\n",
    ))
    # Sort: function before table should re-order to (table=40, function=70).
    tests.append((
        "CREATE FUNCTION zz() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql;\n"
        "CREATE TABLE aa(id int);",
        "CREATE TABLE aa(id int)\nCREATE FUNCTION zz() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql\n",
    ))

    fails = 0
    for i, (inp, want) in enumerate(tests):
        got = normalize(inp)
        if got != want:
            fails += 1
            sys.stderr.write(f"[self-test] case {i} FAIL\n want: {want!r}\n  got: {got!r}\n")
    if fails == 0:
        sys.stderr.write("[self-test] all cases passed\n")
    return 1 if fails else 0


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--self-test":
        return _self_test()

    if len(argv) >= 2:
        try:
            with open(argv[1], "r", encoding="utf-8") as f:
                sql = f.read()
        except OSError as e:
            sys.stderr.write(f"[normalize] cannot read {argv[1]}: {e}\n")
            return 1
    else:
        sql = sys.stdin.read()

    if not sql.strip():
        sys.stderr.write("[normalize] empty input\n")
        return 1

    sys.stdout.write(normalize(sql))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
