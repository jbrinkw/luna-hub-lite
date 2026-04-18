---
name: nightly-accountability-sync
description: Nightly accountability pass — reads yesterday's state, composes today's Morning Brief with a suggested plan (cadence-aware on Sunday/Monday/last day/1st of month), writes the brief to the Morning Review Notes.md entry. One autonomous run per night; no user interaction.
---

# Nightly Skill

Scheduled run, once per night (recommended: 3am Charlotte time — post-midnight so "today" resolves to the day the user wakes up into). One autonomous pass: read state, compose, write, done. No user in the loop.

## Your job

Assemble the **Morning Brief** — a short accountability summary + a suggested plan for today — and write it as a `## Morning Brief` section to today's `Morning Review/Notes.md` entry. The user will read this in the morning with fresh eyes, review / modify / accept the suggested plan, and run closure on yesterday. That's the morning routine — not your problem. You just prepare the ground.

## Tools available

LunaHubLite MCP (full access). Web search via your runtime environment.

Canonical tool names (your client may prefix them):

- `OBSIDIAN_get_project_text(project_id)` — reads root + Notes.md for a project
- `OBSIDIAN_get_notes_by_date_range(start, end, project_id?)` — windowed Notes.md reads; unscoped when `project_id` omitted
- `OBSIDIAN_update_project_note(project_id, content, section_id?, date?)` — appends to a dated Notes.md entry's section
- `TODOIST_get_tasks` — all active Todoist tasks (no filter)
- `TODOIST_get_completed_tasks(since, until)` — tasks the user already checked off in a date range (ISO datetime strings)

You do NOT edit the root doc. That's the user's (and morning routine's) territory.

## Flow

### 1. Read everything in parallel

- `OBSIDIAN_get_project_text("Morning Review")` — root doc (5y / yearly / monthly / weekly commits + active projects list + news topics list) + recent `Notes.md` entries
- `OBSIDIAN_get_notes_by_date_range(<7-days-ago MM/DD/YY>, <today MM/DD/YY>)` — UNSCOPED (no `project_id`). Returns last 7 days of every Notes.md in the vault: accountability history + journal + every project's progress notes. 40-Notes.md cap applies but is fine for this vault.
- `TODOIST_get_tasks` — full open ledger, no filter. Todoist holds long-term tasks in addition to today's items.
- `TODOIST_get_completed_tasks(since: '<yesterday>T00:00:00Z', until: '<today>T00:00:00Z')` — what the user actually checked off yesterday. Use this to know what got done (closure is not written to Obsidian yet by the user; the morning routine will do that). Without this, the brief can't distinguish "open and rolled" from "open but completed in Todoist, waiting for morning closure to log".

If `get_project_text("Morning Review")` errors with "project not found", the user hasn't initialized the Morning Review project yet. Log the error and end the run — do NOT attempt to create it yourself.

### 2. Identify rollover patterns + yesterday's completions

- From the last 7 days of Notes.md entries, count rollover occurrences per task (look for `[~] <task> [rolls: N]` in closure blocks).
- From the root doc, note any `[rolls: N]` tag where N ≥ 2 on live commits — these are auto-flag candidates.
- From `TODOIST_get_completed_tasks` for yesterday, record the actual completions: what the user checked off. This is ground truth for "what got done yesterday." The morning routine will turn these into closure lines tomorrow; your job is to reflect them in the brief so the user sees the night's accounting accurately.

### 3. News research (web search)

For each topic in the root doc's `## News Topics` section, search for items from the last 24 hours.

- **Filter ruthlessly**. Aim for **3–5 bullets TOTAL across all topics**, not per topic.
- Prefer directly relevant over broadly interesting.
- Don't repeat news already in recent briefs (scan the last few `## Morning Brief` sections in Notes.md to dedupe).

### 4. Drift check (one line, only if obvious)

Compare the last 7 days of project activity (from the unscoped notes read) to the root doc's monthly + weekly commits.

- If a project's getting heavy attention but isn't on the active-projects list → one-line mention.
- If a committed project hasn't been touched in 5+ days → one-line mention.
- **Don't propose root doc edits.** That's the user's call.

### 5. Suggest a plan for today (cadence-aware)

Always suggest a daily plan:

- Start from open Todoist items due today + any overdue.
- Weight toward commits that serve active weekly/monthly goals.
- Respect scope realism: aim for 3–4 items max based on last week's observed hit rate.
- If a rolled item has `[rolls: N ≥ 2]`, flag it in the suggestion — don't silently re-propose.

**If today is Sunday, Monday, last day of month, or 1st of month**, also suggest commits for the relevant higher tier:

| Today             | Also suggest                                             |
| ----------------- | -------------------------------------------------------- |
| Sunday            | Weekly close candidates (which items to close/roll/drop) |
| Monday            | Next week's weekly commits                               |
| Last day of month | Monthly close candidates                                 |
| 1st of new month  | Next month's monthly commits                             |

Multiple can fire in one run (Mon Apr 1 = daily + weekly + monthly suggestions).

### 6. Assemble the Morning Brief

Use this structure exactly. The `## Morning Brief` heading is added by the tool — don't include it in your `content`.

```
### Yesterday — completed
- [x] <each item the user checked off in Todoist yesterday>
(skip section if nothing was completed)

### Open commitments
- daily (Todoist due today + overdue): <list, item names only>
- this week: <list from root doc weekly section, inline [rolls: N] tags where present>
- this month: <list from root doc monthly section>

### Flags
- <task> rolled <N>× — what's different this time?
(skip section entirely if no flags)

### News digest
- <bullet 1>
- <bullet 2>
- <bullet 3>

### Drift
<one short line, or skip if nothing notable>

### Suggested plan for today
- [ ] <suggested commit 1>
- [ ] <suggested commit 2>
- [ ] <suggested commit 3>

### Suggested weekly commits (if Monday)
- [ ] <weekly 1>
- [ ] <weekly 2>
(skip unless Monday; on Sunday, instead list weekly close candidates)

### Suggested weekly close (if Sunday)
Current week: <list each live item with a proposed outcome>
- <item 1> → suggest: closed / rolled / dropped (with reason)
(skip unless Sunday)

### Suggested monthly commits (if 1st of month)
(same pattern)

### Suggested monthly close (if last day of month)
(same pattern)

### Task errors
- <any tool failures during this run>
(skip if none)
```

### 7. Write the brief

```
OBSIDIAN_update_project_note(
  project_id: "Morning Review",
  section_id: "Morning Brief",
  content: "<the assembled brief body, without the '## Morning Brief' heading>"
)
```

`date` defaults to today (the calendar date when this task runs). Post-midnight scheduling makes "today" = the day the user wakes up into.

### 8. Verify

Re-read today's Morning Review entry via `OBSIDIAN_get_notes_by_date_range(<today>, <today>, "Morning Review")`. Confirm a `## Morning Brief` section is present with at least Open commitments, News digest, and Suggested plan.

If something is missing, retry the write **once**. If the second attempt fails, end the run cleanly — the morning tool handles "no brief" gracefully.

## Constraints

- **Push back first, validate second.** Flag rollovers and drift; don't cheerlead.
- **Keep it short.** The user reads this groggy.
- **Do NOT edit the root doc.** Only the user (via the morning routine) changes tier commitments.
- **Do NOT create the Morning Review project.** If it's missing, surface the error and end.
- If a tool call fails mid-run, capture the failure in `### Task errors` instead of aborting.
- Don't repeat news from prior briefs — scan recent briefs and vary the digest.
- The brief is for the human, not the next agent. Plain English, no JSON, no internal-state dumps.
