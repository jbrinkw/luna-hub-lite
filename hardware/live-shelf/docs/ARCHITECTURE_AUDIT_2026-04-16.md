# Live Shelf Architectural Audit

> **Status:** Pi-local architecture analysis as of April 2026. Cloud integration layer added after this audit — see `PROD_MIGRATION_PLAN.md`. This document's R1–R9 recommendations may or may not still apply.

Date: 2026-04-16
Scope: `hardware/live-shelf/server/` — scale-event-to-inventory pipeline.
Author: Architecture audit (not implementation). No code is changed here;
this document exists to describe what is, what is wrong at the level of
design, and how a principled redesign would look.

---

## Executive summary

The Live Shelf server has a working, production-deployed pipeline that
reliably turns HX711 scale events + USB-camera frames into classified lot
mutations for a single-user CV demo. Each individual bug fixed this
session was real — but the cadence of "fix one thing, next thing breaks"
is not a coincidence. It is the signature of **a system with too many
semi-independent sources of truth, loosely coordinated through shared
in-memory globals + shared SQLite + ad-hoc time bounds, and stitched
together by multiple concurrent threads whose ordering is implicit**.

The five structural problems at the root of the bug cluster:

1. **Session identity is split across three stores** (sessions table,
   `session_capture._CURRENT/_CLOSED`, `app_state.current_session_id`)
   that are updated in different orders by different threads.
2. **Event-to-session attribution has at least five disagreeing rules**
   scattered through ingress, close-hook, sweeper, back-stamp and
   frame-lookup paths.
3. **Clock domains (ESP RTC, Pi wall clock, SQLite `datetime('now')`)
   are compared directly** in several places; every such comparison has
   been an independent bug.
4. **Frame-to-event correlation is probabilistic**, based on heuristics
   (settle delay, brightness cutoffs, prior-event inheritance) rather
   than a physical anchor (scale-weight trajectory or motion detection).
5. **The review queue is a read-only museum**, not a first-class state
   machine coupled to lot mutations. Resolution was a stub until this
   session's fix.

The fix is not another patch. It is **one authoritative Session object
owning session lifecycle, event membership, and frame timeline; one
attribution function; one event lifecycle state machine with explicit
transitions; and principled scoring for classifier output**. Concrete
redesigns follow below.

---

## Current architecture

### ASCII boxes + arrows

```
                                   +------------------+
                                   |   ESP8266        |
                                   |  HX711 x4 +      |
                                   |  WiFi + LEDs     |
                                   +--------+---------+
                                            |
                     HTTP POST /api/scale-event     (ESP clock ts)
                     HTTP POST /api/scale-heartbeat (every 500 ms)
                                            |
                                            v
+-------------------------+      +----------+----------------------+
|  USB camera (/dev/v0)   |      |  Flask request thread           |
|  ring buffer (30 s)     |      |  handlers/scale_events.py       |
|                         |      |   - validate                    |
|  camera/daemon.py       |      |   - dedup LRU                   |
|    capture thread       |      |   - read app_state              |
|    brightness watcher   |      |   - insert scale_events row     |
|    on_frame callback  --+----> |   - (maybe) dispatch classify   |
+-----------+-------------+      +----------+----------------------+
            |                               |
            | on brightness rise/fall       | on session_capture closed
            |                               v
            |                    +-----------------------------+
            v                    |  Background classify thread |
+---------------------------+    |  (bounded by semaphore=3)   |
| brightness watcher thread |    |  - copy frames into event/  |
|  -> handlers/brightness   |    |  - build candidate pool     |
|     (open/close rows)     |    |  - Anthropic call (2-5 s)   |
|  -> camera/session_capt.  |    |  - write classification     |
|     (frame pick, mp4)     |    |  - (maybe) apply lot update |
|     on_close_callback     |    |  - (maybe) enqueue review   |
|     -> process_session_ev +--->|                             |
+---------------------------+    +-------------+---------------+
                                               |
                                               v
                                   +-----------+--------------+
                                   | reconciler thread        |
                                   | reconcile_session(sid)   |
                                   | - 4 passes               |
                                   | - write resolutions      |
                                   +--------------------------+

Sweeper (5 s loop)  reads pending events, re-tries attribution, eventually
marks failed after 60 s with a sensor_anomaly review row.
```

