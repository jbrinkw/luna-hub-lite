/**
 * test-isolation-audit.test.ts
 *
 * Static analysis gate: scans every *.test.{ts,tsx} under src/__tests__ and
 * fails if any file hard-codes a user UUID that looks like it belongs to a
 * real auth user (i.e. a UUID used where `createTestUser` should be called).
 *
 * What is a "user UUID violation"?
 *   A UUID that appears next to a user-ownership field name
 *   (user_id, userId, ownerId, owner_id, auth.uid) is a strong signal that
 *   the test is bypassing the standard fixture path. Entity-only UUIDs
 *   (product_id, session_id, lot_id, recipe_id, exercise_id, device_id,
 *   phantom IDs for 404 tests) are explicitly allowed — they do not identify
 *   a Supabase Auth user and therefore cannot cause cross-test contamination.
 *
 * Allowlist categories (all safe, no violation):
 *   1. UUIDs on non-user-id fields (product, session, lot, recipe, etc.)
 *   2. Nil UUID (00000000-0000-0000-0000-000000000000) used as a sentinel for
 *      "no session" / invalid-ID rejection tests.
 *   3. UUIDs in fixture / factory files (test-helpers.ts, setup.*.ts).
 *   4. UUIDs in snapshot files (*.snap).
 *   5. Branded-type unit tests (shared/branded-types.test.ts) — these use
 *      recognisable constant UUIDs to verify type narrowing, not DB writes.
 *   6. Illustrative UUIDs in comments.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const TESTS_ROOT = path.resolve(__dirname, '..');

function collectTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip the audit directory itself to avoid self-referential matches.
      if (entry.name === 'audit') continue;
      results.push(...collectTestFiles(full));
    } else if (/\.test\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Regex helpers
// ---------------------------------------------------------------------------

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// A line is a user-UUID violation only when a user-ownership field name AND
// a UUID appear on THE SAME LINE (or the assignment operator is on the same
// line as the UUID). Multi-line object spreads are fine — `user_id` on one
// line and the UUID on the next do not trigger this.
const USER_ID_FIELD_RE = /\b(user_id|userId|owner_id|ownerId|auth\.uid)\s*[:=]/i;

// Nil UUID — used as a "no session" / "invalid ID" sentinel; always safe.
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// Sentinel UUIDs whose explicit purpose is to represent a *foreign* or
// *different* user in RLS-rejection tests. These are intentional test inputs
// (they must not match the test user's real UUID), not leaked DB state.
const FOREIGN_SENTINEL_UUIDS = new Set([
  '00000000-0000-0000-0000-0000000000ff', // chef-backup-restore: cross-user rejection tests
]);

// Files where fixed UUIDs are structurally legitimate (fixtures, setup).
const FILE_ALLOWLIST = [
  'test-helpers.ts',
  'setup.ts',
  'setup.integration.ts',
  'mail-helpers.ts',
  // Branded-type tests use const UUIDs to prove compile-time narrowing.
  path.join('unit', 'shared', 'branded-types.test.ts'),
];

function isAllowlistedFile(filePath: string): boolean {
  const rel = path.relative(TESTS_ROOT, filePath);
  return FILE_ALLOWLIST.some((suffix) => rel === suffix || rel.endsWith(path.sep + path.basename(suffix)));
}

// ---------------------------------------------------------------------------
// Per-line analysis
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  text: string;
  uuid: string;
}

function auditFile(filePath: string): Violation[] {
  if (isAllowlistedFile(filePath)) return [];

  const src = fs.readFileSync(filePath, 'utf8');
  const lines = src.split('\n');
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Skip pure comment lines.
    const trimmed = raw.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

    // Inline comment stripping: drop everything after `//` that isn't inside
    // a string literal (rough but sufficient for our patterns).
    const code = raw.replace(/\/\/.*$/, '');

    const uuids = [...code.matchAll(UUID_RE)].map((m) => m[0].toLowerCase());
    if (uuids.length === 0) continue;

    for (const uuid of uuids) {
      // Nil UUID is an explicit sentinel for "no session" / invalid-ID
      // rejection tests — always allowed.
      if (uuid === NIL_UUID) continue;

      // Known foreign-user sentinel UUIDs used in RLS rejection tests.
      // Their purpose IS to be a different user's ID, so they are valid
      // test inputs, not leaked auth state.
      if (FOREIGN_SENTINEL_UUIDS.has(uuid)) continue;

      // Only flag when a user-ownership field name appears on THE SAME LINE
      // as the UUID. This avoids false positives from multi-line object
      // literals where `user_id:` is on one line and the UUID is on the next
      // (e.g. livetrack session_id objects where the nearby `user_id` field
      // carries a non-UUID string like 'u1').
      if (USER_ID_FIELD_RE.test(code)) {
        violations.push({
          file: path.relative(TESTS_ROOT, filePath),
          line: i + 1,
          text: raw.trim(),
          uuid,
        });
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('test-isolation-audit', () => {
  const testFiles = collectTestFiles(TESTS_ROOT);

  it('finds at least one test file to scan', () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it('no test file uses a fixed user UUID outside of fixtures (use createTestUser instead)', () => {
    const allViolations: Violation[] = [];

    for (const file of testFiles) {
      allViolations.push(...auditFile(file));
    }

    if (allViolations.length > 0) {
      const report = allViolations
        .map(
          (v) =>
            `  ${v.file}:${v.line}\n` +
            `    UUID: ${v.uuid}\n` +
            `    Line: ${v.text}\n` +
            `    Fix: replace hard-coded user UUID with createTestUser() from test-helpers.ts`,
        )
        .join('\n\n');

      throw new Error(
        `Found ${allViolations.length} fixed user UUID(s) in test files.\n` +
          `Hard-coded user UUIDs cause cross-test contamination and break isolation.\n\n` +
          report,
      );
    }
  });
});
