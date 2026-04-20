# In-Flight Tracker — Plan

Date: 2026-04-17
Status: plan only — no code written
Scope: `hardware/live-shelf/server/`

---

## 1. What it is

An in-flight tracker tells us, in real time, which items are currently *off the
shelf but expected back* — so the UI can distinguish "this yogurt is being
eaten right now" from "this yogurt is gone for good." When the item comes back,
the weight difference is recorded as consumption. If the returning mass is
materially heavier than the pickup mass, the lot is closed and a new lot is
minted instead — the user swapped items.

Today the system goes `on_shelf → out` on REMOVE and mints a new lot on ADD;
the reconciler later stitches pickup/return pairs into `use_return_consumed` /
`new_arrival` resolutions at session close. The in-flight tracker elevates that
stitching to event-time, makes it a first-class lot status, and tightens the
new-item threshold into the fast path.

## 2. Goals / non-goals

**Goals**
- Lot status `in_flight` visible the moment a REMOVE applies, not after session close.
- Same-item return across or within sessions computes `consumption_g =
  pickup_weight_g - return_delta_g`, clamped at noise floor, added to
  `total_consumed_g`.
- Significantly heavier return (> pickup × `NEW_ITEM_WEIGHT_RATIO`) closes the
  in-flight lot as `out` and mints a new lot for the returned mass.
- TTL: if an in-flight lot doesn't return within `IN_FLIGHT_TTL_SECONDS`, it
  transitions to `out` (same terminal state as today).

**Non-goals**
- No replacement for the reconciler. Reconciler still runs at session close
  and provides the authoritative resolution log; in-flight is the fast path.
- No attempt to track *which physical container* was picked up when a single
  product has multiple lots (e.g., two Philly tubs). The classifier picks a
  specific lot_id, and that's the one flagged in-flight.
- No support for items that were in-flight *before* the feature shipped.
  Migration is forward-only; legacy `out` lots stay `out`.

## 3. Data model changes

### 3.1 `lots` table

Extend the status check constraint and add four columns:

```sql
-- Migration (idempotent, via server/storage/migrations.py):
ALTER TABLE lots ADD COLUMN in_flight_since      TEXT;
ALTER TABLE lots ADD COLUMN pickup_weight_g      REAL;
ALTER TABLE lots ADD COLUMN pickup_event_id      TEXT REFERENCES scale_events(event_id);
ALTER TABLE lots ADD COLUMN pickup_session_id    TEXT REFERENCES sessions(session_id);

-- Status enum extension: use the existing _apply_column_additions pattern
-- that rebuilds the CHECK constraint (already in place for the
-- on_shelf/out/depleted/relocated/lost migration history). Add 'in_flight'
-- as a valid status.
```

Invariants (enforced by code, not DB):
- `status='in_flight'`  ⇒  all four new columns non-NULL.
- `status` in `('on_shelf','out','depleted',…)` ⇒ all four new columns NULL.
- `in_flight_since` monotonically ≥ `last_seen_at`.

### 3.2 `session_resolutions` — new patterns

Additive to the existing `pattern` check constraint. None of the existing
patterns change semantics.

| Pattern                        | When written                                    | `consumed_g` |
| ------------------------------ | ----------------------------------------------- | ------------ |
| `in_flight_pickup`             | REMOVE applied with status → `in_flight`        | NULL         |
| `in_flight_return`             | ADD applied against an in-flight lot, ≤ pickup  | pickup − add |
| `in_flight_replaced_new_item`  | ADD against in-flight slot, heavier than pickup | NULL *       |
| `in_flight_ttl_expired`        | TTL reaper flipped in-flight → out              | NULL         |