Four independent execution domains share one SQLite connection guarded
by `db_lock`, one in-memory `_CURRENT`/`_CLOSED` set guarded by
`_LOCK`, and one dedup LRU with its own lock. They coordinate mostly
implicitly through timestamps.

### Responsibilities (who writes what)

| Store | Written by | Read by |
|---|---|---|
| `sessions` row | brightness watcher (on open/close) | reconciler, scale_events, adapters |
| `app_state.current_session_id` | brightness watcher (open clears, close nulls), wipe | scale_events ingress (fast path) |
| `session_capture._CURRENT` | session_capture `_handle_open`, `_handle_frame` | `get_frames_for_event`, sweeper |
| `session_capture._CLOSED` deque | session_capture `_handle_close`, video encoder | `get_frames_for_event`, sweeper |
| `scale_events` row | ingress, classify thread, sweeper (status), synth gap | close-hook, sweeper, reconciler, UI |
| `lots` | classify thread, reconciler, intake, admin | UI, classifier pool builder, reconciler |
| `review_queue` | classify thread, reconciler, sweeper | UI `/review` routes, `apply_user_reviewed_candidate` |
| dedup LRU | ingress, heartbeat (reboot purge) | ingress |
| wipe epoch | admin wipe | every classify write site |

### The three executions per close

When a door-close brightness transition fires, **three subscribers run
in sequence on the same brightness-watcher thread**:

1. `BrightnessHandler._on_close` — writes `sessions.ended_at`, nulls
   `app_state.current_session_id`.
2. `session_capture._handle_close` — filters lit frames, picks
   before/after, publishes `_CLOSED` entry, spawns video encode thread,
   fires `on_close_callback`.
3. `on_close_callback` is `ScaleHandler.process_session_events` —
   scans DB for pending events, classifies each inline, synthesizes
   gap REMOVE if necessary, spawns reconciler thread.

This order is load-bearing. It was bug #743a to spawn the reconciler
from (1) because it ran before (3) classified anything. The fix moved
the reconciler spawn to the tail of (3). But the ordering is **encoded
only in subscription order**, not in a data structure that enforces it.

---

## Fundamental problems

### P1. Clock-domain soup

At least five distinct clock domains coexist:

- **ESP RTC** — set by NTP on ESP boot. Provides `ts` on
  `/api/scale-event` and `/api/scale-heartbeat` payloads.
- **ESP millis since boot** — implicit in `motion_start_ms_before` and
  `stability_window_ms`; resets on reboot.
- **Pi wall clock** — source of `pi_received_ts`
  (`handlers/scale_events.py:656`, `now_iso_utc_ms()`).
- **SQLite `datetime('now')`** — stamps `scale_events.created_at`,
  `sessions.started_at` default, `app_state.updated_at`. Uses
  **space-separated** format, not `T`-separated ISO-8601.
- **`time.monotonic()`** — `get_frames_for_event` deadline, video wait.

The code does direct comparisons across domains in several places. Three
concrete instances:

- `sessions.started_at` is Pi wall clock via `brightness_handler`'s
  `evt.ts_iso` which comes from the camera daemon's `now_iso_utc_ms()`.
  `scale_events.created_at` is SQLite `datetime('now')` — also Pi
  clock, but **in a different string format**. The query in
  `process_session_events` normalizes via `datetime(...)`
  (`scale_events.py:840`) but this was a past bug, and the invariant
  that "both are Pi clock" is enforced only in comments.
- `scale_events.ts` is ESP clock. `_find_prior_event_pi_ts_in_session`
  queries `ts < ?` (line 1256) — comparing ESP clocks against each
  other, which is fine, but the returned value is then **passed into
  `pick_event_frames` as a Pi-clock timestamp** (via the callsite at
  1412). ESP-Pi skew of ~900 ms turns the "prior event's after" frame
  into a frame picked from ~1 s before it actually settled. The skew
  is usually small enough that the brightness cutoff saves it.
- `sweep_orphans` uses `strftime('%Y-%m-%dT%H:%M:%SZ', created_at)` at
  line 1065 to convert the SQLite space-separated format to ISO-8601
  before handing to `get_frames_for_event`. This is a conversion
  shim — evidence that the clock-domain boundaries are real and
  mishandled in at least two formatting conventions inside one schema.

