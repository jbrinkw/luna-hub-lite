# UX Audit Follow-ups — Deferred / Flagged for User

Source: `/home/jeremy/luna-hub-lite/UX_AUDIT_PI_LIVESHELF.md`
Implementation pass date: 2026-04-28

## Flag 1: Auto-refresh of server-rendered tables (events grid, on-shelf, sessions)

- **Source:** Cross-cutting findings — "Static / server-rendered content is stale", and §1.3 of "Top 5 highest-impact UX changes".
- **Why deferred:** This is a meaningful architecture change. Each of the three lists (`recent events grid` on /, on-shelf tables on /inventory, sessions on /sessions) currently renders once at page-load. Wiring them to auto-refresh requires either: (a) a JSON endpoint per surface + JS polling that re-renders the table fragment, or (b) Server-Sent Events with a per-table key-change emitter. Either is a multi-day implementation that carries new failure modes (polling backoff parity with the existing live-preview poller, partial refresh semantics during a wipe, etc).
- **Question for user:** Polling vs SSE? Do you want the same 300/1000/3000 backoff ladder the dashboard already uses, applied per-table? Should reload happen only on visible data change (etag-style) or every N seconds unconditionally?

## Flag 2: Stable indicator hysteresis

- **Source:** Per-page → / (dashboard) → Friction list, "the stable indicator flickers between STABLE and settling because the underlying weight oscillates around the door-closed mean…".
- **Why deferred:** This is a tuning question, not a bug. The current display reflects the truth of `scale_runtime_state.stable`, which itself comes from the scale ingest pipeline. Adding UI-side hysteresis (e.g., only flip to "settling" if instability has held for >2 polls) would mask a real signal — the scale IS oscillating, the user just doesn't want to see micro-oscillations.
- **Question for user:** Where should hysteresis live? In the scale-event handler (suppress noise → broadcast stable for longer)? In the UI poller (debounce display flips)? What's the dwell threshold (e.g., "show STABLE if stable for 3 of last 5 polls")?

## Flag 3: Anthropic + camera daemon health rows

- **Source:** Per-page → / (dashboard) → Missing list, "A camera-daemon / cloud-outbox / Anthropic health row".
- **Why deferred:** I added `failed_events`, `pending_events`, `classifying_events`, `cloud_drift_s`, and `outbox_backlog` to the new system-health tile. `anthropic_calls_total` / `anthropic_errors_total` come from the runtime classifier subsystem (not the SQLite DB the web_repo can read), and `camera daemon up?` requires a separate liveness probe. Surfacing these without breaking the "web_repo reads from sqlite only" boundary needs explicit wiring.
- **Question for user:** Can the dashboard hit `/api/debug/health` via JS instead, and merge those numbers into the tile client-side? Or should we plumb a host-supplied collector callable into `make_html_bp` similar to `classifier_pool_provider`?

## Flag 4: Reviews queue badge — context label

- **Source:** Cross-cutting findings, "The 84 pending reviews badge is alarming in nav but never explained".
- **Why deferred:** The audit suggests adding context like "84 reviews from today" or "84 across N days". Doing this well needs a query the badge currently doesn't have — a `MIN(created_at)` over the pending bucket — plus a hover tooltip / sub-badge. That's a small but non-zero UI addition.
- **Question for user:** What context does the badge need? A min-age (e.g., "oldest from 3 days ago"), a stale-count breakdown, or a one-line tooltip? Is the operator's mental model "process newest first" or "process oldest first"?

## Flag 5: Debug timeline pages — dark-theme + nav continuity — CLOSED 2026-04-29

- **Source:** Per-page → Debug timelines → Friction list, "The styling jump (dark-mode app → light-mode page) is jarring".
- **Resolution:** `_render_timeline_html` now uses dark-theme CSS variables matching `_base.html` (background, text, accent, panel, border). The route is still self-contained (no Jinja inheritance) so it keeps working without a `templates_dir`. The dark-text-on-pastel-swatch pattern stays — those reason-code colors come from `_REASON_COLORS` and need a near-black foreground for legibility.

## Flag 6: Recent events grid — last-hour summary line

- **Source:** Per-page → /inventory → Missing list, "A 'what changed in the last hour' feed".
- **Why deferred:** This needs a small aggregation query (`COUNT(*) GROUP BY direction WHERE ts > now()-1h`) and a tile to display it. The shape is simple but it competes with the existing `usage by product (last 7 days)` tile for layout real-estate.
- **Question for user:** Do you want a 1-line summary ("since 11:00: 1 add, 0 remove") or a 5-row mini-feed of the last hour's events? Does this replace or augment the 7-day tile?

## Flag 7: Manual lot drop / discard quick action

