# Usage Log — Plan

Date: 2026-04-17
Status: plan only — no code written
Scope: `hardware/live-shelf/server/`
Depends on: `IN_FLIGHT_TRACKER_PLAN.md` (already built)

---

## 1. What it is

Every time an item leaves the shelf and doesn't come back whole, that's
consumption (or loss). Today we record those events piecemeal across several
shapes: `lots.total_consumed_g` (cumulative per lot), `session_resolutions`
rows (one per event-pair), event_lifecycle entries (observability). Nothing
is user-facing, nothing is queryable by "what did I eat today."

This plan adds a **single append-only `usage_log` table** that captures each
discrete consumption event as a normalized row — with denormalised product
info frozen at log time, the exact gram amount consumed, and a link back to
the originating event(s). Plus a `/usage` UI page rendering the log, and a
JSON API for programmatic queries.

Two sources feed the log:

1. **In-flight returns** (`in_flight_return` resolutions) — user lifted an
   item, returned it lighter. `consumed_g = pickup_weight − return_delta`.
2. **Non-returns** (`in_flight_ttl_expired`, `in_flight_replaced_new_item`) —
   user lifted an item and never put it back (or replaced it). The whole
   pickup mass is consumption/loss: `consumed_g = pickup_weight_g`.

A third source for completeness:

3. **Reconciler pass-through** (`use_return_consumed`) — post-session
   stitching when the fast path didn't run (classifier down, old code path,
   etc.). Small code surface; included for audit completeness.

## 2. Goals / non-goals

**Goals**

- Answer "how much of X did I consume this week?" with a single SQL query.
- Stable audit log: renaming a product later doesn't change history.
- Cover both return-with-delta AND non-return (TTL / replaced) flows.
- Make TTL expiry and replacement actually update `lots.total_consumed_g`
  (today the reaper only flips status; consumption is silently lost).
- Backfill existing `session_resolutions` on first migration so history is
  present at launch.

**Non-goals**

