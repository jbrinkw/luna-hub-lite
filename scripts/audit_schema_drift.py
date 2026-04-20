#!/usr/bin/env python3
"""Schema drift detector for Luna Hub Lite data flows.

Diffs every column/field in each data hop across Python dataclasses,
Flask route bodies, Supabase edge function handlers, plpgsql RPCs,
SQL migrations, TypeScript interfaces, and generated DB types.

Run:  python3 scripts/audit_schema_drift.py
Exits 1 if any critical/high findings exist.

This script is deliberately mechanical: each source file is parsed
with a regex or a small ad-hoc extractor and the field sets are
compared hop-by-hop. It is **not** a general-purpose schema parser
— it handles the specific patterns in this repo.

If you add a new data flow, extend the FLOWS list below with a new
`Flow` instance and a matching extractor.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent


# --------------------------------------------------------------------------
# Helpers: tiny ad-hoc extractors for each file type we encounter.
# --------------------------------------------------------------------------


def read_text(rel: str) -> str:
    p = ROOT / rel
    if not p.exists():
        raise FileNotFoundError(f"missing source file: {rel}")
    return p.read_text(encoding="utf-8")


def extract_pydantic_dataclass_fields(source: str, class_name: str) -> set[str]:
    """Pull column names from a ``@dataclass class Foo: x: T = ...`` block."""
    # Find the class block body
    m = re.search(
        rf"@dataclass[\s\S]*?class\s+{re.escape(class_name)}\s*[:(][\s\S]*?(?=\n\n(?:@dataclass|class\s|# ---|def\s|\Z))",
        source,
        re.MULTILINE,
    )
    if not m:
        return set()
    body = m.group(0)
    # Each line is either a docstring/comment or `name: type = default`.
    fields: set[str] = set()
    for line in body.splitlines():
        # "    name: Type" pattern; skip decorators/class/docstring.
        fm = re.match(r"\s{4,}([a-z_][a-z0-9_]*)\s*:\s*[A-Za-z]", line)
        if fm:
            name = fm.group(1)
            if name not in {"cls", "self"}:
                fields.add(name)
    return fields


def extract_ts_interface_fields(source: str, interface_name: str) -> set[str]:
    """Pull keys from ``interface Foo { x: T; y: T; }``."""
    m = re.search(
        rf"interface\s+{re.escape(interface_name)}\s*{{([^}}]*)}}",
        source,
        re.DOTALL,
    )
    if not m:
        return set()
    body = m.group(1)
    fields: set[str] = set()
    for line in body.splitlines():
        fm = re.match(r"\s*([a-z_][a-z0-9_]*)\s*\??\s*:", line)
        if fm:
            fields.add(fm.group(1))
    return fields


def extract_sql_table_columns(source: str, table_fqn: str) -> set[str]:
    """Pull column names from `CREATE TABLE schema.name (...)`.

    Walks forward collecting every ``CREATE TABLE`` + ``ALTER TABLE … ADD
    COLUMN`` that matches ``table_fqn`` so the reported column set
    reflects the final DDL state after all migrations in ``source``
    have been applied.
    """
    cols: set[str] = set()
    # CREATE TABLE
    for m in re.finditer(
        rf"CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+{re.escape(table_fqn)}\s*\(([\s\S]*?)\n\s*\);",
        source,
        re.IGNORECASE,
    ):
        body = m.group(1)
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            if not line or line.startswith("--") or line.upper().startswith(
                ("CHECK", "PRIMARY", "FOREIGN", "CONSTRAINT", "UNIQUE")
            ):
                continue
            fm = re.match(r"([a-z_][a-z0-9_]*)\s+[A-Z]", line)
            if fm:
                cols.add(fm.group(1))
    # ALTER TABLE ... ADD COLUMN
    for m in re.finditer(
        rf"ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?{re.escape(table_fqn)}\s+((?:[\s\S](?!;))*[\s\S])\s*;",
        source,
        re.IGNORECASE,
    ):
        block = m.group(1)
        for am in re.finditer(
            r"ADD\s+COLUMN(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_]*)\s+",
            block,
            re.IGNORECASE,
        ):
            cols.add(am.group(1))
    return cols


def extract_sqlite_table_columns(source: str, table_name: str) -> set[str]:
    """SQLite variant — no schema prefix."""
    m = re.search(
        rf"CREATE\s+TABLE\s+{re.escape(table_name)}\s*\(([\s\S]*?)\n\);",
        source,
        re.IGNORECASE,
    )
    if not m:
        return set()
    body = m.group(1)
    cols: set[str] = set()
    for line in body.splitlines():
        line = line.strip().rstrip(",")
        if not line or line.startswith("--") or line.upper().startswith(
            ("CHECK", "PRIMARY", "FOREIGN", "CONSTRAINT", "UNIQUE")
        ):
            continue
        fm = re.match(r"([a-z_][a-z0-9_]*)\s+[A-Z]", line)
        if fm:
            cols.add(fm.group(1))
    return cols


def extract_keys_from_object_literal(
    source: str, anchor_regex: str, max_chars: int = 4000
) -> set[str]:
    """Pull shallow keys from a JS/TS object literal after an anchor.

    ``anchor_regex`` locates the ``{`` opening of the object; the scan
    then walks brace-balanced text to the matching ``}``.
    """
    am = re.search(anchor_regex, source)
    if not am:
        return set()
    start = source.find("{", am.end() - 1)
    if start < 0:
        return set()
    depth = 0
    end = -1
    for i in range(start, min(start + max_chars, len(source))):
        ch = source[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i
                break
    if end < 0:
        return set()
    body = source[start + 1 : end]
    # Top-level keys only (not nested). Use a brace-aware split.
    keys: set[str] = set()
    depth = 0
    bracket = 0
    buf: list[str] = []
    for ch in body:
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        elif ch == "[":
            bracket += 1
        elif ch == "]":
            bracket -= 1
        if ch == "," and depth == 0 and bracket == 0:
            chunk = "".join(buf)
            km = re.match(r"\s*([a-z_][a-z0-9_]*)\s*:", chunk)
            if km:
                keys.add(km.group(1))
            buf = []
        else:
            buf.append(ch)
    chunk = "".join(buf)
    km = re.match(r"\s*([a-z_][a-z0-9_]*)\s*:", chunk)
    if km:
        keys.add(km.group(1))
    return keys


def extract_python_tuple_strings(source: str, var_name: str) -> set[str]:
    """Pull str elements from ``NAME: tuple = ("a","b",...)``."""
    m = re.search(
        rf"{re.escape(var_name)}\s*:\s*tuple[\s\S]*?=\s*\(([\s\S]*?)\)",
        source,
    )
    if not m:
        return set()
    body = m.group(1)
    return set(re.findall(r"\"([a-z_][a-z0-9_]*)\"", body))


# --------------------------------------------------------------------------
# Finding model
# --------------------------------------------------------------------------


@dataclass
class Finding:
    flow: str
    severity: str   # critical | high | medium | low
    file_a: str
    file_b: str
    field: str
    description: str

    def format(self) -> str:
        return (
            f"[{self.severity.upper():8s}] {self.flow} :: field `{self.field}`\n"
            f"           A: {self.file_a}\n"
            f"           B: {self.file_b}\n"
            f"           {self.description}"
        )


# --------------------------------------------------------------------------
# FLOW A — Product intake pipeline
# --------------------------------------------------------------------------


def audit_flow_a() -> list[Finding]:
    findings: list[Finding] = []

    # Hop 1: Pi-side ProductIn dataclass
    pi_models = read_text("hardware/live-shelf/server/storage/models.py")
    product_in = extract_pydantic_dataclass_fields(pi_models, "ProductIn")

    # Hop 2: Pi intake IntakeForm
    pi_intake_models = read_text("hardware/live-shelf/server/intake/models.py")
    intake_form = extract_pydantic_dataclass_fields(pi_intake_models, "IntakeForm")

    # Hop 3: Pi -> cloud POST body (extracted from _post_intake_to_cloud)
    routes_src = read_text("hardware/live-shelf/server/intake/routes.py")
    post_body_match = re.search(
        r"def _post_intake_to_cloud[\s\S]*?body\s*=\s*\{([\s\S]*?)\}\s*\n\s*#",
        routes_src,
    )
    post_body_keys: set[str] = set()
    if post_body_match:
        for km in re.finditer(
            r"\"([a-z_][a-z0-9_]*)\"\s*:\s*product_in\.",
            post_body_match.group(1),
        ):
            post_body_keys.add(km.group(1))
        for km in re.finditer(
            r"\"([a-z_][a-z0-9_]*)\"\s*:\s*bool\(product_in",
            post_body_match.group(1),
        ):
            post_body_keys.add(km.group(1))

    # Hop 4: Edge fn /intake handler payload construction
    edge_src = read_text("supabase/functions/shelf-ingest/index.ts")
    # Scan "handleIntake" body for keys written to products
    handle_intake = re.search(
        r"async function handleIntake[\s\S]*?^}", edge_src, re.MULTILINE
    )
    edge_payload_keys: set[str] = set()
    if handle_intake:
        body = handle_intake.group(0)
        # Pattern A: inside the payload literal, `foo: body?.foo ?? null`
        for km in re.finditer(
            r"^\s*([a-z_][a-z0-9_]*)\s*:\s*body\?\.", body, re.MULTILINE,
        ):
            edge_payload_keys.add(km.group(1))
        # Pattern B: direct bracket assignment `payload.foo = body.foo`
        for km in re.finditer(
            r"payload\.([a-z_][a-z0-9_]*)\s*=\s*body",
            body,
        ):
            edge_payload_keys.add(km.group(1))
        # Pattern C: `payload["foo"] = ...`
        for km in re.finditer(
            r"payload\[['\"]([a-z_][a-z0-9_]*)['\"]\]\s*=",
            body,
        ):
            edge_payload_keys.add(km.group(1))
        # Pattern D: conditional persist `if (body?.foo !== undefined) payload.foo = body.foo`
        for km in re.finditer(
            r"if\s*\(\s*body\?\.\s*([a-z_][a-z0-9_]*)\s*!==\s*undefined\s*\)",
            body,
        ):
            edge_payload_keys.add(km.group(1))
        # name (first binding)
        if re.search(r"const\s+name[^=]*=\s*body\?\.name", body):
            edge_payload_keys.add("name")

    # Hop 5: Cloud chefbyte.products schema (initial + ALTERs)
    chef_tables = read_text(
        "supabase/migrations/20260303040000_chefbyte_tables.sql"
    )
    live_shelf_mig = read_text(
        "supabase/migrations/20260419010000_live_shelf.sql"
    )
    hardening_mig = read_text(
        "supabase/migrations/20260419050000_shelf_ingest_hardening.sql"
    )
    combined_mig = chef_tables + "\n" + live_shelf_mig + "\n" + hardening_mig
    cloud_products = extract_sql_table_columns(combined_mig, "chefbyte.products")

    # Hop 6: _PRODUCT_COLUMNS write-through tuple
    cloud_sync_src = read_text(
        "hardware/live-shelf/server/intake/cloud_sync.py"
    )
    wt_columns = extract_python_tuple_strings(cloud_sync_src, "_PRODUCT_COLUMNS")

    # Hop 7: Pi-local products schema
    pi_schema = read_text("hardware/live-shelf/server/storage/schema.sql")
    pi_products = extract_sqlite_table_columns(pi_schema, "products")

    # Hop 9: Generated DB types (chefbyte.products Row block)
    db_types = read_text("packages/db-types/src/database.ts")
    gen_products_match = re.search(
        r"products:\s*\{\s*Row:\s*\{([\s\S]*?)\}\s*Insert:",
        db_types,
    )
    gen_products: set[str] = set()
    if gen_products_match:
        for line in gen_products_match.group(1).splitlines():
            fm = re.match(r"\s*([a-z_][a-z0-9_]*)\s*:", line)
            if fm:
                gen_products.add(fm.group(1))

    # Compute intake-surface = fields the user can send from Pi → cloud.
    # Field is in intake surface if ProductIn carries it.
    intake_surface = product_in

    # Rule 1: Every ProductIn field should be forwarded by _post_intake_to_cloud.
    for fld in sorted(intake_surface):
        if fld == "certified":
            # certified is sent as bool(product_in.certified); matched via
            # the second regex branch above. If it's missing, that's critical.
            pass
        if fld not in post_body_keys:
            findings.append(Finding(
                flow="A: product intake",
                severity="critical",
                file_a="hardware/live-shelf/server/storage/models.py::ProductIn",
                file_b="hardware/live-shelf/server/intake/routes.py::_post_intake_to_cloud",
                field=fld,
                description=(
                    "ProductIn field not forwarded to cloud /intake body — "
                    "user-captured data silently dropped at Pi→cloud hop."
                ),
            ))

    # Rule 2: Every field in POST body must be recognized by the edge fn.
    for fld in sorted(post_body_keys):
        if fld not in edge_payload_keys:
            findings.append(Finding(
                flow="A: product intake",
                severity="critical",
                file_a="hardware/live-shelf/server/intake/routes.py::_post_intake_to_cloud",
                file_b="supabase/functions/shelf-ingest/index.ts::handleIntake",
                field=fld,
                description=(
                    "Pi sends this field to cloud /intake, but the edge "
                    "function does not persist it on chefbyte.products — "
                    "silent data loss."
                ),
            ))

    # Rule 3: Every field written by the edge fn must exist on chefbyte.products.
    for fld in sorted(edge_payload_keys - {"user_id"}):
        if fld not in cloud_products:
            findings.append(Finding(
                flow="A: product intake",
                severity="critical",
                file_a="supabase/functions/shelf-ingest/index.ts::handleIntake",
                file_b="supabase/migrations/*_chefbyte_tables.sql + ALTERs",
                field=fld,
                description=(
                    "Edge fn writes this key to chefbyte.products but "
                    "the column does not exist in the migration set. "
                    "Insert will fail at runtime."
                ),
            ))

    # Rule 4: Every field in _PRODUCT_COLUMNS (write-through) must exist on Pi products table.
    for fld in sorted(wt_columns):
        if fld not in pi_products:
            findings.append(Finding(
                flow="A: product intake",
                severity="critical",
                file_a="hardware/live-shelf/server/intake/cloud_sync.py::_PRODUCT_COLUMNS",
                file_b="hardware/live-shelf/server/storage/schema.sql::products",
                field=fld,
                description=(
                    "Write-through column not present on Pi-local "
                    "products table — INSERT will fail."
                ),
            ))

    # Rule 5: Every field in _PRODUCT_COLUMNS must also exist on cloud products.
    for fld in sorted(wt_columns):
        if fld not in cloud_products:
            findings.append(Finding(
                flow="A: product intake",
                severity="high",
                file_a="hardware/live-shelf/server/intake/cloud_sync.py::_PRODUCT_COLUMNS",
                file_b="supabase/migrations/*_chefbyte_tables.sql",
                field=fld,
                description=(
                    "Pi write-through expects this column to round-trip "
                    "from the cloud but the cloud schema lacks it."
                ),
            ))

    # Rule 6: Shape sanity — generated types should cover every cloud column.
    for fld in sorted(cloud_products):
        if fld not in gen_products:
            findings.append(Finding(
                flow="A: product intake",
                severity="medium",
                file_a="supabase/migrations/*_chefbyte_tables.sql",
                file_b="packages/db-types/src/database.ts::products.Row",
                field=fld,
                description=(
                    "Column exists on chefbyte.products but the generated "
                    "types don't include it — regenerate DB types."
                ),
            ))

    return findings


# --------------------------------------------------------------------------
# FLOW B — Scale event pipeline
# --------------------------------------------------------------------------


def audit_flow_b() -> list[Finding]:
    findings: list[Finding] = []

    # Payload keys emitted by CloudEventEmitter (integration.py)
    integ_src = read_text("hardware/live-shelf/server/cloud/integration.py")
    payload_keys: set[str] = set()
    for m in re.finditer(
        r"payload(?:_[a-z]+)?\s*:\s*dict\[str,\s*Any\]\s*=\s*\{([\s\S]*?)\n\s*\}",
        integ_src,
    ):
        for km in re.finditer(
            r"\"([a-z_][a-z0-9_]*)\"\s*:", m.group(1)
        ):
            payload_keys.add(km.group(1))

    # enqueue_event stamps client_event_id into every outbox payload
    outbox_src = read_text("hardware/live-shelf/server/cloud/outbox.py")
    if "client_event_id" in outbox_src and "stamped" in outbox_src:
        payload_keys.add("client_event_id")

    # Edge fn /event handler requires
    edge_src = read_text("supabase/functions/shelf-ingest/index.ts")
    handle_event = re.search(
        r"async function handleEvent[\s\S]*?^}", edge_src, re.MULTILINE
    )
    edge_event_reads: set[str] = set()
    if handle_event:
        body = handle_event.group(0)
        for km in re.finditer(
            r"body\?\.\s*([a-z_][a-z0-9_]*)", body
        ):
            edge_event_reads.add(km.group(1))

    # apply_shelf_event signature (latest: _hardening_v2)
    v2_src = read_text(
        "supabase/migrations/20260419060000_shelf_ingest_hardening_v2.sql"
    )
    sig_m = re.search(
        r"CREATE OR REPLACE FUNCTION private\.apply_shelf_event\(([\s\S]*?)\)\s*RETURNS",
        v2_src,
    )
    rpc_params: set[str] = set()
    if sig_m:
        for pm in re.finditer(r"p_([a-z_]+)\s+[A-Z]", sig_m.group(1)):
            rpc_params.add(pm.group(1))

    # Rule 1: every key in emitter payload must be read by edge /event handler
    skip_in_edge = {"_pi_resolution_id"}
    for fld in sorted(payload_keys - skip_in_edge):
        if fld not in edge_event_reads:
            findings.append(Finding(
                flow="B: scale event",
                severity="critical",
                file_a="hardware/live-shelf/server/cloud/integration.py::CloudEventEmitter",
                file_b="supabase/functions/shelf-ingest/index.ts::handleEvent",
                field=fld,
                description=(
                    "Pi emits this field on /event but the edge function "
                    "does not read it — field dropped before RPC."
                ),
            ))

    # Rule 2: each non-auth field the edge fn reads must map to an RPC param.
    # Mapping: scale_id→scale_id, kind→kind, event_kind→event_kind,
    # delta_g→delta_g, occurred_at→occurred_at, product_id→product_id,
    # client_event_id→client_event_id.
    edge_to_rpc = {
        "scale_id": "scale_id",
        "kind": "kind",
        "event_kind": "event_kind",
        "delta_g": "delta_g",
        "occurred_at": "occurred_at",
        "product_id": "product_id",
        "client_event_id": "client_event_id",
    }
    for edge_field, rpc_field in edge_to_rpc.items():
        if edge_field in edge_event_reads and rpc_field not in rpc_params:
            findings.append(Finding(
                flow="B: scale event",
                severity="critical",
                file_a="supabase/functions/shelf-ingest/index.ts::handleEvent",
                file_b="supabase/migrations/*_shelf_ingest_hardening_v2.sql::apply_shelf_event",
                field=edge_field,
                description=(
                    "Edge function reads this field but the RPC signature "
                    "does not accept it — value lost at edge→DB hop."
                ),
            ))

    return findings


# --------------------------------------------------------------------------
# FLOW C — Heartbeat pipeline
# --------------------------------------------------------------------------


def audit_flow_c() -> list[Finding]:
    findings: list[Finding] = []

    # Pi heartbeat provider body
    app_src = read_text("hardware/live-shelf/server/app.py")
    hb_body_match = re.search(
        r"def _heartbeat_provider\(\)[\s\S]*?return\s*\{([\s\S]*?)\n\s*\}",
        app_src,
    )
    pi_hb_keys: set[str] = set()
    if hb_body_match:
        for km in re.finditer(
            r"\"([a-z_][a-z0-9_]*)\"\s*:",
            hb_body_match.group(1),
        ):
            pi_hb_keys.add(km.group(1))

    # Edge fn /heartbeat parser reads
    edge_src = read_text("supabase/functions/shelf-ingest/index.ts")
    hb_handler = re.search(
        r"async function handleHeartbeat[\s\S]*?^}", edge_src, re.MULTILINE
    )
    edge_hb_reads: set[str] = set()
    if hb_handler:
        for km in re.finditer(
            r"body\?\.\s*([a-z_][a-z0-9_]*)", hb_handler.group(0)
        ):
            edge_hb_reads.add(km.group(1))

    # live_shelf_devices columns
    mig_src = read_text("supabase/migrations/20260419010000_live_shelf.sql")
    lan_src = read_text(
        "supabase/migrations/20260419020000_live_shelf_lan_ip.sql"
    )
    combined = mig_src + "\n" + lan_src
    device_cols = extract_sql_table_columns(
        combined, "chefbyte.live_shelf_devices"
    )

    # Fields the edge fn writes to live_shelf_devices (from the .update call)
    device_writes = {"last_heartbeat_ts", "pending_review_count"}

    # Rule 1: every pi_hb_key must be either read by edge fn or explicitly ignored
    # (edge fn only cares about pending_review_count + scales, others are v1
    # observability fields that the cloud doesn't persist yet).
    ignored_observability = {"outbox_pending_count", "outbox_permanent_failures"}
    for fld in sorted(pi_hb_keys):
        if fld in ignored_observability:
            findings.append(Finding(
                flow="C: heartbeat",
                severity="low",
                file_a="hardware/live-shelf/server/app.py::_heartbeat_provider",
                file_b="supabase/functions/shelf-ingest/index.ts::handleHeartbeat",
                field=fld,
                description=(
                    "Pi sends this observability field on every heartbeat, "
                    "but the edge function does not persist it. Cosmetic — "
                    "cloud UI will not surface outbox backlog state."
                ),
            ))
        elif fld not in edge_hb_reads and fld != "scales":
            findings.append(Finding(
                flow="C: heartbeat",
                severity="high",
                file_a="hardware/live-shelf/server/app.py::_heartbeat_provider",
                file_b="supabase/functions/shelf-ingest/index.ts::handleHeartbeat",
                field=fld,
                description=(
                    "Pi sends this heartbeat field but edge fn ignores it."
                ),
            ))

    # Rule 2: device_writes must exist as columns
    for fld in sorted(device_writes):
        if fld not in device_cols:
            findings.append(Finding(
                flow="C: heartbeat",
                severity="critical",
                file_a="supabase/functions/shelf-ingest/index.ts::handleHeartbeat",
                file_b="supabase/migrations/*_live_shelf*.sql",
                field=fld,
                description=(
                    "Edge fn updates this column on live_shelf_devices "
                    "but the migration doesn't declare it — update will fail."
                ),
            ))

    # Rule 3: Web UI LiveShelfDeviceLite fields must exist on the DB table
    scales_src = read_text("apps/web/src/components/chefbyte/ScalesTab.tsx")
    ui_lite = extract_ts_interface_fields(scales_src, "LiveShelfDeviceLite")
    for fld in sorted(ui_lite):
        if fld not in device_cols:
            findings.append(Finding(
                flow="C: heartbeat",
                severity="high",
                file_a="apps/web/src/components/chefbyte/ScalesTab.tsx::LiveShelfDeviceLite",
                file_b="supabase/migrations/*_live_shelf*.sql::live_shelf_devices",
                field=fld,
                description=(
                    "Web UI reads this column via Supabase but it doesn't "
                    "exist on the DB table — query will return undefined."
                ),
            ))

    return findings


# --------------------------------------------------------------------------
# FLOW D — scale_pairings naming collision (CRITICAL)
# --------------------------------------------------------------------------


def audit_flow_d() -> list[Finding]:
    findings: list[Finding] = []

    pi_schema = read_text("hardware/live-shelf/server/storage/schema.sql")
    pi_pairings = extract_sqlite_table_columns(pi_schema, "scale_pairings")

    cloud_mig = read_text(
        "supabase/migrations/20260419010000_live_shelf.sql"
    )
    cloud_pairings = extract_sql_table_columns(
        cloud_mig, "chefbyte.scale_pairings"
    )

    if not pi_pairings or not cloud_pairings:
        return findings

    # These two tables share a name but different purpose + columns.
    findings.append(Finding(
        flow="D: scale_pairings naming collision",
        severity="high",
        file_a="hardware/live-shelf/server/storage/schema.sql::scale_pairings (Pi-local, SQLite)",
        file_b="supabase/migrations/20260419010000_live_shelf.sql::chefbyte.scale_pairings (cloud, Postgres)",
        field="<TABLE>",
        description=(
            f"Two tables named `scale_pairings` with different schemas. "
            f"Pi-local cols: {sorted(pi_pairings)}. "
            f"Cloud cols: {sorted(cloud_pairings)}. "
            f"Only-Pi: {sorted(pi_pairings - cloud_pairings)}. "
            f"Only-cloud: {sorted(cloud_pairings - pi_pairings)}. "
            "RENAME PROPOSAL: Pi-local → `esp_scale_assignments` (it keys "
            "by device_id and tracks the ESP's product assignment) or cloud → "
            "`shelf_scales`. Leaving both the same name WILL bite future "
            "devs when they grep for the table and find the wrong schema."
        ),
    ))

    return findings


# --------------------------------------------------------------------------
# FLOW E — /catalog response shape
# --------------------------------------------------------------------------


def audit_flow_e() -> list[Finding]:
    findings: list[Finding] = []

    # Edge fn /catalog response keys
    edge_src = read_text("supabase/functions/shelf-ingest/index.ts")
    handle_catalog = re.search(
        r"async function handleCatalog[\s\S]*?return\s+jsonResponse\(\{([\s\S]*?)\}\s*\);",
        edge_src,
    )
    edge_catalog_keys: set[str] = set()
    if handle_catalog:
        for km in re.finditer(
            r"([a-z_][a-z0-9_]*)\s*:\s*[a-z]",
            handle_catalog.group(1),
        ):
            edge_catalog_keys.add(km.group(1))

    # Pi Catalog dataclass fields
    cat_src = read_text("hardware/live-shelf/server/cloud/catalog.py")
    pi_catalog = extract_pydantic_dataclass_fields(cat_src, "Catalog")

    # Expected cross-set
    top_level_data = {"products", "stock", "pairings", "locations"}
    for fld in sorted(top_level_data):
        if fld not in edge_catalog_keys:
            findings.append(Finding(
                flow="E: /catalog response",
                severity="critical",
                file_a="supabase/functions/shelf-ingest/index.ts::handleCatalog",
                file_b="hardware/live-shelf/server/cloud/catalog.py::Catalog",
                field=fld,
                description=(
                    "Pi Catalog expects this top-level key but edge fn "
                    "doesn't send it."
                ),
            ))
        if fld not in pi_catalog:
            findings.append(Finding(
                flow="E: /catalog response",
                severity="high",
                file_a="hardware/live-shelf/server/cloud/catalog.py::Catalog",
                file_b="supabase/functions/shelf-ingest/index.ts::handleCatalog",
                field=fld,
                description=(
                    "Edge fn returns this key but Pi Catalog dataclass "
                    "has no field for it — value silently dropped."
                ),
            ))

    return findings


# --------------------------------------------------------------------------
# FLOW F — unit_type CHECK constraint
# --------------------------------------------------------------------------


def audit_flow_f() -> list[Finding]:
    findings: list[Finding] = []

    # Pi schema CHECK values
    pi_schema = read_text("hardware/live-shelf/server/storage/schema.sql")
    m = re.search(r"unit_type\s+TEXT\s+CHECK\(unit_type\s+IN\s*\(([^)]*)\)\)", pi_schema)
    pi_vals: set[str] = set()
    if m:
        pi_vals = set(re.findall(r"'([a-z]+)'", m.group(1)))

    # Cloud migrations — any CHECK?
    chef_mig = read_text("supabase/migrations/20260303040000_chefbyte_tables.sql")
    hard_mig = read_text("supabase/migrations/20260419050000_shelf_ingest_hardening.sql")
    combined = chef_mig + "\n" + hard_mig
    has_cloud_unit_type_check = bool(
        re.search(r"unit_type[\s\S]*?CHECK", combined, re.IGNORECASE)
    )
    if not has_cloud_unit_type_check:
        findings.append(Finding(
            flow="F: unit_type CHECK",
            severity="medium",
            file_a="hardware/live-shelf/server/storage/schema.sql",
            file_b="supabase/migrations/*.sql",
            field="unit_type",
            description=(
                f"Pi schema enforces CHECK(unit_type IN {sorted(pi_vals)}); "
                "cloud schema has NO CHECK — allows arbitrary values "
                "(e.g. 'volume'). cloud_sync.py currently coerces unknowns "
                "to NULL with a WARN, which protects the Pi cache, but "
                "the cloud itself has no guard. Consider adding a CHECK "
                "constraint on cloud chefbyte.products.unit_type."
            ),
        ))

    # Also: edge fn validation?
    edge_src = read_text("supabase/functions/shelf-ingest/index.ts")
    has_edge_unit_type_validation = "unit_type" in edge_src and bool(
        re.search(r"unit_type[\s\S]{0,200}?VALID", edge_src, re.IGNORECASE)
    )
    if not has_edge_unit_type_validation and "unit_type" in edge_src:
        findings.append(Finding(
            flow="F: unit_type CHECK",
            severity="low",
            file_a="supabase/functions/shelf-ingest/index.ts",
            file_b="hardware/live-shelf/server/storage/schema.sql",
            field="unit_type",
            description=(
                "Edge fn accepts unit_type as pass-through without "
                "validation against the Pi's valid set. Non-blocking as "
                "long as the Pi's cloud_sync.py coerces on read."
            ),
        ))

    return findings


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------


FLOWS: list[tuple[str, Callable[[], list[Finding]]]] = [
    ("A: product intake", audit_flow_a),
    ("B: scale event", audit_flow_b),
    ("C: heartbeat", audit_flow_c),
    ("D: scale_pairings naming collision", audit_flow_d),
    ("E: /catalog response", audit_flow_e),
    ("F: unit_type CHECK", audit_flow_f),
]


def main() -> int:
    all_findings: list[Finding] = []
    for name, fn in FLOWS:
        try:
            all_findings.extend(fn())
        except FileNotFoundError as exc:
            all_findings.append(Finding(
                flow=name,
                severity="high",
                file_a=str(exc),
                file_b="<skipped>",
                field="<MISSING-FILE>",
                description=f"Audit could not run: {exc}",
            ))

    by_sev: dict[str, list[Finding]] = {
        "critical": [], "high": [], "medium": [], "low": []
    }
    for f in all_findings:
        by_sev[f.severity].append(f)

    print("=" * 78)
    print("SCHEMA DRIFT AUDIT — Luna Hub Lite")
    print("=" * 78)
    print()
    print(
        f"Summary: {len(by_sev['critical'])} critical / "
        f"{len(by_sev['high'])} high / "
        f"{len(by_sev['medium'])} medium / "
        f"{len(by_sev['low'])} low"
    )
    print()

    for sev in ("critical", "high", "medium", "low"):
        items = by_sev[sev]
        if not items:
            continue
        print("-" * 78)
        print(f"{sev.upper()} ({len(items)})")
        print("-" * 78)
        for f in items:
            print(f.format())
            print()

    return 1 if (by_sev["critical"] or by_sev["high"]) else 0


if __name__ == "__main__":
    sys.exit(main())
