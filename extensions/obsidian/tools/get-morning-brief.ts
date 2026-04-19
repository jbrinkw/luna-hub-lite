import type { ExtensionToolDefinition, ExtensionToolContext } from '@luna-hub/app-tools';
import { toolSuccess, toolError } from '@luna-hub/app-tools';
import { getGitCredentials, getTree, getBlobContent, getMultipleBlobs } from './git-api';
import { buildProjectTree, resolveProject, parseNoteEntries } from './vault-parser';

const DEFAULT_PROJECT_ID = 'Daily Review';
const WINDOW_DAYS = 7;
const MAX_NOTES = 40;

/** Depth of a path by counting slashes. Shallower paths first for deterministic truncation. */
function depth(p: string): number {
  let n = 0;
  for (const c of p) if (c === '/') n++;
  return n;
}

const ROUTINE_INSTRUCTIONS = `MORNING ROUTINE INSTRUCTIONS
=============================

You are running Jeremy's morning accountability routine. The "Morning Brief"
below (inside today's Notes.md entry) was pre-composed last night by the
nightly skill and includes a suggested plan. The current goals doc
(\`root_doc.text\`) holds the live commitment stack at every tier (5-year
arc / yearly / monthly / weekly). The last 7 days of vault-wide notes
(\`recent_notes.entries\`, newest-first) give you closure history and
rollover evidence.

BEFORE ANYTHING: call these two Todoist tools in parallel for live state:
- \`TODOIST_get_tasks\` (no filter) — the full open ledger
- \`TODOIST_get_completed_tasks(since: '<yesterday>T00:00:00Z', until: '<today>T00:00:00Z')\`
  — what the user actually checked off yesterday. Prevents you from asking
  about tasks that are already done.

STEP 1 — DAILY CLOSURE (gated; no planning until done)
------------------------------------------------------
Look at yesterday's Daily Review Notes.md entry in \`recent_notes\`. If it
already has an "## Evening Summary" section, skip to Step 2.

Otherwise, split yesterday's tasks into two buckets:

A. Already-completed in Todoist (from get_completed_tasks) — these close
   automatically as [x]. Confirm each quickly with the user ("closed these
   — any to reclassify as rolled/dropped?") but don't iterate through them
   one by one.

B. Still-open in Todoist that were due yesterday + overdue (from get_tasks
   filtered to yesterday/overdue) — for each, ask the user:
   closed / rolled / dropped.

  closed   → TODOIST_complete_task(task_id). Closure line: [x] <task>
  rolled   → TODOIST_update_task(task_id, due_string: "today").
             Closure line: [~] <task> [rolls: N] where N = (prior rolls from
             the last 7 days of notes) + 1. If N >= 2, ASK "what's different
             this time?" before accepting.
  dropped  → TODOIST_complete_task(task_id) AND closure line:
             [-] <task> — <one-line reason>. Todoist can't distinguish drop
             from done; the [-] in Obsidian is the truth.

Write the closure block in ONE call to YESTERDAY's Notes.md entry:
  OBSIDIAN_update_project_note(
    project_id: "Daily Review",
    date: "<yesterday MM/DD/YY>",
    section_id: "Evening Summary",
    content: <all closure lines joined by \\n>
  )

If a closed/dropped commit was also at weekly/monthly/yearly tier (lives in
the root doc, NOT Todoist), patch it out of the root doc:
  - Closed/dropped at higher tier → remove the line.
  - Rolled at higher tier → toggle to [ ] X [rolls: N+1] (still open).
Use OBSIDIAN_patch_project_root (see Patch Construction below).

STEP 2 — BRIEF REVIEW
---------------------
Find today's entry in \`recent_notes\` and read the "## Morning Brief"
section. Summarize for the user up top: open commits across tiers,
rollover flags, news highlights, drift notes, the suggested plan.

If no brief exists (nightly skill missed or hasn't run yet), say "no brief
tonight" and proceed without one.

STEP 3 — PLAN REVIEW WITH PUSHBACK
----------------------------------
The brief already suggests a plan. Walk the user through it. Before
accepting each commit, push back:

- Rollover check: if an item resembles something rolled 2+ times in recent
  notes, ask "what's different this time?"
- Tier alignment: if a daily commit doesn't obviously serve an active
  weekly/monthly/yearly commit, call it out as a question.
- Scope realism: 5+ items in an 8-hour day rarely lands. Check the past
  week's hit rate from \`recent_notes\` before accepting.
- Press once if a reason is weak. Disagreement is the point — you are not
  here to validate.

After acceptance:
- TODOIST_create_task(content, due_string: "today") for each NEW commit.
  Rolled-over items are already in Todoist from Step 1; do not duplicate.
- Mirror the day's plan to today's Notes.md via
  OBSIDIAN_update_project_note(section_id: "Plan for today", content: ...)

STEP 4 — CADENCE BRANCHES
-------------------------
Additional branches fire based on today's date. Multiple can fire in the
same session (e.g., Mon Apr 1 = daily + weekly plan + monthly plan).

- Sunday → WEEKLY CLOSE: read root doc's "## Week of <X>" section. Ask per
  commit (closed/rolled/dropped). Write closure block as
  "## Weekly Close (Week of <X>)" to TODAY's Notes.md entry. Patch root
  doc: remove closed/dropped lines; toggle rolled tags.

- Monday → WEEKLY PLAN: nightly skill suggested weekly commits in the
  brief. Walk through with pushback at weekly tier (does each serve a
  monthly/yearly?). Patch root doc to swap "## Week of <last>" →
  "## Week of <new>" in one patch, carrying rolled items with their tags.

- Last day of month → MONTHLY CLOSE: same pattern as weekly, against
  "## <Month Year>" section. Closure block as
  "## Monthly Close (<Month>)" to today's Notes.md.

- First of month → MONTHLY PLAN: same pattern as weekly plan, against the
  monthly section. Push back at monthly tier (does each serve a
  yearly/5y arc?).

- Dec 26+ → YEARLY NUDGE: prompt user to do yearly review manually.
  Do NOT auto-write the yearly section.

COMMITMENT FORMAT
-----------------
  [ ] X                 open, never rolled
  [ ] X [rolls: N]      open, has been rolled N times previously
  [x] X                 done
  [~] X [rolls: N]      closed-rolled this period (carries to next as
                        [ ] X [rolls: N])
  [-] X — <reason>      dropped

Live commits with [rolls: 2]+ MUST trigger auto-pushback at their tier's
plan day. Non-optional.

PATCH CONSTRUCTION (for OBSIDIAN_patch_project_root)
----------------------------------------------------
Each \`find\` must match exactly once in the current root doc. If a line
might appear in multiple sections, include the section heading in \`find\`
for disambiguation:

  patches: [{
    find: "## Week of 4/13/26\\n\\n- [ ] ship barcode\\n- [ ] recruiter\\n",
    replace: "## Week of 4/13/26\\n\\n- [ ] ship barcode\\n"
  }]

Batch multiple edits into one call — patches apply atomically. On HTTP 409
(concurrent edit), re-read the root doc and retry once. Two failures =
surface to user.

DON'TS
------
- Don't validate without pushing back. You exist to be argued with.
- Don't expand scope. Accepting 5+ commits without protest is failure.
- Don't silently rewrite root doc structure. Only touch sections by user
  direction or clear cadence trigger.
- Don't skip closure to get to planning. Closure is gated.
- Don't write Todoist tasks without mirroring to Notes.md. Obsidian is
  ground truth; Todoist is the 24h working list.
- Don't pre-script dialogue. Talk like a thoughtful colleague who's read
  the user's history, not a checklist.
`;

