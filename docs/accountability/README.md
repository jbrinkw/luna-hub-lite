# Daily Review Accountability System

Daily accountability loop using the LunaHubLite MCP server. Three pieces:

1. **`Daily Review` Obsidian project** — system of record. `Daily Review.md` (root) holds the live commitment stack at every tier (5-year arc → yearly → monthly → weekly) plus active projects + news topics lists. `Notes.md` holds dated entries with the morning briefs, plan mirrors, and closure blocks.
2. **Nightly skill** — one scheduled run late at night (post-midnight). Reads yesterday's state, all Todoist tasks, and the root doc. Composes today's Morning Brief _with a suggested plan_ — cadence-aware on Sunday/Monday/last day/1st of month — and writes it as `## Morning Brief` in today's Notes.md entry. No user interaction.
3. **`OBSIDIAN_get_morning_brief` MCP tool** — the morning side is now a tool, not a skill. Any Claude agent with LunaHubLite MCP can run the morning routine by calling this one tool: it returns the brief + current goals doc + last 7 days of vault notes + the full routine instructions. Agent follows the instructions verbatim.

## Files in this folder

| File                            | Purpose                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `nightly-skill.md`              | Paste into your scheduled agent's instructions (Cowork desktop or claude.ai cloud scheduled tasks).                    |
| `daily-review-root-template.md` | Initial `Daily Review/Daily Review.md` content. Paste manually during initial setup — the system does not auto-create. |
| `README.md`                     | This file.                                                                                                             |

No morning-side skill to install. `OBSIDIAN_get_morning_brief` lives in the MCP server; any agent with the Obsidian extension enabled can call it.

## Setup

One-time, in order:

1. **Create the Daily Review project** in your Obsidian vault. Either manually (make the folder + `Daily Review.md` + empty `Notes.md`) or ask an agent with MCP access to call `OBSIDIAN_create_project("Daily Review")`.
2. **Populate the root doc** from `daily-review-root-template.md`. Edit your 5-year arc, current yearly/monthly/weekly commits, active projects, and news topics.
3. **Set up the scheduled task** with the `nightly-skill.md` contents. Recommended: claude.ai cloud scheduled tasks (`claude.ai/code/scheduled`), daily at 3am Charlotte time. Post-midnight scheduling keeps "today" aligned with the day you wake up into.
4. **No install needed on the morning side.** Just ask any Claude agent with LunaHubLite MCP for your morning brief.

## Morning usage

Open a fresh chat with any Claude agent that has LunaHubLite MCP connected. Say: _"Run my morning brief"_ or _"Do my morning review."_

The agent calls `OBSIDIAN_get_morning_brief`. The tool returns:

- `root_doc.text` — current goals at every tier
- `recent_notes.entries` — last 7 days of notes across the entire vault (morning brief + journal + project activity)
- `routine_instructions` — step-by-step routine to follow verbatim

The agent follows the instructions: closure on yesterday (calls `TODOIST_get_tasks` + `TODOIST_complete_task` / `TODOIST_update_task`), writes the closure block to yesterday's Notes.md entry, summarizes the brief, reviews the suggested plan with engineered pushback, mirrors the accepted plan to today's Notes.md + Todoist.

## Tier cadence

| Tier       | Where it lives               | Plan day      | Close day           |
| ---------- | ---------------------------- | ------------- | ------------------- |
| 5-year arc | root doc                     | manual        | manual              |
| Yearly     | root doc                     | manual        | late December nudge |
| Monthly    | root doc                     | 1st           | last day of month   |
| Weekly     | root doc                     | Monday        | Sunday              |
| Daily      | Todoist + today's `Notes.md` | every morning | every morning       |

Nightly skill suggests commits at whichever tiers have a boundary tomorrow. Morning agent reviews + commits to root doc via `OBSIDIAN_patch_file` after user approval.

## Commitment format

Markdown checkboxes everywhere:

| Marker             | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `[ ] X`            | open, never rolled                                                                      |
| `[ ] X [rolls: N]` | open, has been rolled N times                                                           |
| `[x] X`            | done                                                                                    |
| `[~] X [rolls: N]` | closed-rolled (N = count after this roll; carries to next period as `[ ] X [rolls: N]`) |
| `[-] X — <reason>` | dropped (Todoist closes; Obsidian truth lives in `[-]`)                                 |

Any **live** commit with `[rolls: 2]` or higher auto-triggers a "what's different this time?" question from the agent at its tier's plan-day.

## Persistence model

- **Root doc** — current state at each tier. Sections replaced wholesale on plan days via `OBSIDIAN_patch_file` (atomic search-replace patches). Nightly skill never writes here.
- **`Notes.md`** — append-only history. Daily entries contain `## Evening Summary`, `## Plan for today`, `## Morning Brief`, and on transition days `## Weekly Close (Week of X)` / `## Monthly Close (Month)`. Edited via `OBSIDIAN_update_project_note`.
- **Todoist** — daily-tier working list. Nightly pulls all active tasks (no filter) for the brief; morning closes yesterday's items. Longer-horizon commits live in the root doc, not Todoist.
- **Git log** — audit trail. Vault auto-commits, so tier-section history is recoverable.

## Required MCP tools

All in LunaHubLite. Enable the Obsidian extension in Hub; the rest is automatic:

- `OBSIDIAN_get_morning_brief` — bundled read + routine instructions for the morning side
- `OBSIDIAN_get_project_text`, `OBSIDIAN_get_notes_by_date_range` — used by the nightly skill
- `OBSIDIAN_update_project_note` — appends to Notes.md entries (supports backdate via `date` arg)
- `OBSIDIAN_patch_file` — atomic batch edits to the root doc (used by the morning agent on plan/close days)
- `TODOIST_get_tasks`, `TODOIST_complete_task`, `TODOIST_update_task`, `TODOIST_create_task`

The nightly skill additionally needs web search (provided natively by scheduled-agent runtimes).
