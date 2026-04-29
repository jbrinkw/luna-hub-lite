# UX Audit — Pi Live-Shelf Operator UI

## Overall impression

This UI is honest in the way a hand-built operator console is honest — it tells you the truth, but in the dialect of the system, not your dialect. As Jeremy walking up to the kitchen Pi, I get a clear read on door state, the live shelf weight, and the catch-all weight in about 3 seconds, but anything past that — _what's actually on a shelf, what changed in the last hour, what to do about the 84 pending reviews_ — turns into an exegesis exercise. The biggest single problem is that "weight in grams" is the only language the UI speaks: containers, servings, percent-full, and consumed are all secondary, even though the cloud thinks in containers (the source of the user's "1.6 ctn vs 160.4 g" confusion). Information density is high but uncalibrated — a debug-grade `Classifier candidates` table sits a panel above the actual on-shelf list, and the "wipe all data" nuclear button shares the same nav row as the everyday links.

---

## Per-page

### / (dashboard)

**User goal:** Glance at the kitchen state in 5 seconds — door, live shelf, catch-all, single-track milk, recent activity.

**Today shows:**

- 4 stacked tiles in the left column: live preview (live shelf), live preview (catch-all, gated on `catch_all_enabled`), single-track scales list, shelf totals (events, pending reviews) — `dashboard.html:7–125`
- Right column: quick links, a single-knob "tuning" panel (`event_delta_threshold_g`), bench controls (open/close session, exposure, dump diag), state snapshot table — `dashboard.html:168–242`
- Recent events strip: 24 thumb cards (before/after JPEGs + signed delta + add/remove + HH:MM:SS) — `dashboard.html:245–274`
- Live polling: dashboard tile 300 ms, catch-all 500 ms, single-track 1000 ms, with 3/5-failure backoff ladder — `dashboard.html:287–514`. Nav-meta polls /api/state every 2 s — `_base.html:362`

**Friction:**

- The "live preview — live shelf" panel weight reading is `339.2 g` after the chicken add event, while the second tile (catch-all) shows `339.2 g` too — both tiles show _the same global state_ (`/api/state` and `/api/state?shelf=catch_all` both returned `last_scale_weight_g: 339.1733`). At a glance the tiles look like they're each reporting their own scale, but they're not visually distinguished beyond the title. That's a confusion bomb when you have two physical scales.
- The `state snapshot` panel duplicates the `live preview` panel's data (door, session, last weight, last event, updated) — these same five fields appear three times on the page (live preview tile, snapshot table, nav-meta strip). Information is correct but repetitive.
- "events total: 141 / pending review: 84" is bare numbers with no recency context. Are those 84 reviews from today? From a month of test data? An operator can't tell without clicking through.
- `dump diagnostic session` is a purple button right next to "open session" / "close session" with no warning copy — accidental clicks during demos are likely.
- The wipe button (`_base.html:298–301`) lives in the global nav, on every page, in a thin pink frame. The two-step confirm is good, but the visual weight is still too high for an action that nukes the whole DB.
- "in flight" panel — there's a Jinja block (`dashboard.html:127–165`) but it's gated on `if in_flight`, so when in-flight is empty (the current state) the panel disappears entirely. That means "0 in flight" is silent, but "1 in flight" makes the page jump. An always-on counter avoids the layout shift and gives an immediately-readable "everything's at rest" signal.
- The stable indicator flickers between `STABLE` and `settling` because the live shelf's underlying weight oscillates around the door-closed mean (`api/usage` snapshots show the scale ranging 295–339 g while at rest — see `api/debug/health`). At 300 ms cadence the dot toggles every couple of seconds, which reads as alarming rather than informative.
- No visible classifier-pending or anthropic-error counter despite `failed_events: 47` in `/api/debug/health`. That's a real signal hidden from the user.

**Missing:**

- A 24-hour timeline / sparkline of weight on each shelf — even a 60-pixel mini chart per tile would tell the user "we're idle" vs "I just took milk out 10 min ago" without clicking through.
- "Last classification" surface — no indicator of what the most recent ADD was classified as, or whether it succeeded.
- A camera-daemon / cloud-outbox / Anthropic health row. The `/api/debug/health` data is there (anthropic_calls_total, anthropic_errors_total, failed_events, classifying_events, pending_events) but nothing on the dashboard surfaces it.
- No mention of the Pi's own clock vs cloud (the API returns `cloud_drift_s: -0.546226` but it's never rendered).
- No way to drop a single in-flight lot back to the shelf, except indirectly via /inventory.