\* The closed in-flight lot gets `in_flight_replaced_new_item` (no
consumption accounting — we can't tell what happened to it). The *new* lot
that's minted gets the usual `new_arrival` pattern.

### 3.3 `event_lifecycle` — new reason codes

Append to `server/storage/lifecycle.py` `ReasonCode`:

- `LOT_MARKED_IN_FLIGHT`
- `LOT_RETURNED_FROM_FLIGHT`
- `LOT_REPLACED_IN_FLIGHT`   (new item closed the in-flight slot)
- `LOT_EXPIRED_IN_FLIGHT`    (TTL reaper)

Payloads carry `lot_id`, `pickup_weight_g`, `return_delta_g` (where
applicable), `consumption_g`, `ttl_seconds`.

## 4. Behaviour — happy path + edges

### 4.1 Happy-path REMOVE (single item in-flight)

1. User lifts yogurt at 200g.
2. ESP emits REMOVE, delta_g=-200.
3. `_apply_lot_update_from_classification` picks yogurt lot (classified).
4. Instead of today's `status='out', last_out_at=event_ts`, we write:
   - `status = 'in_flight'`
   - `in_flight_since = event_ts`
   - `pickup_weight_g = <lot.current_weight_g before REMOVE>`
   - `pickup_event_id = event_id`
   - `pickup_session_id = session_id`
   - `last_seen_at = event_ts`    (preserved)
5. Session resolution row: `in_flight_pickup`, `consumed_g=NULL`.
6. Lifecycle: `LOT_MARKED_IN_FLIGHT`.

### 4.2 Happy-path ADD (return, lighter)

1. User returns the yogurt at 180g (ate 20g).
2. ESP emits ADD, delta_g=+180.
3. Candidate pool (see §5) ranks in-flight lots highest. Classifier picks
   the yogurt.
4. Apply path detects `status='in_flight'` on the picked lot AND the ADD
   delta is ≤ `pickup_weight_g × NEW_ITEM_WEIGHT_RATIO` (default 1.15).
   → *return* branch:
   - `consumption_g = max(0, pickup_weight_g − delta_g) = 20g`
   - If `|consumption_g| < CONSUMPTION_NOISE_FLOOR_G` (default 2g), clamp to 0.
   - `status = 'on_shelf'`
   - `current_weight_g = delta_g`
   - `total_consumed_g += consumption_g`
   - Clear the four in-flight columns.
   - `last_seen_at = event_ts`
5. Session resolution: `in_flight_return`, `consumed_g=20.0`.
6. Lifecycle: `LOT_RETURNED_FROM_FLIGHT`.

### 4.3 Edge: heavier return → new item

1. User lifts the 200g yogurt container but instead comes back with a 450g
   bowl of soup in its place.
2. ADD delta=+450. Classifier may pick the yogurt lot (recently in-flight,
   similar position) or may pick a catalog candidate. Apply path sees:
   - Picked candidate is an in-flight lot, AND
   - `delta_g > pickup_weight_g × NEW_ITEM_WEIGHT_RATIO`  (450 > 200·1.15=230)
   → *replacement* branch:
   - Close the in-flight lot as `status='out'`, `last_out_at=event_ts`,
     clear the in-flight columns.
   - Mint a NEW lot for the 450g item using the existing new-arrival path
     (either via catalog_not_on_shelf pick or via UNKNOWN new-lot creation).
3. Session resolutions: two rows
   - Old lot: `in_flight_replaced_new_item`, `consumed_g=NULL`.
   - New lot: `new_arrival`, `consumed_g=NULL`.
4. Lifecycle: `LOT_REPLACED_IN_FLIGHT` on the old lot + usual `LOT_MUTATED`
   on the new one.

### 4.4 Edge: in-flight TTL expiry

A reaper thread (folds into the existing scale-events-sweeper 5s tick) scans
`lots` where `status='in_flight'` and `datetime(in_flight_since) +
IN_FLIGHT_TTL_SECONDS < now`. For each:
- `status = 'out'`, `last_out_at = <in_flight_since + TTL>`, clear in-flight
  columns.
- Session resolution: `in_flight_ttl_expired`, scoped to the pickup session.
- Lifecycle: `LOT_EXPIRED_IN_FLIGHT`.

### 4.5 Edge: multiple in-flight lots, partial return

User lifts A+B (one event, multi_match), returns only A. The ADD event applies
against A (classifier picks A or weight-fit promotes it); B stays in-flight
until TTL. This works with zero special-casing because §4.1–§4.4 act on a
single lot at a time.

### 4.6 Edge: in-flight returns in a DIFFERENT session

User lifts A at 200g, closes door. Five minutes later, opens door, puts A
back at 180g. This is two sessions:
- Session 1 contains the REMOVE → `in_flight_pickup` row.
- Session 2 contains the ADD → `in_flight_return` row. Note the returning
  session_id differs from `pickup_session_id`; both rows are written,
  linked by `lot_id` and the classifier's match.

### 4.7 Edge: tiny consumption (sensor noise)

User lifts A at 200g, reads a label, puts back at 199.3g. `consumption_g =
0.7g` falls below the noise floor and clamps to 0. Pattern becomes
`in_flight_return` with `consumed_g=0.0` (not `use_return_no_consumption` —
we keep the in-flight pattern family distinct so the reconciler can tell
fast-path returns from post-hoc stitched returns).

### 4.8 Edge: weight delta fits within tolerance AT pickup_weight

If `|delta_g − pickup_weight_g| < CONSUMPTION_NOISE_FLOOR_G` the user
evidently just picked it up and set it back down. Same `in_flight_return`
row with `consumed_g=0.0`, no lot weight change.

### 4.9 Edge: gained a little but not enough to count as new item

E.g. pickup 200g, return 220g. Ratio = 1.1, under the 1.15 threshold.
Interpretation: user topped up. Two sub-options:
- **A (recommended)**: treat as `in_flight_return` with `consumed_g = -20g`
  (negative consumption = addition). `total_consumed_g` stays clamped at ≥ 0.
- **B**: promote to `topped_up` pattern (already in the schema) and leave the
  classifier's action `added_to_existing` as the primary evidence. Only
  applies when the classifier's action agrees.

Pick one deterministically based on the classifier's emitted `action`:
`added_to_existing` → pattern B; `added` or absent → pattern A.

## 5. Candidate-pool changes (`classifier/candidate_pool.py`)

### 5.1 Add `in_flight` branch to the ADD pool

Current ADD pool (§6.1 of `docs/plan.md`): `recently_out` ∪ `catalog_not_on_shelf`.

New ordering: `in_flight` > `recently_out` > `catalog_not_on_shelf` > sentinel.

- `in_flight` lots are loaded via `candidate_source.get_in_flight_lots()`
  (new method on the `CandidateSource` protocol; SQL =
  `SELECT … FROM lots WHERE status='in_flight'`).
- why_candidate string: `"in_flight"` (new `CandidateReason` literal).
- Rank score: bias by proximity of `delta_g` to `pickup_weight_g` on the
  existing weight-proximity scorer, then multiply by 2.0 so an in-flight lot
  outranks a recently_out lot with the same weight fit. (In-flight lots are
  strictly more likely to be the returning item than a lot that left hours
  ago.)

### 5.2 REMOVE pool unchanged

REMOVE pool already uses `status='on_shelf'`. In-flight lots don't appear
there because they aren't on the shelf — correct behaviour.

### 5.3 Pool adapter

`adapters/candidate_source.py` adds `get_in_flight_lots(session_id=None,
max_age_seconds=None)` that returns `LotCandidate`s with
`expected_weight_g = pickup_weight_g` (so the classifier sees the weight the
user *took*, which is what it should match the ADD delta against). Optional
filters let the reconciler or UI query a subset.

## 6. Apply-path changes (`handlers/scale_events.py`)

Three small diffs, contained within the existing `_apply_lot_update_from_classification`:

1. **REMOVE path** (after the existing lot-resolution + dedup guards): if
   this is a REMOVE and the lot resolved to `status='on_shelf'`, write
   `status='in_flight'` + the four new columns instead of `status='out'`.
   Emit the `in_flight_pickup` session_resolutions row.

2. **ADD path, picked lot is in-flight**: branch on the ratio
   `delta_g / pickup_weight_g`:
   - `≤ NEW_ITEM_WEIGHT_RATIO` (default 1.15): return branch (§4.2).
   - `>  NEW_ITEM_WEIGHT_RATIO`: replacement branch (§4.3).

3. **Short-circuit the reconciler's use_return path for events with an
   `in_flight_*` resolution already written.** The reconciler's pass 3
   (leftover ADDs → use_return_consumed or new_arrival) needs to skip any
   ADD event already stamped with an `in_flight_return` or
   `in_flight_replaced_new_item` row. This prevents duplicate resolutions.

### 6.1 Helper to add

```python
def _apply_in_flight_branch(
    lot, direction, delta_g, event_ts, session_id, event_id, classification
) -> str | None:
    """Return a session_resolutions pattern if this event was handled by
    the in-flight branch; return None to fall through to normal apply."""
```

Unit tests cover each branch (return lighter, return equal, return heavier
within ratio, return heavier beyond ratio → replacement).

## 7. Reconciler changes (`reconciler/reconcile.py`)

Reconciler stays the authoritative source of truth at session close. Changes:

1. Pass 3 (leftover ADDs): skip any ADD event that already has an
   `in_flight_return` or `in_flight_replaced_new_item` resolution —
   those are done.
2. Pass 2 (REMOVE events): `in_flight_pickup` rows are terminal for that
   event's resolution; do not pair them with an ADD in the same session
   unless the ADD is separately unpaired (which it won't be, because §7.1
   already consumed it).
3. Add a Pass 4: in-flight lots that are still `status='in_flight'` at
   reconciler run time with `pickup_session_id == this session_id` AND
   `in_flight_since + IN_FLIGHT_TTL_SECONDS` already in the past → flip to
   `out` + write `in_flight_ttl_expired`. This is the reconciler-driven
   half of the TTL reaper; the sweeper half handles cross-session TTLs.

## 8. Sweeper changes (`handlers/scale_events.py::sweep_orphans`)

Add a `_reap_expired_in_flight()` helper invoked on each 5s tick. Scans
`lots WHERE status='in_flight' AND in_flight_since + IN_FLIGHT_TTL_SECONDS <
now()` in chunks (LIMIT 50) to bound work per tick. Each reaped lot gets
the §4.4 treatment.

## 9. Config knobs (`config.py` + `.env`)

Three new config values, all with sensible defaults:

| Name                               | Default | Purpose                                       |
| ---------------------------------- | ------- | --------------------------------------------- |
| `IN_FLIGHT_TTL_SECONDS`            | 14400   | 4 h. After this, in-flight → out.             |
| `NEW_ITEM_WEIGHT_RATIO`            | 1.15    | delta > pickup·this → replacement branch.     |
| `CONSUMPTION_NOISE_FLOOR_G`        | 2.0     | |consumption| below this clamps to 0.        |

All three are runtime-tunable through the existing `/api/config` route
(already supports whitelist-based PATCH in `config.py`). Add them to the
whitelist.

## 10. UI surface

Minimal, HTML-only changes to match the existing dashboard aesthetic.

### 10.1 Dashboard shelf card

Lots currently `in_flight` render under a new "In Flight" section, above
"On Shelf":

```
In Flight (2)
  ● Philadelphia Cream Cheese — 261 g, taken 3 min ago
  ● Pulled Chicken           — 248 g, taken 3 min ago

On Shelf (3)
  …
```

Each in-flight row shows `pickup_weight_g`, `in_flight_since` rendered as
"N min ago", and (once JS is cheap) a live countdown to TTL.

### 10.2 Event detail

Each event rendered with a "Paired with" line linking to its partner:
- REMOVE that marked in_flight → links to the return ADD event (or "TTL
  expired" if reaped).
- ADD that returned from in_flight → links to the pickup REMOVE event,
  plus the computed consumption figure.

### 10.3 Lots list page

Add `status='in_flight'` to the filter dropdown; column showing
pickup_weight and consumption-so-far (0 for in-flight, > 0 for returned
lots whose `total_consumed_g` > 0).

## 11. Migrations

Two migrations, both in `server/storage/migrations.py::_apply_column_additions`:

1. **Column additions** — the four new columns on `lots`. Idempotent
   `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pattern already in use.
2. **Status enum extension** — follow the existing recipe in
   `_apply_column_additions` that rebuilds `lots` with a new CHECK
   constraint when a prior version's enum is detected. The migration test
   suite (`server/storage/tests/test_migrations.py::test_apply_column_additions_upgrades_old_check_constraint_preserving_rows`)
   already exercises this shape — mirror it for the in-flight enum bump.

Also: `session_resolutions.pattern` CHECK constraint gets the four new
literals added (same rebuild pattern).

No migration is needed for existing `out` lots. Legacy rows stay `out`.

## 12. Testing plan

### 12.1 Unit tests — `handlers/tests/`

- `test_apply_remove_marks_in_flight_not_out`
- `test_apply_add_to_in_flight_lighter_returns_with_consumption`
- `test_apply_add_to_in_flight_equal_weight_is_zero_consumption`
- `test_apply_add_to_in_flight_heavier_within_ratio_is_return_with_topup`
- `test_apply_add_to_in_flight_beyond_ratio_replaces_lot`
- `test_consumption_below_noise_floor_clamps_to_zero`
- `test_in_flight_columns_cleared_on_return`
- `test_in_flight_columns_cleared_on_replacement`

### 12.2 Unit tests — `classifier/tests/`

- `test_in_flight_branch_added_to_add_pool`
- `test_in_flight_outranks_recently_out_at_equal_weight_fit`
- `test_in_flight_expected_weight_uses_pickup_weight`

### 12.3 Migration tests — `storage/tests/test_migrations.py`

- `test_adds_in_flight_columns_to_lots`
- `test_extends_status_enum_to_include_in_flight_preserving_rows`
- `test_extends_resolution_pattern_enum_preserving_rows`
- Both migrations idempotent.

### 12.4 Sweeper test — `handlers/tests/`

- `test_sweeper_reaps_expired_in_flight_lots_to_out`
- `test_sweeper_leaves_fresh_in_flight_alone`

### 12.5 Reconciler tests — `reconciler/tests/test_reconcile.py`

- `test_reconciler_skips_adds_with_in_flight_return_already_written`
- `test_reconciler_skips_removes_with_in_flight_pickup_already_written`
- `test_reconciler_reaps_in_flight_at_session_close_if_ttl_expired`

### 12.6 Integration test

`server/tests/test_in_flight_end_to_end.py` — one test per flow:
- Same-session pickup → return → consumption recorded.
- Cross-session pickup → return → consumption recorded.
- Pickup → heavier return → new lot minted, old lot closed.
- Pickup → TTL expiry → status=out, no return happens.
- Pickup A+B → return A only → A on_shelf, B in_flight until TTL.

### 12.7 Web-route test — `web/tests/test_routes.py`

- Dashboard renders `In Flight` section with the correct lots.
- Lot detail page shows `pickup_weight_g` and consumption link.
- Event detail pages link pickup ↔ return.

### 12.8 pgTAP-style-equivalent: invariant tests

- An `in_flight` lot always has all four in-flight columns non-NULL.
- A non-`in_flight` lot always has all four in-flight columns NULL.
- `total_consumed_g ≥ 0`.
- Every `in_flight_return` row has a corresponding `in_flight_pickup` row
  referenced by `lot_id`.

## 13. Observability

Each new state transition emits exactly one `event_lifecycle` row. Dashboards
/metrics derived from lifecycle pick up the new reason codes for free. No new
SYSTEM_HEALTH columns needed; in-flight counts can be derived from `lots`.

Log lines (at INFO):
- `lot <lot_id[:8]> → in_flight (session=<sid[:8]>, pickup=<weight>g)`
- `lot <lot_id[:8]> returned (consumption=<g>, session=<sid[:8]>)`
- `lot <lot_id[:8]> replaced by new item (return_delta=<g>, ratio=<f>)`
- `lot <lot_id[:8]> expired in-flight (age=<seconds>s)`

## 14. Rollout — implementation order

Implement in this order so each step is independently testable and deployable:

1. **Storage** — migrations, repo helpers (`create_lot` already takes status
   via `LotIn`; add `mark_lot_in_flight()`, `return_lot_from_flight()`,
   `replace_in_flight_lot()`, `reap_in_flight_lot()`). Includes migration
   tests. No behaviour change yet.
2. **Config** — three new knobs + `/api/config` whitelist entries + tests.
3. **Candidate pool** — `get_in_flight_lots()` + new branch in the ADD pool
   + classifier-side unit tests. Still no behaviour change for real events
   because the apply path doesn't yet emit `in_flight` status.
4. **Apply path — REMOVE side only** — mark lots `in_flight` instead of
   `out`. This alone is a visible behaviour change — deploy behind a
   feature flag env `IN_FLIGHT_ENABLED=1` so we can diff a day of data
   before/after.
5. **Apply path — ADD side** — return, topup-within-ratio, replacement
   branches. Unit + integration tests green on the dev machine before
   deploy.
6. **Sweeper + reconciler TTL/skip logic** — no new user-visible behaviour,
   just plumbing to keep long-lived in-flight lots from accumulating and to
   keep the reconciler and fast path from double-resolving events.
7. **UI** — dashboard In-Flight section, event pairing, lot list filter.
8. **Feature flag removal** — once stable, delete `IN_FLIGHT_ENABLED` and
   make the path unconditional.

Each step is committable on its own and each ships with its own tests.

## 15. Open decisions / questions

1. **Should `in_flight` count toward shelf stock on the dashboard?** Probably
   yes — the item is expected back, so "how much cream cheese do I have" is
   unchanged. But list pages may want to visually separate. Default: count
   as owned, display distinctly.
2. **Should the reconciler's `use_return_consumed` stay, or fold entirely
   into `in_flight_return`?** Keep both for now. `use_return_consumed` is
   the post-hoc stitched resolution (used when the fast path didn't run —
   e.g. the classifier was down, or the old code ran). `in_flight_return`
   is the fast-path resolution. Two patterns with clearly distinct
   provenance.
3. **`NEW_ITEM_WEIGHT_RATIO` direction asymmetry?** Currently proposed as
   one-sided (gain > ratio triggers replacement). Losses never trigger
   replacement — the item just consumed a lot. Confirm this is desired.
   Default: yes, asymmetric.
4. **Cross-device behaviour?** Not applicable — we're single-shelf,
   single-scale, single-user. But the DB schema doesn't need changing if we
   ever shard (in_flight columns are still per-lot).
5. **Visual-only placeholder?** A partial door-open where the user never
   lifts an item, then closes. No scale event fires, nothing goes in-flight,
   no change needed.

---

*End of plan.*