The comment at `scale_events.py:823` — "Fix: correlate by Pi clock,
not ESP clock" — is a load-bearing rule documented only in a comment.

**The underlying problem:** the design never committed to a single
wire-side timebase with an explicit conversion boundary.

### P2. Session identity fragmentation

There are three session identifiers that refer to "the same thing":

- `sessions.session_id` (UUID) — the canonical DB row.
- `sessions.started_at` == `session_capture._CURRENT["open_ts"]` == the
  ISO string used as a directory name. This is the **human-readable
  key** used everywhere in session_capture.
- `app_state.current_session_id` — a pointer into `sessions`, nulled on
  close. Used only by the fast path at ingress.

`_find_session_id_by_open_ts` (line 915) exists solely to reconcile the
second to the first. It uses `started_at = ?` exact string match — which
works because `brightness_handler._on_open` and
`session_capture._handle_open` receive the same `evt.ts_iso`. If the
formatting ever diverges, the mapping silently fails and the reconciler
doesn't spawn ("no DB session row matched open_ts=...").

Known divergences that have bitten:

- **Zombie `current_session_id` across Pi reboots**: the sessions row
  persisted `ended_at=NULL` while `app_state.current_session_id`
  pointed at it. Fixed by startup cleanup.
- **Wipe FK violation**: deleting sessions before clearing
  `current_session_id`.
- **Session in `_CURRENT` but row in DB closed**: observed when two
  door-open transitions come in fast enough that
  `BrightnessHandler._on_open` refuses the second (session already
  active) but `session_capture._handle_open` accepts and drops the
  orphan.

**The underlying problem:** there is no single object that owns "a
session." There are three views, and the invariant "they agree" is
enforced only by convention.

### P3. Event-to-session attribution inconsistency

Survey of every attribution rule in the code:

1. **Ingress fast path** (`handle_scale_event`, line 731): read
   `app_state.current_session_id` atomically with the row insert.
   If door just closed, this is `NULL` and the event is stamped
   `session_id=NULL`.
2. **Ingress frame-lookup** (line 762): `get_frames_for_event` using
   `pi_received_ts` and the grace window. Completely independent of the
   session_id stamped in (1).
3. **Close-hook selection** (`process_session_events`, line 840):
   `datetime(created_at) BETWEEN open_ts AND close_ts + 30 s`.
   Pi-clock only.
4. **Sweeper selection** (`sweep_orphans`, line 1060): same as (3), but
   iterates per row and re-calls `get_frames_for_event`. Adds a safety
   check against both `_CURRENT` and the recently-closed DB session
   (line 1144-1188).
5. **Back-stamp during classify** (`_classify_recorded_event`, line
   1391): if the event row has `session_id=NULL`, look up the session
   by the frame-matching result's `open_ts` and back-stamp the row.
6. **`get_frames_for_event`** (session_capture line 719): matches
   `open_ts ≤ event_ts ≤ close_ts + 30 s`, with a special case giving
   precedence to a currently-open session over a stale-grace previous
   session.
7. **Reconciler event fetch**
   (`adapters/reconciler_repo.get_events_for_session`): pure SQL
   `WHERE session_id = ?`. Relies on (1) or (5) being correct.
8. **`_maybe_synthesize_remove_gap`** (line 963-991): filters events
   with `session_id = ? AND ts <= close_ts` — ESP clock compared to
   Pi clock. Usually within skew tolerance; occasionally exclude a
   legitimate in-session event.

These rules can and do disagree. Historical symptoms:

- Event stamped with old `current_session_id` via fast path, then
  `get_frames_for_event` matches a different (newer, post-open-race)
  session. Reconciler sees the wrong session_id; frames come from
  right session. Rule #1 and #5 contradict.
- Post-close-grace event: `current_session_id` is already NULL
  (rule 1 → null), but `get_frames_for_event` matches the just-closed
  session (rule 6 → matches). Rule #5 back-stamps. **If a new session
  opens between close and the grace-window event, both the previous
  session's grace window AND the new session's open-window match the
  event timestamp.** Rule 6 prefers the currently-open session
  (`current_contains_event` precedence). Rule 3 (close hook) for the
  NEXT session will then scoop it up, but rule 3 for the PREVIOUS
  session already ran and skipped it. Edge cases around exactly when
  the fast path ran decide which session "wins."

### P4. Frame-to-event correlation is probabilistic