export const OBSIDIAN_get_morning_brief: ExtensionToolDefinition = {
  name: 'OBSIDIAN_get_morning_brief',
  extensionName: 'obsidian',
  description:
    'Retrieves the pre-composed Morning Brief + current goals doc + last 7 days of vault notes, plus step-by-step instructions for running the morning accountability routine. Call once when the user asks for their morning brief, wants to do their morning review, or asks for the daily accountability sync. Returns everything needed to run closure on yesterday, review the suggested plan, and commit to today — follow the routine_instructions field verbatim.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: {
        type: 'string',
        description: `Morning review project. Defaults to "${DEFAULT_PROJECT_ID}". Must exist in the vault with a root doc and Notes.md.`,
      },
    },
  },
  handler: async (args, ctx) => {
    const creds = getGitCredentials(ctx as ExtensionToolContext);
    if (!creds) return toolError('Missing credentials (github_token, github_repo)');

    const projectId =
      typeof args.project_id === 'string' && args.project_id.trim().length > 0
        ? args.project_id.trim()
        : DEFAULT_PROJECT_ID;

    try {
      const tree = await getTree(creds);
      const projects = buildProjectTree(tree);

      const { project, ambiguous } = resolveProject(projects, projectId);
      if (!project) {
        if (ambiguous.length > 0) {
          const cands = ambiguous.map((p) => p.id).join(', ');
          return toolError(`Ambiguous project "${projectId}". Candidates: ${cands}`);
        }
        return toolError(
          `Project "${projectId}" not found. Create it explicitly (OBSIDIAN_create_project) and populate the root doc before running the morning routine.`,
        );
      }

      // Collect every Notes.md in the vault (unscoped — the whole vault, not
      // just the morning review project's subtree). Shallowest-first for
      // deterministic truncation if we hit the 40-file cap.
      const noteFileEntries: Array<{ path: string; sha: string }> = [];
      for (const p of projects.values()) {
        if (p.noteFilePath && p.noteFileSha) {
          noteFileEntries.push({ path: p.noteFilePath, sha: p.noteFileSha });
        }
      }
      noteFileEntries.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));

      const truncated = noteFileEntries.length > MAX_NOTES;
      const omitted = truncated ? noteFileEntries.length - MAX_NOTES : 0;
      const toFetchNotes = noteFileEntries.slice(0, MAX_NOTES);

      // Parallel fetch: root doc by SHA + all Notes.md files by SHA.
      const [rootText, notesContents] = await Promise.all([
        getBlobContent(creds, project.rootFileSha),
        getMultipleBlobs(creds, toFetchNotes, MAX_NOTES),
      ]);

      // Filter parsed entries to the [today - (WINDOW_DAYS - 1), today] window (inclusive, 7 days).
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const windowStart = new Date(today);
      windowStart.setDate(today.getDate() - (WINDOW_DAYS - 1));

      const entries: Array<{ file: string; date: string; date_str: string; content: string }> = [];
      for (const [path, { content }] of notesContents) {
        const parsed = parseNoteEntries(content);
        for (const e of parsed) {
          if (e.date >= windowStart && e.date <= today) {
            entries.push({
              file: path,
              date: e.date.toISOString().split('T')[0],
              date_str: e.dateStr,
              content: e.content,
            });
          }
        }
      }
      entries.sort((a, b) => b.date.localeCompare(a.date));

      return toolSuccess({
        status: 'success',
        project_id: project.id,
        root_doc: {
          path: project.rootFilePath,
          text: rootText,
        },
        recent_notes: {
          window_days: WINDOW_DAYS,
          entries,
          truncated,
          omitted_notes_files: omitted,
        },
        routine_instructions: ROUTINE_INSTRUCTIONS,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