**Suggestions (ranked):**

1. Visually anchor the two preview tiles to their physical scale (e.g., bold left-border in different colors, or "scale-02" / "scale-03" device-id chips) so the user always knows which tile = which hardware.
2. Replace the duplicated `state snapshot` panel with a "system health" panel that surfaces what the user can't see anywhere else: cloud drift, outbox/failed_events, anthropic errors, classifier queue depth.
3. Add a thin always-rendered "in flight" badge in the left column that reads "0 lots in flight" when empty, instead of disappearing.

---

### /inventory

**User goal:** Confirm what's on each shelf, see what got consumed recently, take a remediating action (drop a lot, capture a tare, delete a bad usage row).

**Today shows:**

- Top summary tile: `live shelf: 2`, `catch-all: 0`, `catalog: 5`, `last 7 days: 11617.6 g across 3 items` — `inventory.html:7–60`
- Collapsible **Classifier candidates** panel (9 rows, default collapsed unless pool empty) — `inventory.html:68–150`
- "Live Shelf — on shelf (2)" table: 9 columns wide (product, brand/variant, on scale, content left, servings left, % full, consumed, last seen, delete) — `inventory.html:288–305`
- "Catch-all — on shelf (0)" empty state — `inventory.html:312–321`
- "Single-track scales (1)" table — `inventory.html:341–425`
- "usage log (81)" with kind/since/until filter form, 5/page pagination, per-row delete — `inventory.html:427–564`. `USAGE_PER_PAGE = 5` is hard-coded in `routes.py:205`, so there's no `?per_page=` lever from the UI.
- "usage by product (last 7 days)" rollup — `inventory.html:567–595`
- Tare-capture sticky banner (when armed) + "catalog (5)" table with `tare` button per row — `inventory.html:598–696`

**Friction:**

- **The unit-system gap.** `on scale: 160.4 g`, `content left: 69.9 g`, `of 425 g full`, `consumed: 83.7 g`, `% full: 16%` for chicken. _Containers / servings / "1.6 ctn"_ never appear, even though the catalog row stores `servings_per_container` and `container_type`. The cloud's "1.6 ctn" lives in `cloud_lots.qty_containers`, but the Pi UI never surfaces a containers reading. When the user is mentally translating between "the cloud said 1.6 ctn" and "the Pi says 160.4 g", the Pi gives them no rosetta stone. The "servings left: 0.8 of 5" column is the closest the UI gets, but it sits 4 columns to the right of `on scale` and uses a different unit (servings, not containers).
- The ampersand-mdash bug: `<span>&amp;mdash;</span>` (visible in raw HTML at `inventory.html:189` for the brand column when brand is null) renders as the literal string `&mdash;` because Jinja escapes the `&` rather than emitting an em-dash. Compare to other empty cells which render correctly. Cosmetic but confidence-eroding.
- **Classifier candidates table** is a debug surface presented as a "details" with an explanatory paragraph using literal `cloud_lots.qty_containers` and `shelf_id` code references, on the _operator's_ inventory page. If you don't already know what `pool_for_add` is, this is alien. It also lists `(UNKNOWN sentinel)` as the 9th candidate, which is internal vocabulary for an operator.
- The "Live Shelf" h2 / "Catch-all" h2 / "Single-track scales" h2 split is correct but the headings are all identically styled and the catch-all empty state is just `nothing currently on the catch-all scale.` — no hint that the user can open a catch-all session, weigh something, and have it auto-classify. The whole catch-all workflow is invisible if the section is empty.
- The single-track scale row shows `scale-03 / Whole Milk / -121 g` — _negative weight_ with no explanation. (-121 g means the scale is below tare, presumably nothing on it.) An operator sees a negative number and assumes something's broken. There's no "empty / awaiting placement" affordance.
- **Usage log at 5/page** — `total: 81, pages: 17`. Walking 17 pages with only prev/next links and no jump-to-page is painful. The 5/page change was right for the _most recent_ glance, but with 17 pages of paginated data, a "show 5 / 25 / 100" dropdown or jump-to-page would help when the user actually wants to scan.
- The usage-log table renders 11 _identical_ "Pulled Rotisserie Seasoned Chicken — 83.7 g return" rows for the same `occurred_at` and the same `return_event_id`, distinguished only by `usage_id`. Every Pi restart appears to have re-emitted the row. This is a backend bug, but the UX impact is real: the user sees 81 entries that look like 5 things repeated 16 times each. There's no dedup, no "show duplicate run" collapse, and the per-row delete is the only remediation — 11 separate confirms to clear one bad insert run.
- The kind-filter dropdown labels are inconsistent: `return / ttl expired / replaced / reconciler / single-track`. The verb tense doesn't match (`expired` vs `replaced` vs `reconciler` (a noun)).
- `since` and `until` are blank-default — there's no obvious "last 24h" / "today" preset, which is the most common slice.
- The catalog table is 11 columns wide with very short, cryptic headers (`net`, `tare`, `serving`, `per ctnr`, `container`, `unit`). On a desktop 1280-max layout this fits, but on the Pi's HDMI 1080p screen it likely word-wraps.
- The wipe button is in the same nav as `/inventory` even though /inventory is where you'd click `× delete this lot` per row — so destructive actions span the page, with no clear hierarchy of "small destructive" vs "thermonuclear destructive".