`pick_event_frames` (session_capture line 822) decides per-event before
/ after based on:

- A **brightness peak cutoff** (80% of session peak) — excludes
  transition frames at either end.
- **Prior event's settled state as "before"** — requires
  `_find_prior_event_pi_ts_in_session` to return a useful ESP clock
  value (see P1).
- A **settle delay** (200 ms) — subtracted from event_ts for after,
  added to open_ts for before.

None of these are tied to the physical reality of **what the scale was
reading at frame time**. Failure modes observed:

- **Early-event in long session**: if the session's 30-second ring
  filled before the event, the opening minutes of frames were lost.
  Fixed by live-archive (`_handle_frame` writes JPEGs to disk while
  open). Now the timeline is complete.
- **Overlapping physical actions inside one stability window**: user
  places item A at T, item B at T+400 ms. ESP emits one stability event
  at T+2.5 s with `delta_g = mass(A) + mass(B)`. The "after" frame
  shows both A and B placed; the classifier sees two new items but
  only one delta to explain.
- **Slow-settling items (cream cheese)**: stability fires 10–30 s
  after the door closes. `pick_event_frames` picks an "after" that is
  either after the door closed (dim) or cuts to session.after_path.
  Brightness cutoff saves the worst cases but not all of them.
- **Brightness-cutoff-empties-the-set**: if ambient light fluctuates,
  no frames pass the cutoff and `pick_event_frames` returns None,
  falling back to session-wide before/after, which undoes the whole
  point of per-event framing.

### P5. Confidence vs weight-fit is ad-hoc

`_apply_lot_update_from_classification` (line 414) gates on:

```
confidence >= 0.75 OR (weight-fit error <= 3%)
```

The 3% was picked to fix a specific multi_match REMOVE regression. It
is a hard threshold with a hard threshold, with no smooth interpolation
between them. A classifier that returns confidence=0.74 with a 3.01%
weight fit is treated identically to one that returns confidence=0.01
with a 50% fit.

Additional issues:

- The weight-fit check sums expected weights across the entire picked
  set (including `multi_match`). If any candidate in the set is
  missing `expected_weight_g`, the check is skipped
  (`summed_expected = 0.0`). A single rank-4 fallback product with
  null weight silently disables the override.
- `candidate_pool_used` is serialized into classification JSON. The
  weight-fit path reads it back to look up `expected_weight_g`. If
  the serialization ever loses the field (e.g. truncated), the check
  also silently disables.
- **The candidate pool itself is built via a separate
  `weight_proximity_score`** (`candidate_pool.py:57`), so by the time
  the classifier sees the pool, pool membership already implies weight
  plausibility. We then re-check weight-fit at apply time using
  expected_weight stored per candidate. **We are checking weight twice
  with two different formulas.**

### P6. Multi-item handling is asymmetric

The prompt hints at `multi_match` for REMOVE direction only
(`classifier/prompt.py`). For ADD events, multi-item placement inside
one stability window produces exactly one event whose `delta_g` is the
sum. The classifier is asked "which single candidate fits this delta?"
and will invent an expected-weight match or bail to UNKNOWN.

Examples that break:

- User drops a yogurt (150 g) and a jar (500 g) in the same reach.
  Delta = 650 g. No single candidate has expected = 650 g. Classifier
  picks the closest (maybe the jar) with confidence ~0.3 → review. Lot
  for yogurt is never minted.
- User returns three previously-out lots at once (a common
  fridge-reload gesture). Delta = combined mass. `recently_out` tier
  contains three candidates. Classifier picks one.

There is **no code path** that asks the classifier to return a multi-
item ADD decomposition even though the prompt schema could support it.

The REMOVE-side asymmetry also shows up in
`_maybe_synthesize_remove_gap` (line 938): a virtual REMOVE event is
minted when accounted ≠ scale_delta for negative gaps. The equivalent
ADD-gap (user adds multiple things faster than ESP can declare
stability between them) **does not synthesize anything** — those
grams just become part of one combined event whose multi-item
identity is guessed from.

### P7. Review queue doesn't couple to state

`review_queue` stores `proposed` as a JSON blob and waits for a human.
Until the fix added to `apply_user_reviewed_candidate` this session,
resolving a review had no effect on `lots`. The review was a record,
not a transaction.

Even now:

- Resolution validates the user pick against the original candidate
  pool but **doesn't know about subsequent lot mutations**. If the
  user takes 30 minutes to review while another session modifies the
  same lot, the resolution applies to stale state.
- The proposed JSON is opaque to the DB — no CHECK constraints, no
  structure. A wrong-shape review record sits in the queue rendering
  `None` for confidence (handoff §9).
- Dismissal (no-op) and resolution (apply) use separate code paths
  with no shared transaction envelope.

### P8. Product data lacks invariants

The schema has exactly three CHECK constraints across eight tables:
`lots.status IN (...)`, `products.unit_type IN (...)`,
`review_queue.kind IN (...)`. Everything else is enforced in app code
or not at all. Real inconsistencies that have existed in production:

- `lots.current_weight_g < 0` after a REMOVE event backfilled a
  negative value (fixed but only by code changes — DB accepts it).
- `lots.status = 'on_shelf'` with `current_weight_g = NULL` — a
  half-minted row from a failed `create_lot` transaction.
- `products.gross_weight_g < products.net_weight_g` (physically
  impossible — tare > 0).
- `lots` whose `product_id` references a wiped product (no
  `ON DELETE CASCADE`; deletion paths are ad-hoc).
- `session_resolutions.lot_id` NULLable with no coupling to deletion —
  fine in principle, but no integrity check that
  `add_event_id`/`remove_event_id` resolutions reference events from
  the same `session_id`.

### P9. Observability is grep-driven

Every bug this session was diagnosed by:
1. Grepping `server.log` for the event's id prefix (`--logs 50`).
2. Running `/api/diag/dump-session` and pulling frames+events locally.
3. Opening `shelf.sqlite3` in a SQLite client.

There is no:
- Per-event lifecycle transition log. The only evidence of an event's
  path through the system is its final row state plus whatever made
  it into `server.log`.
- Integrity check endpoint ("are my invariants holding right now?").
- Real-time view of the attribution decision for an event (which of
  the 8 rules fired? which won?).
- Structured reason codes. Errors are free-text JSON.

---

## Proposed redesigns

### R1. One timebase: "Pi monotonic ms since epoch-of-boot" on the wire

**Mechanism**: Replace every `ts` field with a Pi-clock ISO-8601 UTC
string **stamped at the nearest Pi-controlled boundary** to the event.
For ESP events, that is `pi_received_ts` at the Flask handler entry;
the ESP's `ts` becomes `esp_reported_ts` and is kept only for
diagnostic and clock-skew logging. Never compare ESP clocks against
Pi clocks.

- Add a `pi_received_ts` column to `scale_events`.
- `sessions.started_at` / `ended_at` remain Pi clock.
- SQLite `datetime('now')` is normalized at write-time: either use
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` everywhere or replace the
  default with a Python-generated ISO string from `now_iso_utc_ms()`.

**Trade-offs**: adds one column. Migration of existing rows possible
(computed from `created_at` for historical). ESP clock skew becomes
invisible to business logic — small loss of debug signal, fine for
the demo.

**Migration cost**: medium. One ALTER TABLE; update ingress +
classify + sweeper + synth gap to use the new column. Delete the
clock-domain comments. Maybe 4-6 hours.

**Confidence**: high — removes an entire bug class.

### R2. One Session object, three-actor state machine

**Mechanism**: Introduce a `Session` class that owns:
- The DB row (`session_id`, `started_at`, `ended_at`, ...).
- The in-memory `_CURRENT`/`_CLOSED` entry.
- The frames timeline (live-archive list).
- The membership set of scale events.

State machine:

```
 OPENING -> OPEN -> CLOSING -> CLASSIFYING -> RECONCILING -> CLOSED
                                      \
                                       -> CLOSED (if no events)
