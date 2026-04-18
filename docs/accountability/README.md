# Daily Review Accountability System

Daily accountability loop using the LunaHubLite MCP server. Three components:

1. **`Daily Review` Obsidian project** — system of record. Root doc holds the live commitment stack at every tier (5-year arc → yearly → monthly → weekly); `Notes.md` holds dated entries with closure + planning + the morning brief.
2. **`midnight-pass` scheduled task** — runs nightly (~3am Charlotte time). Assembles the next day's Morning Brief from the root doc, recent vault notes, Todoist, and a short news search. Writes the brief into today's `Notes.md` entry.
3. **`morning-sync` skill** — user-invoked manually each morning in a fresh chat. Closes yesterday, reviews the brief, plans today with engineered pushback, mirrors the day's plan to Todoist + Obsidian. Auto-fires weekly/monthly close+plan branches when the date hits the boundary.

## Files in this folder

| File                            | Purpose                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `morning-sync-SKILL.md`         | The morning-sync skill. Install at `~/.claude/skills/morning-sync/SKILL.md` (Claude Code) or paste into a project skill in claude.ai. |
| `midnight-pass-prompt.md`       | The scheduled-task prompt. Paste into your scheduled agent's instructions field.                                                      |
| `daily-review-root-template.md` | Root doc template for `Daily Review/Daily Review.md`. The skill auto-creates if missing, but you can paste manually too.              |

## Setup

1. **Install morning-sync skill** in your Claude environment of choice.
2. **Set up the scheduled task** with the `midnight-pass-prompt.md` content. Recommended: claude.ai cloud scheduled tasks at `claude.ai/code/scheduled` (doesn't require your machine awake), 3am EST/EDT, daily.
3. **Optional manual init**: create the `Daily Review` project in your vault and paste the template into `Daily Review/Daily Review.md`. Otherwise, the skill bootstraps on first run.

## Tier cadence

| Tier       | Where it lives               | Plan day      | Close day           |
| ---------- | ---------------------------- | ------------- | ------------------- |
| 5-year arc | root doc                     | manual        | manual              |
| Yearly     | root doc                     | manual        | late December nudge |
| Monthly    | root doc                     | 1st           | last day of month   |
| Weekly     | root doc                     | Monday        | Sunday              |
| Daily      | Todoist + today's `Notes.md` | every morning | every morning       |

## Commitment format

Markdown checkboxes everywhere:

| Marker             | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `[ ] X`            | open, never rolled                                                                      |
| `[ ] X [rolls: N]` | open, has been rolled N times                                                           |
| `[x] X`            | done                                                                                    |
| `[~] X [rolls: N]` | closed-rolled (N = count after this roll; carries to next period as `[ ] X [rolls: N]`) |
| `[-] X`            | dropped                                                                                 |

Any **live** commit with `[rolls: 2]` or higher auto-triggers a "what's different this time?" question from the agent at its tier's plan-day.

## Persistence model recap

- **Root doc** (`Daily Review/Daily Review.md`) — current state at each tier. Sections get _replaced wholesale_ on plan days. Edited via `OBSIDIAN_patch_project_root` (search-replace patches, atomic batches).
- **`Notes.md`** — append-only history. Daily entries with `MM/DD/YY` headers contain `## Evening Summary`, `## Plan for today`, `## Morning Brief`, and (on transition days) `## Weekly Close (Week of X)` / `## Monthly Close (Month)`. Edited via `OBSIDIAN_update_project_note`.
- **Todoist** — daily-tier only. Source of truth for "what to do in the next 24h." Closure of yesterday's tasks happens here every morning. Longer-horizon commits live in the root doc, not Todoist.
- **Git log** — the audit trail. The vault auto-commits, so weekly/monthly section history is recoverable.

## Required MCP tools

All in LunaHubLite. No additional setup beyond having the extension enabled in Hub:

- `OBSIDIAN_get_project_text`, `OBSIDIAN_get_notes_by_date_range`
- `OBSIDIAN_update_project_note(date?, section_id?)` — date defaults to today; supports backdate
- `OBSIDIAN_patch_project_root(patches[{find, replace}])` — atomic batch edits, errors on missing/ambiguous find
- `OBSIDIAN_create_project(name)` — first-run bootstrap only
- `TODOIST_get_tasks`, `TODOIST_complete_task`, `TODOIST_update_task`, `TODOIST_create_task`

The midnight task additionally needs web search, available natively in scheduled-agent runtimes (no MCP tool).
