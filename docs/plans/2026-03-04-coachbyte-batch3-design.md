# Batch 3: CoachByte HIGH Functional Gaps — Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Add 6 missing HIGH-severity CoachByte features from the audit.

**Architecture:** All changes in TodayPage.tsx, SetQueue.tsx, and a new `plateCalc.ts` utility. No new pages, no migrations needed (existing schema supports all operations).

---

## Task 1: Inline Editing of Planned Sets

**Files:**

- Modify: `apps/web/src/components/coachbyte/SetQueue.tsx`
- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:** Change the Set Queue table from read-only display to inline-editable inputs. Each pending set row gets `<IonInput type="number">` for reps, load, and rest_seconds. Save on blur via a new `onUpdateSet(plannedSetId, field, value)` callback from TodayPage.

TodayPage adds an `updatePlannedSet` handler that does:

```typescript
await coachbyte()
  .from('planned_sets')
  .update({ [field]: value })
  .eq('planned_set_id', id);
```

Add `isEditing` ref to prevent Realtime refresh from overwriting mid-edit values (same pattern as legacy).

**Commit after this task.**

---

## Task 2: Add/Delete Planned Sets in Today Queue

**Files:**

- Modify: `apps/web/src/components/coachbyte/SetQueue.tsx`
- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:**

- **Delete:** Add a small "x" button per pending set row. Calls `onDeleteSet(plannedSetId)`. TodayPage handler: `await coachbyte().from('planned_sets').delete().eq('planned_set_id', id)`.
- **Add:** Add "Add Set" button below the queue table. Opens the existing AdHocSetForm-style picker (exercise + reps + load + rest), inserts a new planned_set row with the next order number.

TodayPage adds:

```typescript
const addPlannedSet = async (exerciseId: string, reps: number, load: number, rest: number) => {
  const maxOrder = Math.max(...sets.map((s) => s.order), 0);
  await coachbyte()
    .from('planned_sets')
    .insert({
      plan_id: planId,
      user_id: user.id,
      exercise_id: exerciseId,
      target_reps: reps,
      target_load: load,
      rest_seconds: rest,
      order: maxOrder + 1,
    });
  await loadPlan();
};

const deletePlannedSet = async (id: string) => {
  await coachbyte().from('planned_sets').delete().eq('planned_set_id', id);
  await loadPlan();
};
```

**Commit after this task.**

---

## Task 3: Delete Completed Sets

**Files:**

- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:** Add "Remove" button to each completed set row. Uses two-click pattern (first click shows "Confirm?", auto-resets after 3s). Handler:

```typescript
await coachbyte().from('completed_sets').delete().eq('completed_set_id', id);
await loadPlan();
```

Also need to un-mark the corresponding planned set as completed (set `completed: false` in local state, or just reload which recalculates from DB).

**Commit after this task.**

---

## Task 4: Plate Breakdown Display

**Files:**

- Create: `apps/web/src/shared/plateCalc.ts`
- Modify: `apps/web/src/components/coachbyte/SetQueue.tsx`
- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:** Port legacy `calculatePlates` + `formatWeightAndPlates` to TypeScript. Use the user's plate config from CoachByte settings (stored in `coachbyte.user_settings`). Default to legacy config: bar=45lb, plates={45:2, 35:1, 25:1, 15:1, 10:1}.

Display: wherever load is shown, append plate breakdown in parentheses. E.g., "185 (45,25)" or "bar" for 45lb.

TodayPage loads plate config once and passes to SetQueue. SetQueue calls `formatWeightAndPlates` on displayed loads.

**Commit after this task.**

---

## Task 5: Delete Today's Plan

**Files:**

- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:** Add "Reset Plan" button (two-click confirm pattern) that:

1. Deletes all planned_sets for the current plan_id (only uncompleted ones)
2. Deletes the daily_plan row itself
3. Calls `loadPlan()` which triggers `ensure_daily_plan` to regenerate from split template

This gives users a way to get fresh planned sets if they changed their split template.

```typescript
const resetPlan = async () => {
  if (!planId) return;
  // Delete uncompleted planned sets
  await coachbyte()
    .from('planned_sets')
    .delete()
    .eq('plan_id', planId)
    .not('planned_set_id', 'in', `(${completedPlanIds.join(',')})`);
  // Delete the plan itself (cascade will clean up)
  await coachbyte().from('daily_plans').delete().eq('plan_id', planId);
  await loadPlan(); // ensure_daily_plan recreates from template
};
```

**Commit after this task.**

---

## Task 6: Timer Expired State Written to DB

**Files:**

- Modify: `apps/web/src/components/coachbyte/RestTimer.tsx`
- Modify: `apps/web/src/pages/coachbyte/TodayPage.tsx`

**Design:** When the timer countdown reaches 0:

1. RestTimer calls a new `onExpired()` callback
2. TodayPage writes `state='expired'` to the timers table:

```typescript
await coachbyte().from('timers').update({ state: 'expired' }).eq('user_id', user.id);
```

This ensures other tabs/devices see the expired state via Realtime, fixing cross-device sync.

RestTimer already handles the `expired` display state. Just need to trigger the DB write.

**Commit after this task.**

---

## Execution Order

Tasks 1-2 touch SetQueue together (editing + add/delete). Do Task 1 first, then Task 2.
Tasks 3-6 are independent and can be parallelized after 1-2.
