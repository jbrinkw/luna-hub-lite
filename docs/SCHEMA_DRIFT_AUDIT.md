# Schema Drift Audit

Mechanical drift report across the six Pi↔cloud↔web data flows. Run via:

```bash
python3 scripts/audit_schema_drift.py
```

Exits non-zero if any critical or high drifts are found. Runs in <1s.

## Summary (2026-04-19)

**0 critical / 1 high / 0 medium / 3 low.**

The only remaining high finding is the deliberately-surfaced
`scale_pairings` naming collision between Pi-local SQLite and cloud
Postgres — same table name, different purposes, different columns. The
rename is deferred; see below.

Lows are cosmetic observability gaps, not data-loss bugs.

## Findings

### HIGH — Flow D: `scale_pairings` naming collision

Two tables share the name `scale_pairings` but have entirely different
schemas and domains.

| Col                 | Pi-local (`storage/schema.sql`) | Cloud (`chefbyte.scale_pairings`) |
| ------------------- | ------------------------------- | --------------------------------- |
| `device_id`         | TEXT PRIMARY KEY                | UUID, FK → live_shelf_devices     |
| `pairing_id`        | —                               | UUID PRIMARY KEY                  |
| `scale_id`          | —                               | TEXT                              |
| `kind`              | —                               | TEXT CHECK IN (...)               |
| `shelf_id`          | TEXT CHECK (...)                | —                                 |
| `user_id`           | —                               | UUID, FK → auth.users             |
| `lot_id`            | TEXT FK → lots                  | —                                 |
| `product_id`        | TEXT FK → products              | UUID FK → chefbyte.products       |
| `first_seen_at`     | TEXT                            | TIMESTAMPTZ                       |
| `last_heartbeat_ts` | TEXT                            | TIMESTAMPTZ                       |
| `notes`             | TEXT                            | —                                 |

**Impact.** A developer grepping for `scale_pairings` in this repo
will hit both schemas. The Pi-local table is keyed by `device_id`
(ESP hardware ID) and pairs that ESP to a product+lot. The cloud
table is keyed by `(device_id, scale_id)` and tracks per-scale-under-Pi
pairing with separate `scale_id` + `kind` columns — a completely
different data model.

**Rename proposal (deferred — not executed in this audit):**

- Option 1 (preferred): Pi-local `scale_pairings` → `esp_scale_assignments`.
  The Pi table is really "which product does this ESP track?" — a 1:1
  assignment. Rename on Pi side avoids touching the cloud API surface
  (which the web UI + shelf-ingest edge function both consume).
- Option 2: cloud `chefbyte.scale_pairings` → `chefbyte.shelf_scales`.
  More accurate to the fact that the cloud table has one row per
  physical scale per Pi, regardless of whether the user has assigned
  a product.

**Why deferred.** Execution would require:

1. New Pi migration `schema.sql` + data copy from old table.
2. Update every `scale_pairings` reference in `server/` (repo, adapters,
   app.py, tests) — 40+ call sites.
3. Refresh classifier + reconciler + intake modules.

Mechanically possible but not in scope for a drift-detector pass. The
audit document surfaces the collision so future work has the full
picture. Tracked in `decisions.md` (add follow-up).

### LOW — Flow C: heartbeat observability drops

`outbox_pending_count` and `outbox_permanent_failures` — Pi sends on
every heartbeat (for cloud UI backlog surfacing); edge function
currently ignores them. No data loss; just unused observability.
Future work: persist on `live_shelf_devices` and render in the web
Scales UI.

### LOW — Flow F: `unit_type` CHECK on cloud side

Pi has `CHECK(unit_type IN ('liquid','solid','count','mixed'))`. Cloud
has no CHECK. `cloud_sync.py::upsert_product_from_cloud` already
defensively coerces unknown cloud values to NULL + WARN on the Pi, so
this doesn't break the round-trip — it just means the cloud could
accumulate stray values over time. Consider adding a CHECK to cloud's
`chefbyte.products.unit_type` for symmetry.

## Detector design

`scripts/audit_schema_drift.py` builds six per-flow extractors. For
each flow, it pulls the field/column set at each hop (Python dataclass,
Flask body dict, TypeScript object literal, SQL migration + ALTERs,
Pydantic pass-through tuple, generated DB types) and diffs pairwise.

**Extractors are deliberately regex-based, not full parsers** — they
handle exactly the patterns used in this repo. Add a new `audit_flow_*`
function + register it in `FLOWS` when adding a new cross-boundary
data flow.

Severity ladder:

- **critical** — field sent by producer but not persisted by consumer
  (silent data loss)
- **high** — wrong type / missing column / naming collision
- **medium** — nullability mismatch / generated-types out of sync
- **low** — cosmetic / observability / validation gaps

## Mutation test

The detector was validated by deliberately removing the
`calories_per_serving` / `carbs_per_serving` / etc. conditional persist
block in `supabase/functions/shelf-ingest/index.ts::handleIntake`. The
report flipped to `1 critical: calories_per_serving field dropped` as
expected. Restoring the block returned the report to clean. The false
positive caught in dev was a missing regex pattern (conditional
persists) which was fixed in-script before commit.

## Running in CI

Add to any pre-merge hook:

```bash
python3 scripts/audit_schema_drift.py
```

Non-zero exit on critical/high findings blocks the merge.
