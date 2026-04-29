# UX Audit Round 2 — Pi Live-Shelf Operator UI

## What changed since round 1

In the **repo**, commit `00499b3` reshaped templates as planned (system-health tile, scale chips, per_page picker, server-side dedup, sessions filters/aggregate strip, admin drawer, `remaining` column, etc.). On the **production Pi at 192.168.0.181**, **none of those changes are live** — the deployed UI is byte-for-byte the pre-fix version. The single largest finding of this round is therefore a deploy/verification gap that lets us mark "fixed" while the operator still sees the broken page. Round 1 also missed two issues independent of deploy (a half-truth dedup cleanup path, catch-all device-id mis-attribution); both surface below.

---

## New / surfaced findings

### Finding 1 — All round-1 fixes are absent from the live Pi

**Class:** new (round-1 verification gap)
**Surface:** all (`/`, `/inventory`, `/sessions`)
**Observation:** Curl shows the **pre-fix** UI on every surface:

- Live preview header is plain `live preview &mdash; live shelf` — no scale-01 chip, no `border-left` accent. Repo `dashboard.html:7-13` has both.
- No `<div id="health-tile">` panel. Right column still ends with the duplicated **state snapshot**.
- Global nav still has the loud pink **wipe** button; no `admin ▾` drawer.
- `/inventory` shows `usage log (81)` paged at **5/page over 17 pages**; `?per_page=25` and `?per_page=100` produce **byte-identical** HTML to no-param (md5 match) — the picker has no backend.
- On-shelf table is the old 9-column shape; no `remaining` column, no `X.YY ctn` lead.
- Usage log renders 5 rows at the same `2026-04-29T03:32:41.448Z` / same `return_event_id` with distinct `usage_id` hashes — `_dedupe_usage_rows` was never called.
- `&amp;mdash;` literal-text bug at `pi_inventory.html:643, 701, 1186, 1231-32` still rendering.
- `/sessions` still shows `129.0s`, `60.0s`, `300.0s`. No filter buttons, aggregate strip, or per-row debug links.
- `~/.claude/skills/live-shelf-deploy/` exists; never invoked after `00499b3`.

**User impact:** The operator opens the Pi expecting yesterday's fixes and sees the page that motivated the audit. We marked the audit closed and wrote `UX_AUDIT_PI_LIVESHELF_FLAGS.md` claiming items are "Already-fixed" — none of them are fixed _for the operator_. The audit-record loses trust.

**Suggested fix:** Run `live-shelf-deploy/deploy.sh --restart` on the touched server files, then smoke-curl and grep for `health-tile`, `scale-01`, `remaining`, `5m 0s`. Add deploy verification to the live-shelf workflow so future "fixes" come with `deploy.sh --status` evidence.

---

### Finding 2 — Dedup pill renders `Nx` but per-row × deletes only one

**Class:** round-1-fix-incomplete
**Surface:** /inventory (usage log)
**Observation:** Post-deploy, `_dedupe_usage_rows` will collapse the 5 chicken duplicates with a `5x` pill. But the survivor's × calls `/api/usage/<usage_id>/delete` — only that row dies. The pill's tooltip even admits "deleting this one will leave them behind" (`inventory.html:556`).

**User impact:** Operator clicks ×, gets "deleted" toast, 4 dup rows persist, `total_consumed_g` is off by 4×83.7g, reload shows the row again with `4x`. Symptom silenced, disease intact.

**Suggested fix:** New `/api/usage/dedupe-group/delete` taking the `(occurred_at, return_event_id, product_id)` triple, deleting all matches in one transaction with a "deleted 5 duplicate entries" toast.

---

### Finding 3 — Both `/api/state` and `/api/state?shelf=catch_all` return `scale-02`

**Class:** new
**Surface:** /api/state, dashboard preview tiles
**Observation:** Both endpoints report `scale_device_id: "scale-02"`. Round-1 chips hard-code `scale-01` for live-shelf and `scale-02` for catch-all (`dashboard.html:12, 52`). Post-deploy, the live-shelf chip says scale-01 (matching nothing).

**User impact:** Chips are supposed to ground "this tile = this hardware". Hard-coded values that diverge from JSON make the chip folklore. When real hardware arrives with different ids, the chip still says what the template says.

**Suggested fix:** Drive the chip from `state.scale_device_id` (server-rendered + JS-updated). If both shelves really share `scale-02`, surface that as a "scale id collision" warning rather than papering over it.

---