```

All state transitions happen under one lock (the Session's own lock).
`app_state.current_session_id` becomes derived state
(`SELECT session_id WHERE ended_at IS NULL LIMIT 1`) rather than a
separate pointer. `_find_session_id_by_open_ts` disappears — sessions
are keyed only by UUID.

The three brightness subscribers collapse into one method
`Session.close()` that runs the three phases sequentially with
explicit handoff.

**Trade-offs**: touching more surface area than any individual bug fix.
Tests that construct fake sessions via the primitives directly need to
migrate.

**Migration cost**: high. Estimate 2-3 days of careful refactor + test
updates. But the resulting mental model collapses ~40% of the bug
stories.

**Confidence**: high. Most past bugs were divergences between the three
stores. A single store can't diverge from itself.

### R3. Attribution as a pure function

**Mechanism**: One function `attribute(event) -> Session | Unmatched`
with a clear rule set:

1. If an open session contains `event.pi_ts`, attribution = that
   session. (Even if the ingress happened during a post-close grace
   of a previous session — physical reality is that the door is open
   now, so the event is current.)
2. Else if a just-closed session's grace window contains
   `event.pi_ts` AND no open session exists AND no newer-opened
   session has a start time < `event.pi_ts`, attribution = that
   session.
3. Else unmatched.

One function, used by ingress, sweeper, close-hook. Membership is
persisted on the event row at the **moment attribution happens** and
never re-decided. `_find_prior_event_pi_ts_in_session` queries by
`session_id` (already correct) but uses `pi_received_ts` for ordering.

**Trade-offs**: moves the close-hook's "all events in window" scan to
the membership model — events register themselves with their session
at attribution time, close-hook reads session.event_ids. Slight
duplication for the gap-fill synthesizer, which wants to scan
post-facto.

**Migration cost**: medium. Needs R2's Session object to be clean.
Maybe 1 day on top of R2.

**Confidence**: high. Attribution becoming idempotent is the biggest
win.

### R4. Frame picking on a physical anchor

**Mechanism**: Rather than settle-delay + brightness cutoff, pick
frames based on the **scale weight trace**:

- During a session, correlate every heartbeat `(pi_ts, weight_g)`
  with the frame timeline.
- For each scale event with `pi_received_ts = T` and
  `before_weight_g = W_before`, `after_weight_g = W_after`:
  - `before_frame` = the latest lit frame whose paired weight is
    within epsilon of `W_before`.
  - `after_frame` = the earliest lit frame **at or after T + 500 ms**
    whose paired weight is within epsilon of `W_after`.
- If no frame matches (lit but correct-weight interval never
  intersects), fall back to settle-delay heuristic, logged as
  `frame_pick_fallback=weight_trace_miss`.

**Deferred frame pick**: don't pick at ingress or close-hook. Pick
only when the classifier is about to be called, after all events for
the session are known. Then pick each event's frames with knowledge
of neighbor events' pi_ts/weights.

**Trade-offs**: requires persisting the heartbeat weight trace per
session (already done ephemerally in `_WEIGHT_TRACE`; needs a table
or session-owned list). Adds one DB column (weight per frame) or an
in-memory join.

**Migration cost**: medium-high. `pick_event_frames` becomes a
different function. Test it first against the existing `data/diag`
dumps — if the new picker agrees with the old one on good cases and
fixes the bad ones, ship it.

**Confidence**: medium-high. This is the first anchor that's tied to
physics, not empirical tuning.

### R5. Unified scoring + threshold for auto-apply

**Mechanism**: Replace the `confidence >= 0.75 OR weight_fit <= 3%`
gate with a single scalar:

```
score = visual_confidence *
        weight_fit_score *      # exp(-(fit_err)^2 * k)
        pool_tier_bonus         # 1.0 for recently_out + weight-match,
                                # 0.9 for top_up_target, 0.8 for
                                # catalog_not_on_shelf + weight-match,
                                # 0.5 for fallback, 0.1 for sentinel
