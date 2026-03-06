import { describe, it, expect, afterAll } from 'vitest';
import { todoistTools } from '../../../../../extensions/todoist/tools';
import type { ExtensionToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Todoist Live Integration Tests
// ---------------------------------------------------------------------------
// These tests hit the real Todoist REST API v1. They require a valid API key
// in the TODOIST_API_KEY environment variable. When the key is absent the
// entire suite is skipped automatically.
//
// Tests are SEQUENTIAL — later tests depend on IDs produced by earlier ones.
// Flow: list projects -> list sections -> create tasks -> get/list tasks ->
//       update tasks (content, description, priority, due_string) ->
//       complete tasks -> missing credentials
// ---------------------------------------------------------------------------

const TODOIST_API_KEY = process.env.TODOIST_API_KEY;
const skip = !TODOIST_API_KEY;

function ctx(): ExtensionToolContext {
  return {
    userId: 'test',
    supabase: {} as any,
    credentials: { todoist_api_key: TODOIST_API_KEY! },
  };
}

function parse(result: any) {
  if (result.isError) throw new Error(result.content[0].text);
  return JSON.parse(result.content[0].text);
}

describe.skipIf(skip)('Todoist Live Integration Tests', () => {
  // Shared state across sequential tests
  let inboxProjectId: string;
  let createdTaskId: string; // minimal task
  let allFieldsTaskId: string; // task with all fields
  const createdTaskIds: string[] = [];

  // Cleanup: delete any tasks we created that weren't completed
  afterAll(async () => {
    for (const taskId of createdTaskIds) {
      try {
        await fetch(`https://api.todoist.com/api/v1/tasks/${taskId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${TODOIST_API_KEY}` },
        });
      } catch {
        /* best-effort */
      }
    }
  });

  // -----------------------------------------------------------------------
  // 1. List projects and find the inbox
  // -----------------------------------------------------------------------
  it('should list projects and find the inbox', async () => {
    const result = await todoistTools.TODOIST_get_projects.handler({}, ctx());
    const projects = parse(result);

    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThanOrEqual(1);

    const inbox = projects.find((p: any) => p.inbox_project === true);
    expect(inbox).toBeDefined();
    expect(inbox.id).toBeTruthy();
    expect(inbox.name).toBeTruthy();

    inboxProjectId = inbox.id;
  });

  // -----------------------------------------------------------------------
  // 2. List sections for the inbox project
  // -----------------------------------------------------------------------
  it('should list sections for inbox project', async () => {
    const result = await todoistTools.TODOIST_get_sections.handler({ project_id: inboxProjectId }, ctx());
    const sections = parse(result);

    expect(Array.isArray(sections)).toBe(true);
    // Sections may be empty on a fresh account — just verify array shape
  });

  // -----------------------------------------------------------------------
  // 3. List sections without project filter
  // -----------------------------------------------------------------------
  it('should list sections without project filter', async () => {
    const result = await todoistTools.TODOIST_get_sections.handler({}, ctx());
    const sections = parse(result);

    expect(Array.isArray(sections)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. Create task (minimal — content only)
  // -----------------------------------------------------------------------
  it('should create a task with content only', async () => {
    const result = await todoistTools.TODOIST_create_task.handler({ content: 'Luna test task (minimal)' }, ctx());
    const task = parse(result);

    expect(task.id).toBeTruthy();
    expect(task.content).toBe('Luna test task (minimal)');

    createdTaskId = task.id;
    createdTaskIds.push(task.id);
  });

  // -----------------------------------------------------------------------
  // 5. Create task with all fields
  // -----------------------------------------------------------------------
  it('should create a task with all fields', async () => {
    const result = await todoistTools.TODOIST_create_task.handler(
      {
        content: 'Luna test task (all fields)',
        description: 'Full integration test task',
        priority: 3,
        due_string: 'tomorrow',
      },
      ctx(),
    );
    const task = parse(result);

    expect(task.id).toBeTruthy();
    expect(task.content).toBe('Luna test task (all fields)');
    expect(task.description).toBe('Full integration test task');
    expect(task.priority).toBe(3);
    expect(task.due).toBeTruthy(); // due date format may differ from input

    allFieldsTaskId = task.id;
    createdTaskIds.push(task.id);
  });

  // -----------------------------------------------------------------------
  // 6. Get task by ID
  // -----------------------------------------------------------------------
  it('should get task by ID', async () => {
    const result = await todoistTools.TODOIST_get_task.handler({ task_id: allFieldsTaskId }, ctx());
    const task = parse(result);

    expect(task.id).toBe(allFieldsTaskId);
    expect(task.content).toBe('Luna test task (all fields)');
    expect(task.description).toBe('Full integration test task');
  });

  // -----------------------------------------------------------------------
  // 7. List tasks (no filter)
  // -----------------------------------------------------------------------
  it('should list tasks and find the created task', async () => {
    const result = await todoistTools.TODOIST_get_tasks.handler({}, ctx());
    const tasks = parse(result);

    expect(Array.isArray(tasks)).toBe(true);

    const found = tasks.find((t: any) => t.id === createdTaskId);
    expect(found).toBeDefined();
    expect(found.content).toBe('Luna test task (minimal)');
  });

  // -----------------------------------------------------------------------
  // 8. List tasks filtered by project_id
  // -----------------------------------------------------------------------
  it('should list tasks filtered by project_id', async () => {
    const result = await todoistTools.TODOIST_get_tasks.handler({ project_id: inboxProjectId }, ctx());
    const tasks = parse(result);

    expect(Array.isArray(tasks)).toBe(true);
    // Every returned task should belong to the inbox project
    for (const task of tasks) {
      expect(task.project_id).toBe(inboxProjectId);
    }
  });

  // -----------------------------------------------------------------------
  // 9. Update task — content only
  // -----------------------------------------------------------------------
  it('should update task content only', async () => {
    const result = await todoistTools.TODOIST_update_task.handler(
      {
        task_id: createdTaskId,
        content: 'Luna test task UPDATED',
      },
      ctx(),
    );
    const updated = parse(result);

    expect(updated.content).toBe('Luna test task UPDATED');
  });

  // -----------------------------------------------------------------------
  // 10. Update task — description (with re-fetch to verify persistence)
  // -----------------------------------------------------------------------
  it('should update task description and persist', async () => {
    const updateResult = await todoistTools.TODOIST_update_task.handler(
      {
        task_id: createdTaskId,
        description: 'Updated description via integration test',
      },
      ctx(),
    );
    const updated = parse(updateResult);
    expect(updated.description).toBe('Updated description via integration test');

    // Re-fetch to verify persistence
    const getResult = await todoistTools.TODOIST_get_task.handler({ task_id: createdTaskId }, ctx());
    const refetched = parse(getResult);
    expect(refetched.description).toBe('Updated description via integration test');
  });

  // -----------------------------------------------------------------------
  // 11. Update task — priority
  // -----------------------------------------------------------------------
  it('should update task priority', async () => {
    const result = await todoistTools.TODOIST_update_task.handler(
      {
        task_id: createdTaskId,
        priority: 4,
      },
      ctx(),
    );
    const updated = parse(result);

    expect(updated.priority).toBe(4);
  });

  // -----------------------------------------------------------------------
  // 12. Update task — due_string
  // -----------------------------------------------------------------------
  it('should update task due_string', async () => {
    const result = await todoistTools.TODOIST_update_task.handler(
      {
        task_id: createdTaskId,
        due_string: 'next week',
      },
      ctx(),
    );
    const updated = parse(result);

    // Due date format from API may differ from the input string — just verify it's set
    expect(updated.due).toBeTruthy();
  });

  // -----------------------------------------------------------------------
  // 13. Complete the first (minimal) task
  // -----------------------------------------------------------------------
  it('should complete the first task', async () => {
    const result = await todoistTools.TODOIST_complete_task.handler({ task_id: createdTaskId }, ctx());
    const data = parse(result);

    expect(data.completed).toBe(true);
    expect(data.task_id).toBe(createdTaskId);

    // Remove from cleanup list — completed tasks may not be deletable
    const idx = createdTaskIds.indexOf(createdTaskId);
    if (idx !== -1) createdTaskIds.splice(idx, 1);
  });

  // -----------------------------------------------------------------------
  // 14. Complete the second (all-fields) task
  // -----------------------------------------------------------------------
  it('should complete the second task', async () => {
    const result = await todoistTools.TODOIST_complete_task.handler({ task_id: allFieldsTaskId }, ctx());
    const data = parse(result);

    expect(data.completed).toBe(true);
    expect(data.task_id).toBe(allFieldsTaskId);

    // Remove from cleanup list
    const idx = createdTaskIds.indexOf(allFieldsTaskId);
    if (idx !== -1) createdTaskIds.splice(idx, 1);
  });

  // -----------------------------------------------------------------------
  // 15. Missing credentials should return an error
  // -----------------------------------------------------------------------
  it('should return error with missing credentials', async () => {
    const emptyCtx: ExtensionToolContext = {
      userId: 'test',
      supabase: {} as any,
      credentials: {},
    };

    const result = await todoistTools.TODOIST_get_projects.handler({}, emptyCtx);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing Todoist credentials');
  });
});