### Finding 4 — `events total: 141 / pending review: 84` are frozen demo numbers in a polling UI

**Class:** new (production-state behavior)
**Surface:** / (dashboard right column)
**Observation:** `/api/debug/health` over 7 minutes shows `pending_reviews: 84` / `failed_events: 47` flat. `last_scale_event_ts` hasn't advanced in 9 h. Dashboard polls every 300 ms but values never change. Round 1's always-on in-flight count + the new health tile add more static rows to the same column.

**User impact:** Operators ignore the right column. When 47 → 48 failed events happens, nobody notices.

**Suggested fix:** Add a "Δ since 1h" or "↑ +1" pill on counter moves; a 5-minute decay highlight on recently-changed values makes a polled UI feel alive when it is.

---

### Finding 5 — `cloud_drift_s` health row will pin to OK and never warn

**Class:** new (round-1 introduced)
**Surface:** / (dashboard system-health tile, post-deploy)
**Observation:** Template warns when `|cloud_drift_s| ≥ 2` (`dashboard.html:205`). Live API returns -0.29 s; the 7-minute window stays -0.5 to -0.3 s. NTP keeps it well under 2 s, so the row is permanently green. After a Pi reboot before chrony stabilizes, 1.9 s drift would still pass.

**Suggested fix:** Threshold to 1.0 s; surface the literal value beside the pill (`±0.29s · last 5min max`); amber when `|drift|` increased >50% over prior poll.

---

### Finding 6 — Two adjacent "in flight" badges, only one polls

**Class:** round-1-introduced-regression
**Surface:** / (dashboard)
**Observation:** Round 1's always-on `in flight: 0` on the shelf tile is server-rendered from `{{ in_flight|length }}` — **not** polled. The catch-all tile next to it polls every 500 ms. Two identical labels, one updates, one doesn't.

**User impact:** A real live-shelf in-flight event won't surface in its counter until full reload; user may learn to read the catch-all's live counter for a live-shelf value.

**Suggested fix:** Poll the live-shelf in-flight from `/api/state` (add the field), or drop the catch-all's badge so there's only one.

---

### Finding 7 — `/api/usage` mixes time formats within one row

**Class:** new
**Surface:** /api/usage, inventory usage log
**Observation:** Same JSON object returns `created_at: "2026-04-29 04:19:07"` (no Z) and `occurred_at: "2026-04-29T03:32:41.448Z"` (ISO+Z). Round 1 caught cross-page format inconsistency but missed intra-row because it walked HTML, not JSON.

**Suggested fix:** Normalize both to ISO 8601 + zone in the API; render local via `Intl.DateTimeFormat` in the template. Document the SQLite UTC-text convention once in `web_repo.py`.

---

## Things round 1 didn't catch but should have

1. **No post-fix verification.** Round 1 was pure-template; nobody curled the Pi after fixes landed. A `verify-after-fix` step (curl the live surfaces, grep for the markers the fixes were supposed to introduce) catches Finding 1 in 30 seconds.
2. **Dedup UX vs. dedup DB.** Round 1 treated duplicates as a display problem; the DB still has them and the per-row delete only removes one. Future audits should ask "if I take the suggested action on bad data, does the bad data go away?" before calling something fixed.
3. **API-layer truth check.** Findings 3 and 7 only surface from JSON, not HTML. Round 1's prompt anchored on rendered HTML and missed backend-truth issues that propagate into the UI without being UI bugs.
4. **Static demo data.** Round 1 read `141 / 84` as if they were live. The "alive or dead?" lens never got applied — root of Finding 4.

---

## Items now BETTER than round 1 noted

Calls round 1 made that _will_ land cleanly post-deploy — sound design stuck in the repo:

- **`remaining` column with X.YY ctn lead** (`inventory.html:204-223`) — bridges the cloud-1.6-ctn / Pi-160.4-g gap. Most operator-friendly change in the batch.
- **`tare needed (below zero)` indicator** (`inventory.html:421-425`) — clean -5 g threshold; copy tells the operator what to do. Right tone.
- **System-health tile structure** (`dashboard.html:156-232`) — concise table, pills, hover tooltips. Threshold needs Finding 5, structure is right.
- **Sessions debug-timeline link per row** — closes the worst discoverability gap round 1 raised.
- **Quick-window presets (today / 24h / 7d)** on the usage log — exactly the "default to the most-common slice" pattern.

Deploy these and the user-perceived UI gets meaningfully better on every surface round 1 touched.
