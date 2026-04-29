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
- \`TODOIST_get_completed_tasks()\` — no args needed. Defaults to the last
  7 days of completions in the Inbox project (where daily commits live).
  Filter results by \`completed_at\` locally if you only want yesterday
  or today. The wide UTC window is intentional: a user's local-yesterday
  often straddles UTC midnight, and a tight window misses completions.

STEP 1 — DAILY CLOSURE (gated; no planning until done)
------------------------------------------------------
Yesterday's closure comes from two complementary sources — treat them as
ADDITIVE, not competing. Content differs; that's normal:

- Todoist completed (get_completed_tasks, filtered to yesterday local):
  what was checked off in the app.
- Evening Summary section in yesterday's Daily Review Notes.md entry:
  the user's first-person closure. Often contains unplanned work,
  context (blockers, "built not verified"), and items that were never
  Todoist tasks.

A. If yesterday's entry has an "## Evening Summary" section AND the
   nightly Morning Brief's "### Unresolved from yesterday" section is
   empty or absent → closure is already done. Skip to Step 2.

B. If the Morning Brief lists any "### Unresolved from yesterday" items
   (ones the user mentioned but didn't explicitly close) → for each,
   prompt the user right now:
     "Yesterday you noted '<item> — <their phrasing>'. Closed, rolled,
      or dropped?"
   Apply the user's answer per the outcome table below. Append the
   resolution to yesterday's Evening Summary via update_project_note
   (it appends inside the existing section — no duplicate header).

C. If there is NO Evening Summary at all → fall back to full closure:
   iterate through Todoist items due yesterday + overdue, and for each
   ask closed / rolled / dropped. Write the closure block as the
   Evening Summary for yesterday.

Outcomes:
  closed   → TODOIST_complete_task(task_id) if the item is a Todoist
             task. Closure line: [x] <task>
  rolled   → TODOIST_update_task(task_id, due_string: "today") if
             Todoist-tracked. Closure line:
             [~] <task> [rolls: N] where N = (prior rolls from the last
             7 days of notes) + 1. If N ≥ 2, ASK "what's different this
             time?" before accepting.
  dropped  → TODOIST_complete_task(task_id, delete: true) if
             Todoist-tracked. The delete flag removes the task from
             Todoist entirely so it doesn't pollute the completion
             log — dropped items shouldn't read as "done" in the
             audit trail. Closure line:
             [-] <task> — <one-line reason>. The [-] in Obsidian is
             the accountability truth.

Writing closure to yesterday's Notes.md entry:
  OBSIDIAN_update_project_note(
    project_id: "Daily Review",
    date: "<yesterday MM/DD/YY>",
    section_id: "Evening Summary",
    content: <new closure lines joined by \\n>
  )

If a closed/dropped commit was also at weekly/monthly/yearly tier (lives
in the root doc, NOT Todoist), patch it out of the root doc:
  - Closed/dropped at higher tier → remove the line.
  - Rolled at higher tier → toggle to [ ] X [rolls: N+1] (still open).
Use OBSIDIAN_patch_file (see Patch Construction below) with the root doc
path, e.g. \`Daily Review/Daily Review.md\`.

STEP 2 — BRIEF REVIEW
---------------------
Find today's entry in \`recent_notes\` and read the "## Morning Brief"
section. Summarize for the user up top: yesterday's merged closure,
rollover/risk flags, news highlights, the suggested plan. For open
commitments at the weekly/monthly/yearly tier, reference the root doc
directly — don't re-list them in the summary.

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

PATCH CONSTRUCTION (for OBSIDIAN_patch_file)
--------------------------------------------
Takes a full vault-relative \`path\` + a \`patches\` array. Works on any
existing text file: root doc (\`Daily Review/Daily Review.md\`),
Notes.md (\`Daily Review/Notes.md\`), or any other project's files.

Each \`find\` must match exactly once in the current file. If a line
might appear in multiple sections, include the section heading in \`find\`
for disambiguation:

  path: "Daily Review/Daily Review.md"
  patches: [{
    find: "## Week of 4/13/26\\n\\n- [ ] ship barcode\\n- [ ] recruiter\\n",
    replace: "## Week of 4/13/26\\n\\n- [ ] ship barcode\\n"
  }]

Batch multiple edits into one call — patches apply atomically. On HTTP 409
(concurrent edit), re-read the file and retry once. Two failures = surface
to user.

Notes.md can also be patched with this tool (e.g. to remove a bad section
written earlier in a session). \`update_project_note\` is still the tool
for appending new content; \`patch_file\` is for surgical edits + cleanup.

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
        description: `Accountability project to read. Defaults to "${DEFAULT_PROJECT_ID}". Must exist in the vault with a root doc and Notes.md.`,
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
      // just the accountability project's subtree). Shallowest-first for
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
      const [rootText, { blobs: notesContents, failedCount }] = await Promise.all([
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
          // omitted_notes_files counts both cap-truncated files and per-file
          // fetch failures so the LLM knows the brief may be incomplete.
          omitted_notes_files: omitted + failedCount,
        },
        routine_instructions: ROUTINE_INSTRUCTIONS,
      });
    } catch (e) {
      return toolError(`Error: ${(e as Error).message}`);
    }
  },
};
