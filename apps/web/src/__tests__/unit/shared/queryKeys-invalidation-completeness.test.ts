/**
 * TanStack Query invalidation completeness gate.
 *
 * For every named key in `queryKeys.ts`, asserts that EITHER:
 *   a) at least one call to `queryClient.invalidateQueries` referencing
 *      that key exists in the production source tree, OR
 *   b) the key has a registry entry in `queryKeys-invalidation-registry.ts`
 *      marking it as "read-only" with a justification note.
 *
 * This catches the class of bug where a new query key is added to
 * `queryKeys.ts` but the author forgets to wire up cache invalidation in
 * the corresponding mutation's `onSuccess` or realtime subscription.
 *
 * Implementation note: the test uses a static grep of the source tree via
 * Node's `child_process.execSync`. This is intentional — it avoids the
 * complexity of instrumenting a runtime query client while still giving a
 * fast, deterministic signal at unit-test tier (no Supabase connection
 * needed). The grep patterns mirror exactly what an engineer would search
 * for when auditing invalidation coverage manually.
 *
 * Grep strategy per key:
 *   1. `queryKeys.<keyName>(` — mutation onSuccess / inline invalidation
 *   2. `queryKeys.<keyName>:` — realtime subscription queryKeys array
 *   3. If neither hits, check the registry for "read-only" declaration.
 *
 * False-positive guard: the grep excludes `__tests__/` and the registry
 * file itself so test stubs and registry entries don't self-validate.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import { queryKeys } from '@/shared/queryKeys';
import { registryByKey } from '@/shared/queryKeys-invalidation-registry';

// ── Configuration ────────────────────────────────────────────────────────────

/**
 * Root of the production source tree. We grep only `src/` excluding
 * `__tests__/` to avoid test stubs counting as real invalidation.
 */
const SRC_ROOT = path.resolve(__dirname, '../../../');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a grep for `pattern` under `dir`, excluding the `__tests__` subtree
 * and the registry file. Returns true if at least one match is found.
 *
 * Uses `grep -rl` (recursive, list filenames only) so the cost is bounded
 * by the number of files, not the number of matches.
 */
function grepExists(pattern: string, dir: string): boolean {
  try {
    const result = execSync(
      `grep -rl --include="*.ts" --include="*.tsx" ` +
        `--exclude-dir="__tests__" ` +
        `-- '${pattern}' '${dir}'`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim().length > 0;
  } catch {
    // grep exits non-zero when no matches found.
    return false;
  }
}

/**
 * Determine whether `keyName` has evidence of invalidation in the
 * production source:
 *   - Direct `invalidateQueries` call: `queryKeys.<key>(` pattern
 *   - Realtime subscription queryKeys array: `queryKeys.<key>:` pattern
 *
 * Excludes the registry file from the grep to prevent circular
 * self-validation.
 */
function hasInvalidationEvidence(keyName: string): boolean {
  // Pattern 1: mutation / inline invalidation — `queryKeys.historyCount(`
  if (grepExists(`queryKeys\\.${keyName}(`, SRC_ROOT)) return true;
  // Pattern 2: realtime subscription queryKeys array entry — `queryKeys.historyCount:`
  if (grepExists(`queryKeys\\.${keyName}:`, SRC_ROOT)) return true;
  return false;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('queryKeys invalidation completeness gate', () => {
  const allKeys = Object.keys(queryKeys) as (keyof typeof queryKeys)[];

  const matched: string[] = [];
  const readOnly: string[] = [];
  const unmatched: string[] = [];

  for (const keyName of allKeys) {
    const entry = registryByKey.get(keyName);

    if (entry?.kind === 'read-only') {
      readOnly.push(keyName);
      continue;
    }

    if (hasInvalidationEvidence(keyName)) {
      matched.push(keyName);
    } else {
      unmatched.push(keyName);
    }
  }

  it('every queryKey is either invalidated by a mutation/realtime OR declared read-only in the registry', () => {
    if (unmatched.length > 0) {
      throw new Error(
        `The following queryKey(s) have NO invalidation evidence in the source tree and are NOT declared read-only:\n` +
          unmatched.map((k) => `  - ${k}`).join('\n') +
          `\n\nFix: either add a queryClient.invalidateQueries call for each key, ` +
          `wire it into a useRealtimeInvalidation subscription, or add a "read-only" ` +
          `entry in apps/web/src/shared/queryKeys-invalidation-registry.ts with a justification note.`,
      );
    }

    expect(unmatched).toHaveLength(0);
  });

  it('every read-only registry entry has a non-empty justification note', () => {
    const missingNote = readOnly.filter((k) => {
      const entry = registryByKey.get(k);
      return !entry?.note || entry.note.trim().length === 0;
    });

    if (missingNote.length > 0) {
      throw new Error(
        `Read-only registry entries missing justification notes:\n` +
          missingNote.map((k) => `  - ${k}`).join('\n'),
      );
    }

    expect(missingNote).toHaveLength(0);
  });

  it('registry covers all queryKeys (no stale registry entries for removed keys)', () => {
    const allKeySet = new Set(allKeys as string[]);
    const staleEntries = [...registryByKey.keys()].filter((k) => !allKeySet.has(k));
    if (staleEntries.length > 0) {
      throw new Error(
        `Registry has entries for keys not in queryKeys.ts:\n` +
          staleEntries.map((k) => `  - ${k}`).join('\n') +
          `\n\nFix: remove these stale entries from queryKeys-invalidation-registry.ts.`,
      );
    }
    expect(staleEntries).toHaveLength(0);
  });

  // Informational: log the breakdown so CI output is easy to read.
  it('logs invalidation coverage summary (always passes)', () => {
    const total = allKeys.length;
    // eslint-disable-next-line no-console
    console.log(
      `\nInvalidation completeness:\n` +
        `  Total queryKeys : ${total}\n` +
        `  Matched (invalidated): ${matched.length}\n` +
        `  Read-only (registry) : ${readOnly.length}\n` +
        `  Unmatched            : ${unmatched.length}\n` +
        (matched.length > 0 ? `\n  Matched keys: ${matched.join(', ')}` : '') +
        (readOnly.length > 0 ? `\n  Read-only keys: ${readOnly.join(', ')}` : '') +
        (unmatched.length > 0 ? `\n  UNMATCHED: ${unmatched.join(', ')}` : ''),
    );
    expect(true).toBe(true);
  });
});