**Missing:**

- **Containers and servings together.** The user thinks in containers; the scale measures grams; the macros/servings translate. A single column "X.X ctn (Y servings, Z g)" is what the operator actually wants to read.
- **A "what changed in the last hour" feed.** With 81 usage rows + a session list + an event grid, there's no single feed. Even a 5-line "since you walked away: 1 add (chicken), 0 removes, catch-all idle" would be enormously calm-making.
- **In-flight age.** Lots in flight have `in_flight_since` in the schema but the column "since" only shows in the dashboard's gated panel. The inventory page doesn't show in-flight lots at all unless a section macro is rendered.
- A way to **manually drop / discard a lot to zero** without going through the per-row × button + confirm dialog (already in place but multi-step).
- **Reviews queue link** — there's a 84-badge in the nav, but the inventory page never references reviews even though they sit on the same data.
- An **outbox / cloud-sync indicator** on this page so the user can see whether their consumption has synced to the cloud.

**Suggestions (ranked):**

1. Add a "ctn / servings / g" column trio for on-shelf rows; default the most prominent display unit to **containers**, not grams. Mirror the cloud's mental model.
2. Group the usage log by `(occurred_at, return_event_id)` server-side and show one row per unique event with a "x16 duplicate inserts" muted note, plus a single "merge / clean up duplicates" admin action. This single fix removes ~95% of the noise.
3. Move "Classifier candidates" out of inventory entirely (or tuck it under a `?debug=1` flag). The operator never wants to see "in_flight / top_up_target / inventory_only" tier classification on the day-to-day page.

---

### /sessions

**User goal:** "What sessions happened, did they reconcile, was anything weird?"

**Today shows:**

- 100 sessions in a 10-column wide table: id (8-char), started, ended, duration, events, resolutions, initial, final, delta, reconciled — `sessions.html:13–71`
- Whole row clickable to /session/<id>; id is also a hyperlink — `sessions.html:30, 32`

**Friction:**

- **Hard-coded limit of 100** sessions (`routes.py:605`, `repo.list_sessions(limit=100)`). No pagination, no date filter, no kind filter ("show only sessions that didn't reconcile" / "show only sessions with at least 1 event").
- All sessions render as single-color rows; you have to read the resolutions column to spot interesting ones. Reconciled is `pill ok yes` for every visible session — there's no "no" example to ground the visual difference.
- The duration column shows seconds with one decimal (`8.0s`, `60.0s`, `4.0s`) — fine for short demo sessions, but for a 5-minute door-open it'd read `300.0s` instead of `5m 0s`.
- 0-event sessions (`events: 0`) outnumber meaningful ones in the demo data — there's no way to filter them out, and the "delta: +0.0 g" rows make the page feel padded.
- No total bar — no aggregate "of these 100 sessions, X had events, Y reconciled, average duration N s".

**Missing:**

- Filter / search by date, status, has-events, has-resolutions
- Total counts (sum of events, sum of |delta|) at top of page
- Visible link / icon to drop into the per-session debug timeline (it exists at `/session/<id>/timeline` but the only entry point is from the session detail page, not the list)