```

Auto-apply when `score >= S_apply`. Review when
`S_review <= score < S_apply`. Reject (UNKNOWN) when `score < S_review`.
Two tunable numbers instead of two independent gates. The multi_match
case sums weight-fit and picks the combined candidate set with the
highest joint score — the arithmetic itself naturally encodes
"multiple items summing to delta is more plausible than one item
with wrong weight."

**Trade-offs**: loses the clean semantics of "confidence" as
LLM-returned. The new score needs empirical re-calibration from the
current data set. Might rate-limit UNKNOWN → review transitions more
often initially.

**Migration cost**: low — it's a single apply-site change. 2-3 hours.

**Confidence**: medium. The math is correct but the thresholds need
tuning.

### R6. Symmetric multi-item for ADD

**Mechanism**: The classifier prompt (and returned JSON schema)
already has `multi_match` for REMOVE. Extend it to ADD with the same
semantics: the classifier returns 1+ candidate ids whose expected
weights sum to delta. Update the apply path (already iterates
`matched_ids` for REMOVE — trivially extendable to ADD).

Add an ADD-gap synthesizer symmetrical to the REMOVE-gap one: if
`sum(event.delta_g) < scale_delta - 20 g` (more weight than events
explain) at close, log it (don't synthesize a virtual event — ADD-gap
is ambiguous; prompt user instead).

**Trade-offs**: prompt gets longer. Classifier cost slightly up.

**Migration cost**: low. Half day to update prompt + apply path +
tests.

**Confidence**: medium — fixes a real case but depends on the
classifier's reasoning quality with the new prompt.

### R7. Review queue as explicit transaction log

**Mechanism**: Each `review_queue` row carries an `action_to_apply`
column containing a serialized, executable action:

```json
{
  "kind": "lot_apply",
  "direction": "add",
  "candidate_id": "...",
  "delta_g": 123.4,
  "event_ts": "...",
  "pool_snapshot": [...],
  "apply_if_still_valid": { "event_id": "...", "event_status": "review" }
}
```

`resolve(review_id)` = execute the action inside one transaction,
validating `apply_if_still_valid` preconditions. `dismiss(review_id)`
= mark resolved without executing.

Decouples "what the system proposed" from "what was applied." The
review queue becomes an append-only log of decisions, each with its
causal event.

**Trade-offs**: bigger proposed payload. UI needs to render
structured actions rather than free-text JSON.

**Migration cost**: medium. One schema column + helper. Half to one
day.

**Confidence**: high. Makes auditable what is currently opaque.

### R8. Schema-level invariants

**Mechanism**: Add CHECK constraints and a small set of triggers.

```sql
-- on products:
CHECK (net_weight_g IS NULL OR net_weight_g > 0),
CHECK (gross_weight_g IS NULL OR gross_weight_g > 0),
CHECK (gross_weight_g IS NULL OR net_weight_g IS NULL
       OR gross_weight_g >= net_weight_g)

-- on lots:
CHECK (current_weight_g IS NULL OR current_weight_g >= 0),
CHECK (status != 'on_shelf' OR current_weight_g > 0),
CHECK (status != 'out' OR last_out_at IS NOT NULL),

-- foreign key enforcement:
PRAGMA foreign_keys = ON; -- at connection open

