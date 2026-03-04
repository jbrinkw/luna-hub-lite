import type { ToolDefinition } from '../types';
import { getTodayPlan } from './get-today-plan';
import { completeNextSet } from './complete-next-set';
import { logSet } from './log-set';
import { updatePlan } from './update-plan';
import { updateSummary } from './update-summary';
import { getHistory } from './get-history';
import { getSplit } from './get-split';
import { updateSplit } from './update-split';
import { setTimer } from './set-timer';
import { getTimer } from './get-timer';
import { getPrs } from './get-prs';
import { getExercises } from './get-exercises';

export const coachbyteTools: Record<string, ToolDefinition> = {
  [getTodayPlan.name]: getTodayPlan,
  [completeNextSet.name]: completeNextSet,
  [logSet.name]: logSet,
  [updatePlan.name]: updatePlan,
  [updateSummary.name]: updateSummary,
  [getHistory.name]: getHistory,
  [getSplit.name]: getSplit,
  [updateSplit.name]: updateSplit,
  [setTimer.name]: setTimer,
  [getTimer.name]: getTimer,
  [getPrs.name]: getPrs,
  [getExercises.name]: getExercises,
};