**Suggestions (ranked):**

1. Add a since/until/min-events filter row above the table (mirror /inventory's filter form) so the user can isolate "yesterday's real activity".
2. Highlight rows where reconciled is `no` or where `|delta|` is large but events == 0 (suspect drift); colored row backgrounds make those pop.
3. Default-hide 0-event 0-delta sessions behind an "include idle" checkbox.

---

### Debug timelines (`/event/<id>/timeline`, `/session/<id>/timeline`)

**User goal:** "Why did this event/session do what it did? Show me the lifecycle audit log."

**Today shows:**

- A different visual style entirely from the rest of the app — sans-serif, white background, light-grey table — `debug_routes.py:235–300`
- `<dl>` of session metadata, then a "N lifecycle rows" header, then a 4-column table (ts, actor, reason_code, payload) with hardcoded pastel `_REASON_COLORS` for known reasons
- Pretty-printed JSON payloads inside `<pre>` per row

**Friction:**

- The styling jump (dark-mode app → light-mode page) is jarring and signals "you've left the app". For a debug surface that's fine — but it's also the page the user is _most likely_ to land on when something's wrong, so the nav-bar continuity loss costs us.
- No back-link to the dashboard; only "← Back to session detail" / "← all events".
- Reason-code color legend isn't documented on-page (you have to look at the source to know `aaffaa = green = session_opened`).
- Payload JSON is fully expanded — for a 50-row timeline this becomes a 1000-line scroll. No collapsing, no per-actor filter.

**Missing:**

- A discoverable entry point. The only links are from `/event/<id>` and `/session/<id>` detail pages — `_base.html` nav has none. An operator doesn't know these pages exist unless they were told.
- Filters: per-actor (sweeper / reconciler / brightness), per-reason-code, expand/collapse all payloads.
- A search-in-timeline box for grepping `gap_fill_skipped` or similar.

**Suggestions (ranked):**

1. Either match the dark theme + nav of the rest of the app, or label it loudly as "DEBUG VIEW" so the visual break is intentional, not accidental.
2. Default-collapse the payload `<pre>` blocks (just show `reason_code` + `actor`); click-to-expand each row.
3. Add a `?debug=1` toggle on /sessions and /events that shows a "timeline" link per row, so operators can find this.

---

## Cross-cutting findings

- **Information density.** /inventory in particular packs ~5 panels and 3 tables on first paint (response is 60 KB). For a desktop console this works once you learn it; for a "walk up and glance" Pi screen, it does not. Hierarchy is flat — every section is a `.panel` with the same 12 px padding. The eye has nothing to anchor on.
- **Refresh model is well-engineered but invisible to the user.** Three pollers (300 ms / 500 ms / 1000 ms) with adaptive backoff and shared `/api/state` are good infra; the only feedback the user gets is the orange "offline" badge after 3 consecutive failures. There's no "last refreshed: 0.3 s ago" indicator, no spinner during catch-up, no manual "refresh now" button. The result is the page feels static even though it's polling 4 endpoints constantly.
- **Static / server-rendered content is stale.** /sessions, /inventory, and the recent events grid on / are all server-rendered on page load; they don't refresh until a manual reload. So if a chicken add happens while you're staring at the inventory page, the table doesn't update — it's the _previews and weight readings_ that update, not the _data_. That mismatch ("the live preview tile says +160 g but the on-shelf table still says only milk") will confuse the operator.
- **Error states are largely absent.** I checked /api/debug/health which reports `failed_events: 47` and `anthropic_calls_total: 0` for the recent window — but no surface in any of the user-facing pages mentions either number. The "offline" badge handles "Pi unreachable" but not "cloud unreachable", "camera daemon down", "outbox backlog", or "anthropic API rate-limited".
- **Confirm-dialog spam.** Every destructive action (delete product, delete usage row, delete lot, wipe-all) uses a `confirm()` + sometimes a `prompt('type WIPE')`. They're each safe individually but cumulatively they create the feeling of "this app is dangerous". A toast-style undo within N seconds would replace most of them.
- **Mobile.** The desktop styling assumes a min-width: 280 px column. On a phone, the live-preview MJPEG is full-width, but the 9-column inventory tables and 10-column sessions tables horizontally scroll without affordance. There's also no mobile-friendly nav (no hamburger). Practically, the user will only pull up the Pi from a browser tab on a laptop, and the kitchen Pi screen itself is desktop-sized — so this is low priority.
- **Discoverability of debug tools.** `/api/debug/health`, `/api/debug/invariants`, the timeline pages, and the `?debug=1` patterns aren't linked anywhere in the nav. The operator has to know they exist. The classifier candidates table on /inventory is the only debug surface that's surfaced naturally — but it's surfaced _too prominently_, conflating debug with operations.
- **Nav consistency.** The intake page nav (`intake.html` snippet I fetched) is _different_ from `_base.html` — it shows only `dashboard / inventory / intake` with no review/sessions/events/wipe. So the user loses navigation context the moment they enter intake. Likely an inheritance gap.
- **Time format inconsistency.** Dashboard tile: `04:23:17`. Sessions table: `2026-04-29 03:32:32`. Usage log: `2026-04-29T03:32:41.448Z`. Three different representations of "when". Pick one — local 24h with date-only-when-non-today is the operator-friendly choice.
- **The 84 pending reviews badge** is alarming in nav but never explained. What is "review"? Why are there 84? Are these blocking new events? The badge is a count without a meaning.

---

## Top 5 highest-impact UX changes (prioritized)

1. **Make containers a first-class unit on the inventory on-shelf table.** Lead with `1.6 ctn` (or `0.8 servings`), put grams in the muted secondary line, and label the column "remaining" rather than "on scale" / "content left" (which sound like measurements, not state). This single change closes the "1.6 ctn vs 160.4 g" cognitive gap the user already flagged and makes the Pi speak the same language as the cloud.
2. **Collapse usage-log duplicates server-side.** Group by `(lot_id, return_event_id, occurred_at)` and render one row with a count badge ("16x recorded") + a "deduplicate" admin link. This makes "show 5 per page" actually meaningful — the user wants to scan the last 5 distinct events, not the last 5 SQL inserts of the same event.
3. **Replace the 3 polled-but-static surfaces (Recent events grid on /, on-shelf tables on /inventory, sessions table) with auto-refreshing fragments** driven by an event-bus / SSE / 5-second poll. Right now a chicken add happens, the live preview updates, but the inventory table is wrong until a manual reload. That's the most jarring inconsistency on the whole UI.
4. **Surface system health (cloud sync, camera daemon, outbox, anthropic, drift) in a dedicated tile on /.** The data is already in `/api/debug/health`. Pull `failed_events`, `cloud_drift_s`, `pending_events`, `anthropic_errors_total` into a 4-cell health tile next to "shelf totals". A green/amber/red dot per row gives the user the "is the kitchen happy?" read in 1 second.
5. **Differentiate the two camera tiles + label by device-id.** Show "scale-02 — live shelf" and "scale-03 — single-track" (and "catch-all — scale-04" or wherever) under each preview, with a colored left-border per shelf so that even at a glance you can't confuse them. Tiny change, large clarity gain.

---

## Things that ARE working well

- The **adaptive polling backoff ladder** (`dashboard.html:287–514`) is genuinely thoughtful: 300/1000/3000 ms with consecutive-failure thresholds prevents a dead Pi from melting the network, and the `setOfflineUI` function only flashes the badge after 3 misses, so a single hiccup doesn't strobe the screen. This is rare to see done correctly in a hand-rolled UI.
- **The catch-all empty state** is well written — "nothing currently on the catch-all scale" is in plain English. Don't undo this; copy this tone everywhere.
- **The 84-badge on the review nav link** is the right pattern for surfacing a queue — it's just missing context. The badge mechanism is good.
- **Per-row × delete buttons** on the on-shelf and usage tables are operator-friendly. The interaction model (hover reveals red, click prompts confirm with the row name) is a genuinely calm pattern; just needs less noise from the duplicate row problem and an undo.
- **Sticky tare-arm banner** with countdown and per-product `ARMED…` button state is a nicely scoped workflow once you're on /inventory and know to look for it. The state machine (arm → place → auto-capture, or cancel) is clean.
- **The `wipe` button's two-step confirm + literal `WIPE` typing** is the right kind of friction for a thermonuclear action. Just relocate it out of the global nav and into a `Settings` / admin sub-page so it's not visible during normal work.