-- trigger: on lots delete, null out session_resolutions.lot_id
--          (already done in adapter, make it DB-enforced)
```

Add a single `/api/admin/check-invariants` endpoint that runs a fixed
set of integrity queries and returns the offenders.

**Trade-offs**: requires `PRAGMA foreign_keys = ON`, which must be
set per connection on SQLite. Some deletion sequences may need
reordering. Migrations of existing bad rows must happen first.

**Migration cost**: low. One migration + audit of existing rows.
2-3 hours.

**Confidence**: high.

### R9. Event lifecycle log + structured reason codes

**Mechanism**: One new table:

```sql
CREATE TABLE event_lifecycle (
  event_id       TEXT NOT NULL REFERENCES scale_events(event_id),
  ts             TEXT NOT NULL DEFAULT (datetime('now')),
  from_state     TEXT,
  to_state       TEXT NOT NULL,
  actor          TEXT NOT NULL,   -- 'ingress', 'close-hook', 'sweeper',
                                  -- 'classifier', 'user-review'
  reason_code    TEXT,            -- 'matched_open_session',
                                  -- 'attribution_failed', ...
  payload        TEXT             -- JSON for context (pool, scores)
);
```

Every state transition writes a row. `/api/event/<id>/trace` renders
it. Correlates ingress → attribution → frame-pick → classify →
apply/review chain inline.

Structured reason codes turn "grep server.log" debugging into
"open the event detail page."

**Trade-offs**: write amplification (~5-8 rows per event). At this
system's volume (hundreds of events/day at peak) this is trivial.

**Migration cost**: medium. One table + a helper call at every
transition site. 1 day.

**Confidence**: very high. Pays back the first time you use it.

---

## Prioritized roadmap

Ordered by value-per-hour, assuming Jeremy's time and the current
bug pressure:

| # | Change | Effort | Risk | Impact |
|---|---|---|---|---|
| 1 | R9 — Event lifecycle log + reason codes | 8 h | Low (additive) | Very high — turns every future bug into a 5-minute diagnosis instead of 5-hour |
| 2 | R1 — Pi-clock-only wire format + `pi_received_ts` column | 6 h | Low | High — removes clock-domain bugs permanently |
| 3 | R8 — Schema CHECK constraints + FK on | 3 h | Low-medium (existing row audit) | High — DB rejects impossible states |
| 4 | R5 — Unified score for auto-apply | 3 h | Medium (threshold tuning) | Medium-high — replaces two ad-hoc gates with one principled one |
| 5 | R3 — Attribution as pure function | 8 h | Medium | High — removes 5+ disagreeing rules |
| 6 | R7 — Review queue as action log | 6 h | Low | Medium-high — makes resolution auditable |
| 7 | R2 — One Session object | 16-24 h | High (broad surface) | Very high structurally but only worth it after 1-5 land |
| 8 | R4 — Weight-anchored frame pick | 10-12 h | Medium (needs data-set validation) | High for multi-item-same-window cases |
| 9 | R6 — Symmetric multi-item ADD | 4 h | Low-medium (prompt changes) | Medium |

**Suggested sequencing**: Land 1 first (observability is the force
multiplier). Then 2, 3, 4 in parallel (independent, all small). Then
5 with the lifecycle log now showing whether attribution agrees with
frames. Then 7 opens the door for 2 (identity model) which enables
clean 8. Revisit 9 once the classifier cost/accuracy trade-off is
measurable from 1's lifecycle data.

Total roadmap: ~8-10 working days for the whole list. First four items
(highest value, low risk) are ~20 hours and remove the conditions for
most of this session's bug class.

---

## Non-goals

What this audit **does not** recommend:

- **Replacing SQLite with Postgres**. At single-user demo load, the
  concurrency model works; the fix is enforcing the shared lock
  discipline, not migrating. The `check_same_thread=False` + single
  `db_lock` is fine for this volume.
- **Introducing Kafka / Redis / a message queue**. Three threads + one
  DB + in-memory ring buffer is the right scale. A queue adds an
  unnecessary distributed-systems chapter.
- **Rewriting in Rust / Go / etc.** Python's concurrency primitives
  are adequate; the problems are in the design, not the runtime.
- **Full CV reimplementation (motion detection, optical flow)** for
  frame picking. R4 uses the scale weight trace the system already
  captures — no new hardware, no new ML, no new latency. Only swap
  in motion-based picking if R4 doesn't recover enough cases.
- **Removing the review queue** in favor of fully autonomous classify.
  The human-in-the-loop is the right call for a CV demo where
  "review the ambiguous ones" is much cheaper than "refund a wrong
  autonomous decision."
- **Persistent dedup (`UNIQUE(device_id, event_seq)`)**. Handoff §9
  already notes this as a known limitation. Worth doing eventually
  but not in the critical path — R1 + R3 make the on-restart dupe
  visible in lifecycle logs even if it still slips through.
- **Multi-shelf support**. Schema allows it, code assumes single
  shelf. Leave out of scope until someone asks.
- **Auth / LAN-only hardening**. Out of scope of this audit per
  handoff §9.

---

## Appendix: the bug-story table

For posterity — a mapping of this session's fix stories to the
underlying structural problem they reveal:

| Bug story | Root (P#) |
|---|---|
| Framing wrong after stability | P4 |
| Session attribution wrong across close-grace | P3 |
| Grace-window poaching by next session | P2, P3 |
| Confidence threshold blocking obvious weight matches | P5 |
| Candidate pool empty after wipe | P8 |
| Review resolution stub → no lot mutation | P7 |
| Multi-item same-window undistinguishable | P4, P6 |
| Post-close-grace events double-counted | P3, P8 |
| ESP stability race (slow-settling items) | P1, P4 |
| Zombie `current_session_id` across restart | P2 |
| Wipe FK violation | P2, P8 |
| Sweeper age-failing in-progress sessions | P3, P9 |
| Reconciler ran before classifier | P2 (execution-order implicit) |
| Dedup LRU + event_seq reset on ESP reboot | P1 (clock/uptime) |
| Frame-path `before = after` on short session | P4 |

Almost every story ladders back to one of: **fragmented identity,
inconsistent attribution, unanchored frame pick, or clock-domain
confusion.** These are exactly the redesigns proposed.