- No nutrition / calorie computation. Grams only. (Multiply outside.)
- No cross-device aggregation (we're single-shelf).
- No "correction" flow if a TTL-expired item is returned later — MVP treats
  TTL expiry as final. If the user wants higher fidelity, they tune the TTL.
- No rewrite of the existing reconciler semantics. This layer READS the
  same events; it doesn't reshape how reconciler stitches them.

## 3. Data model

### 3.1 New table

```sql
CREATE TABLE usage_log (
  usage_id           TEXT PRIMARY KEY,
  -- What
  lot_id             TEXT REFERENCES lots(lot_id),       -- nullable: lot may be deleted by admin wipe
  product_id         TEXT NOT NULL REFERENCES products(product_id),
  -- Denormalised product snapshot (frozen; product can be renamed later).
  product_name       TEXT NOT NULL,
  product_brand      TEXT,
  container_type     TEXT,
  -- How much
  consumed_g         REAL NOT NULL,          -- positive = consumption, negative = topup
  pickup_weight_g    REAL,                   -- raw pickup reading
  return_weight_g    REAL,                   -- raw return reading; NULL for non-returns
  -- Why
  kind               TEXT NOT NULL CHECK(kind IN (
    'in_flight_return',                 -- normal return with consumption
    'in_flight_ttl_expired',            -- TTL reaper flipped to out
    'in_flight_replaced_new_item',      -- user put something heavier in the slot
    'reconciler_use_return'             -- legacy reconciler path (rare now)
  )),
  -- Link back
  session_id         TEXT REFERENCES sessions(session_id),
  pickup_event_id    TEXT REFERENCES scale_events(event_id),
  return_event_id    TEXT REFERENCES scale_events(event_id),  -- NULL for TTL/replacement
  -- When the consumption physically happened (return event ts, or ts
  -- the TTL reaper fired). NOT the row's created_at.
  occurred_at        TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_usage_log_occurred_at ON usage_log(occurred_at);
CREATE INDEX idx_usage_log_product    ON usage_log(product_id);
CREATE INDEX idx_usage_log_session    ON usage_log(session_id);
CREATE INDEX idx_usage_log_lot        ON usage_log(lot_id);
```

Idempotent guard against double-logging the same in-flight event pair:
add a unique index on `(pickup_event_id, kind)` with NULL-filtering via
partial index — since SQLite's `UNIQUE` ignores NULLs anyway:

```sql
CREATE UNIQUE INDEX idx_usage_log_pickup_dedup
  ON usage_log(pickup_event_id, kind)
  WHERE pickup_event_id IS NOT NULL;
```

This keeps the emitters free to call `write_usage_log` defensively without
worrying about double writes — the DB enforces uniqueness.

### 3.2 Existing table updates

Two small deltas on behaviours that currently drop consumption on the floor:

- `close_in_flight_lot_as_out` when called by the **TTL reaper** should also
  `total_consumed_g += pickup_weight_g` before clearing the in-flight cols.
- Same for the **replacement branch** in `_apply_add_against_in_flight_lot`.

These become two new repo helpers:

- `reap_in_flight_lot_as_consumed(lot_id, consumed_g, last_out_at)` —
  called by the sweeper reaper.
- `close_in_flight_as_replaced(lot_id, consumed_g, last_out_at)` — called
  by the ADD-side replacement branch.

Both clear the in-flight columns, flip status to `out`, stamp
`last_out_at`, and increment `total_consumed_g`.

## 4. Emission sites (where usage_log rows are written)

| Site                                              | `kind`                        | `consumed_g` formula                                                  |
| ------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------- |
| `_apply_add_against_in_flight_lot` — return path  | `in_flight_return`            | `pickup − return`, clamped at noise floor; can be negative for topups |
| `_apply_add_against_in_flight_lot` — replace path | `in_flight_replaced_new_item` | `pickup_weight_g` (whole item presumed gone)                          |
| `_reap_expired_in_flight`                         | `in_flight_ttl_expired`       | `pickup_weight_g` (whole item presumed gone)                          |
| reconciler `use_return_consumed` pass             | `reconciler_use_return`       | reconciler's computed `consumed`                                      |

Emission is a side-effect AFTER the lot mutation commits. Wrapped in
try/except (observability must not raise) but logged at WARNING on failure
so it's visible.

## 5. Public API

### 5.1 Repo surface (storage/repo.py)

```python
def write_usage_log(conn, row: UsageLogIn) -> UsageLog: ...

def list_usage_log(
    conn,
    *,
    product_id: Optional[str] = None,
    session_id: Optional[str] = None,
    lot_id: Optional[str] = None,
    since: Optional[str] = None,   # ISO-8601 filter on occurred_at
    until: Optional[str] = None,
    kinds: Optional[Sequence[str]] = None,
    limit: int = 100,
    offset: int = 0,
) -> list[UsageLog]: ...

def count_usage_log(conn, **same_filters) -> int: ...

def sum_usage_log_by_product(
    conn,
    *,
    since: Optional[str] = None,
    until: Optional[str] = None,
) -> list[tuple[str, float, int]]:
    """Returns (product_id, sum_consumed_g, row_count) per product."""
```

### 5.2 Model dataclasses (storage/models.py)

```python
@dataclass
class UsageLogIn:
    lot_id: Optional[str]
    product_id: str
    product_name: str
    product_brand: Optional[str]
    container_type: Optional[str]
    consumed_g: float
    pickup_weight_g: Optional[float]
    return_weight_g: Optional[float]
    kind: Literal[
        "in_flight_return",
        "in_flight_ttl_expired",
        "in_flight_replaced_new_item",
        "reconciler_use_return",
    ]
    session_id: Optional[str]
    pickup_event_id: Optional[str]
    return_event_id: Optional[str]
    occurred_at: str

@dataclass
class UsageLog(UsageLogIn):
    usage_id: str
    created_at: str
```

### 5.3 HTTP routes (web/routes.py + api_routes.py)

HTML:

- `GET /usage` — paginated list, filters via query string
  (`?product=<id>&since=YYYY-MM-DD&until=YYYY-MM-DD&kind=<k>`). Default
  view: last 30 days, newest first.
- `GET /usage/product/<product_id>` — per-product history with a totals
  summary.

JSON:

- `GET /api/usage` — same filters, returns `{items: [], total: N}`.
- `GET /api/usage/summary?since=X&until=Y` — returns
  `[{product_id, product_name, total_g, rows}]`.

## 6. UI

### 6.1 `/usage` page (usage.html)

Structure:

```
[ summary banner ]  last 30 days: 1.2 kg consumed across 14 items
                    in-flight right now: 2 items (~430 g) not yet resolved

[ filter bar ]  product ▾  since ▾  until ▾  kind ▾   [ export csv ]

[ table ]
  occurred at        product                  consumed   kind            session
  2026-04-17 12:05   Chobani Yogurt           20.0 g     return          S1
  2026-04-17 09:30   Philadelphia Cream Ch.   261.6 g    ttl expired     S0
  2026-04-16 18:12   Pulled Rotisserie Ch.    -45.0 g    topup           S-1
  ...

[ pagination ]   ← prev · 1 · 2 · 3 · next →
```

Negative `consumed_g` gets a muted colour + "topup" label instead of
"consumed". TTL-expired rows get a warning icon so the user notices the
item was auto-closed.

### 6.2 Nav

Add `/usage` to the top nav alongside registry / sessions / review.

### 6.3 Dashboard widget (bonus)

Tiny "today so far" tile:

```
today: 314 g consumed · 5 items
```

Computed via `sum_usage_log_by_product(since=<today_start>)`.

## 7. Backfill

On first boot after the migration, walk existing `session_resolutions`
and synthesize historical usage_log rows:

```sql
-- in_flight_return rows already have consumed_g and add_event_id
INSERT INTO usage_log (usage_id, lot_id, product_id, product_name,
                       product_brand, container_type, consumed_g,
                       pickup_weight_g, return_weight_g, kind,
                       session_id, pickup_event_id, return_event_id,
                       occurred_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  sr.lot_id, l.product_id, p.name, p.brand, p.container_type,
  COALESCE(sr.consumed_g, 0),
  l.pickup_weight_g, NULL,
  sr.pattern,
  sr.session_id,
  NULL, sr.add_event_id,
  COALESCE((SELECT ts FROM scale_events WHERE event_id = sr.add_event_id),
           sr.created_at),
  datetime('now')
  FROM session_resolutions sr
  JOIN lots l     ON l.lot_id = sr.lot_id
  JOIN products p ON p.product_id = l.product_id
 WHERE sr.pattern IN ('in_flight_return',
                      'in_flight_ttl_expired',
                      'in_flight_replaced_new_item',
                      'use_return_consumed');
```

Wrap the backfill in `INSERT OR IGNORE` so the unique pickup-event
dedup index makes it idempotent — re-running on an already-populated DB
is a no-op. The backfill runs exactly once per DB by checking whether
`usage_log` is empty before attempting it.

Limitation: older rows without `lots.pickup_weight_g` populated (because
lots were minted before the in-flight columns existed) will have
`pickup_weight_g = NULL` in the backfilled row. Acceptable — the
`consumed_g` value is what matters for user reporting.

## 8. Observability

New lifecycle reason codes:

- `USAGE_LOGGED` — emitted after each successful insert, payload includes
  `{usage_id, consumed_g, kind, product_id}`.
- `USAGE_LOG_WRITE_FAILED` — ERROR-level, payload `{error, kind, lot_id}`.

Logged against the originating event_id (pickup or return) so the
event-lifecycle timeline shows the usage row as the final step after
`LOT_RETURNED_FROM_FLIGHT` / `LOT_EXPIRED_IN_FLIGHT`.

## 9. Rollout order

Each step independently committable:

1. **Storage** — table + indexes + migrations test + `UsageLog`/`UsageLogIn`
   models + `write_usage_log` / `list_usage_log` / `count_usage_log` /
   `sum_usage_log_by_product` repo helpers. All new, no behaviour change
   yet.

2. **Lot mutation fix** — `total_consumed_g` now increments when the TTL
   reaper or replacement branch fires. Two new repo helpers
   (`reap_in_flight_lot_as_consumed`, `close_in_flight_as_replaced`).
   Update the two call sites in `scale_events.py`. Tests for both.

3. **Emission sites** — wire `write_usage_log` into the return /
   replacement / TTL reaper / reconciler code paths. Unit tests for each
   (mock storage, assert a usage_log row is inserted with the right
   shape). Deploys silently start populating the log on real events.

4. **Backfill** — idempotent one-time synthesis from existing
   `session_resolutions` on boot. Migration-test with seeded rows.

5. **HTTP / UI** — web adapter methods (`list_usage`, `usage_summary`),
   `/usage` route + template, `/api/usage` route, nav entry, dashboard
   "today" tile. Jinja + htmx-free (match the existing server-rendered
   pattern).

6. **Polish** — CSV export endpoint (`GET /usage.csv?...`), empty-state
   copy, sort + filter controls.

7. **Deploy + smoke test** — push to Pi, verify backfill ran, click
   through `/usage`, trigger a real return cycle and watch the row
   appear.

## 10. Testing plan

### 10.1 Unit — storage

- `test_usage_log_write_returns_row_with_id`
- `test_usage_log_pickup_event_unique_prevents_duplicates`
- `test_list_usage_log_filters_by_product`
- `test_list_usage_log_filters_by_date_range`
- `test_sum_usage_log_by_product_aggregates_correctly`
- `test_usage_log_table_migration_idempotent`

### 10.2 Unit — lot mutations

- `test_reap_in_flight_increments_total_consumed_g`
- `test_replacement_branch_increments_total_consumed_g`

### 10.3 Unit — emission

- `test_in_flight_return_emits_usage_log_with_delta_consumption`
- `test_in_flight_return_with_topup_emits_negative_consumed_g`
- `test_in_flight_ttl_expired_emits_usage_log_with_pickup_weight`
- `test_in_flight_replaced_emits_usage_log_with_pickup_weight`
- `test_reconciler_use_return_emits_usage_log`
- `test_usage_log_write_failure_does_not_break_apply_path`

### 10.4 Integration

- `test_full_cycle_return_writes_usage_log` — same-session pickup then
  return, assert row exists with correct consumed_g.
- `test_full_cycle_ttl_expiry_writes_usage_log` — pickup then wait past
  TTL, assert row.
- `test_full_cycle_replacement_writes_usage_log` — pickup then heavy
  return, assert row with pickup_weight as consumed.
- `test_backfill_synthesizes_from_existing_resolutions`
- `test_backfill_is_idempotent_across_restarts`

### 10.5 Web

- `test_usage_page_renders`
- `test_usage_page_shows_filter_by_product`
- `test_api_usage_returns_paginated_json`
- `test_api_usage_summary_returns_product_totals`

## 11. Schema invariants

Enforced by the DB + tests:

- Every `in_flight_return` / `in_flight_ttl_expired` /
  `in_flight_replaced_new_item` session_resolutions row has exactly one
  `usage_log` row with the matching `pickup_event_id` (after migration
  - backfill).
- `consumed_g` is never NULL.
- `kind` is one of the four literals.
- `occurred_at ≥ created_at` is false (occurred_at can be earlier); both
  are ISO-8601 strings.
- Summing `consumed_g` per lot equals `lots.total_consumed_g` (within
  floating-point tolerance) at any consistent snapshot point.

## 12. Open decisions

1. **Topups as separate kind?** Currently an `in_flight_return` with
   negative consumed_g renders as "topup" in the UI but stays kind=
   `in_flight_return`. Alternative: split into a distinct `kind='topup'`.
   Trade-off: simpler query for "consumption only" (`WHERE consumed_g >
0`) is nice to have, but two row shapes for what's fundamentally the
   same event type is clutter. Default: keep one kind; UI filters by
   sign.

2. **Should cross-session reconciler returns still emit?** The reconciler
   can write `use_return_consumed` when fast-path didn't run. We should
   emit a usage*log row to preserve coverage. But if the fast-path DID
   run, we MUST NOT double-log. The unique index on
   `(pickup_event_id, kind)` — with `kind` differing between fast-path
   and reconciler — doesn't naturally dedup. Mitigation: reconciler's
   usage_log emission checks "was there already a usage_log row with
   pickup_event_id = <this remove_event_id> and kind starting with
   'in_flight*'?" and skips if so. Alternative: change the unique index
   to `(pickup_event_id)` without kind, so ANY duplicate is rejected —
   cleaner. Default: `(pickup_event_id)` alone, no `kind`.

3. **Display TZ.** Store ISO-8601 UTC; let the template render in browser
   local time via a small client-side formatter. No schema impact.

4. **Retention.** Single-user demo — no retention policy. The DB will
   grow by ~one row per unique consumption event, which even at a
   generous 50/day is 18k rows/yr — fine for SQLite.

---

_End of plan._
