import { describe, it, expect, afterAll } from 'vitest';
import { todoistTools } from '../../../../../extensions/todoist/tools';
import type { ExtensionToolContext } from '../../types';

// ---------------------------------------------------------------------------
// Todoist Live Integration Tests
// ---------------------------------------------------------------------------
// These tests hit the real Todoist REST API. They require a valid API key in
// the TODOIST_API_KEY environment variable. When the key is absent the entire
// suite is skipped automatically.
//
// Tests are sequential — later tests depend on IDs produced by earlier ones.
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
  let createdTaskId: string;
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
        // best-effort cleanup
      }
    }
  });

  it('should list projects and find the inbox', async () => {
    const result = await todoistTools.TODOIST_get_projects.handler({}, ctx());
    const projects = parse(result);

    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThanOrEqual(1);

    const inbox = projects.find((p: any) => p.inbox_project === true);
    expect(inbox).toBeDefined();
    expect(inbox.id).toBeTruthy();

    inboxProjectId = inbox.id;
  });

  it('should list sections for inbox project', async () => {
    const result = await todoistTools.TODOIST_get_sections.handler({ project_id: inboxProjectId }, ctx());
    const sections = parse(result);

    expect(Array.isArray(sections)).toBe(true);
    // sections may be empty on a fresh account — just verify it's an array
  });

  it('should create a task', async () => {
    const result = await todoistTools.TODOIST_create_task.handler(
      {
        content: 'Luna test task',
        description: 'Integration test',
        priority: 2,
      },
      ctx(),
    );
    const task = parse(result);

    expect(task.id).toBeTruthy();
    expect(task.content).toBe('Luna test task');

    createdTaskId = task.id;
    createdTaskIds.push(task.id);
  });

  it('should get task by ID', async () => {
    const result = await todoistTools.TODOIST_get_task.handler({ task_id: createdTaskId }, ctx());
    const task = parse(result);

    expect(task.content).toBe('Luna test task');
    expect(task.description).toBe('Integration test');
  });

  it('should list tasks and find the created task', async () => {
    const result = await todoistTools.TODOIST_get_tasks.handler({}, ctx());
    const tasks = parse(result);

    expect(Array.isArray(tasks)).toBe(true);

    const found = tasks.find((t: any) => t.id === createdTaskId);
    expect(found).toBeDefined();
    expect(found.content).toBe('Luna test task');
  });

  it('should update the task', async () => {
    const updateResult = await todoistTools.TODOIST_update_task.handler(
      {
        task_id: createdTaskId,
        content: 'Luna test task UPDATED',
        priority: 4,
      },
      ctx(),
    );
    const updated = parse(updateResult);
    expect(updated.content).toBe('Luna test task UPDATED');
    expect(updated.priority).toBe(4);

    // Re-fetch to verify persistence
    const getResult = await todoistTools.TODOIST_get_task.handler({ task_id: createdTaskId }, ctx());
    const refetched = parse(getResult);
    expect(refetched.content).toBe('Luna test task UPDATED');
    expect(refetched.priority).toBe(4);
  });

  it('should complete the task', async () => {
    const result = await todoistTools.TODOIST_complete_task.handler({ task_id: createdTaskId }, ctx());
    const data = parse(result);

    expect(data.completed).toBe(true);
    expect(data.task_id).toBe(createdTaskId);

    // Remove from cleanup list — completed tasks are already gone
    const idx = createdTaskIds.indexOf(createdTaskId);
    if (idx !== -1) createdTaskIds.splice(idx, 1);
  });
});