- **Source:** Per-page → /inventory → Missing list, "A way to manually drop / discard a lot to zero".
- **Why deferred:** The per-row × button + confirm already does this; the audit asks for a faster path. The right shape is unclear — keyboard shortcut? Bulk-select with checkboxes? A "drop all in flight" admin button?
- **Question for user:** What's the operator's actual workflow when they need to drop a lot? Is the bottleneck the confirm dialog (which we already keep for safety) or the fact that every lot drop is per-row and N drops = N confirms?

## Flag 8: Reconciler row reason-code dictionary — CLOSED 2026-04-29

- **Source:** Per-page → Debug timelines → Friction list, "Reason-code color legend isn't documented on-page".
- **Resolution:** Bundled with Flag 5. `_render_timeline_html` now renders a `<details class="legend">` block above the rows table that lists every entry in `_REASON_COLORS` (sorted alphabetically) with a swatch + monospace reason-code label. Collapsed by default to avoid stealing attention from the timeline rows.

## Flag 9: Mobile-friendly nav / table layout

- **Source:** Cross-cutting findings, "Mobile" section.
- **Why deferred:** Audit explicitly calls this low-priority. The kitchen Pi screen is desktop-sized.
- **Question for user:** Do you want a mobile pass (hamburger nav, responsive tables) at all, or accept that the Pi UI is desktop-only?

---

## Already-fixed items the audit raised

- **`&mdash;` literal text rendering bug at `inventory.html:189`** — fixed by replacing the string-literal `&mdash;` inside `{{ ... or '&mdash;' }}` Jinja expressions with a real `—` character so autoescape doesn't turn it into `&amp;mdash;`. Confirmed in `test_inventory_brand_null_uses_real_em_dash`.
- **Negative weight reading on scale-03 (`-121 g`)** — surfaced a "tare needed" indicator below the value when `current_weight_g < -5`. Test: `test_inventory_negative_single_track_weight_renders_tare_needed`.
- **Pagination at 5/page with 81 rows** — bumped default to 25/page, added `?per_page={5,25,50,100}` picker + jump-to-page form + bounded whitelist on per_page. Tests: `test_inventory_renders_per_page_picker`, `test_inventory_per_page_query_param_clamps_to_whitelist`, `test_inventory_per_page_query_param_50_takes_effect`.
- **Containers as a first-class unit on the on-shelf table** — added a "remaining" column that leads with `X.YY ctn`, secondary line `X.Y srv / N`, and moves grams to the next column with `<g content> / <g net>` underneath. Test: `test_inventory_renders_containers_column_for_on_shelf_lots`.
- **11 duplicate rows for same `return_event_id` in usage log** — `routes._dedupe_usage_rows` collapses identical `(occurred_at, return_event_id, product_id)` rows into one survivor row + a `Nx` warn-pill badge. Tests: `test_inventory_dedupes_usage_rows_with_same_return_event_id`, plus three direct unit tests on the helper.
- **System health (`failed_events`, `cloud_drift_s`, `outbox_backlog`) hidden** — added a system-health panel to the dashboard right column with green/info/warn pills. Test: `test_dashboard_renders_health_tile`.
- **In-flight count silently disappears at 0** — moved the count into the always-rendered "shelf" tile so it shows `0` instead of vanishing. Test: `test_dashboard_renders_in_flight_count_always`.
- **Two preview tiles indistinguishable** — added scale-01 / scale-02 device-id chips and per-tile colored left-borders. Tests: `test_dashboard_preview_tiles_have_device_id_chips`, `test_dashboard_catch_all_preview_has_device_id_chip`.
- **"Wipe" button on every page** — relocated behind a discreet `admin ▾` dropdown that also exposes `/api/debug/health` and `/api/debug/invariants` links. Two-step confirm + WIPE-typing remains. Test: `test_base_nav_wipe_button_tucked_under_admin_menu`.
- **Three different time formats (sessions table)** — sessions table now reads `Xm Ys` for ≥60s durations instead of `300.0s`. Test: `test_sessions_page_long_duration_renders_minutes`.
- **Sessions page lacks filter/total bar/timeline link** — added an aggregate strip (sessions / with events / total events / unreconciled), client-side filter buttons (`with events` / `all` / `unreconciled`, default = with events), highlight for unreconciled rows, and per-row debug-timeline links. Tests: `test_sessions_page_renders_filter_buttons`, `test_sessions_page_renders_aggregate_strip`, `test_sessions_page_renders_timeline_link_per_row`.
- **Quick-window presets (today / 24h / 7d) on usage filter** — added client-side preset buttons that resolve to `?since=YYYY-MM-DD` against the existing server-side filter. (No new test — the buttons are pure client JS that maps to existing backend behavior already covered by `test_inventory_page_filters_usage_by_*`.)
