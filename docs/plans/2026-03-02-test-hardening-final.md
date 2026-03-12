# Hub Test Hardening — Final Sweep

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan. Dispatch tasks in parallel where possible.

**Goal:** Fix every false positive, strengthen every weak test, and fill every coverage gap for the Hub module in one batch. No more audit cycles.

**Architecture:** 10 independent tasks grouped by test layer. All pgTAP tasks are independent. All unit/integration/E2E tasks are independent. Maximize parallelism.

**Tech Stack:** pgTAP (plpgsql), Vitest + React Testing Library (unit), Vitest + Supabase SDK (integration), Playwright (E2E)

**Worktree:** `.worktrees/test-hardening-final` on branch `fix/test-hardening-final`

**Test commands:**

- pgTAP: `cd /home/jeremy/luna-hub-lite && supabase test db`
- Unit: `cd /home/jeremy/luna-hub-lite/apps/web && pnpm exec vitest run`
- Integration: `cd /home/jeremy/luna-hub-lite/apps/web && pnpm exec vitest run --config vitest.integration.config.ts`
- E2E: Run from MAIN repo (worktree too slow): `cd /home/jeremy/luna-hub-lite/apps/web && pnpm exec playwright test`

**IMPORTANT — E2E testing:** The worktree's dev server is too slow for E2E. After editing E2E files in the worktree, copy them to main's `apps/web/e2e/hub/` to run Playwright, then verify results. Commit in the worktree.

---

## Task 1: pgTAP — user_tool_config RLS (NEW FILE)

**Files:**

- Create: `supabase/tests/hub/tool_config.test.sql`

**What to test:** The `hub.user_tool_config` table has SELECT/INSERT/UPDATE/DELETE RLS policies for own rows. Zero pgTAP coverage exists.

**Implementation:**

Create `supabase/tests/hub/tool_config.test.sql`:

```sql
BEGIN;
SELECT plan(8);

-- Setup: create two users
SELECT tests.create_supabase_user('tool_owner');
SELECT tests.create_supabase_user('tool_intruder');

-- Authenticate as tool_owner
SELECT tests.authenticate_as('tool_owner');

-- Test 1: User can INSERT own tool_config
SELECT lives_ok(
  $$ INSERT INTO hub.user_tool_config (user_id, tool_name, enabled)
     VALUES (tests.get_supabase_uid('tool_owner'), 'COACHBYTE_LOG_SET', true) $$,
  'User can insert own tool_config'
);

-- Test 2: User can SELECT own tool_config
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  1,
  'User can read own tool_config'
);

-- Test 3: User can UPDATE own tool_config
UPDATE hub.user_tool_config SET enabled = false WHERE tool_name = 'COACHBYTE_LOG_SET';
SELECT is(
  (SELECT enabled FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  false,
  'User can update own tool_config'
);

-- Test 4: User B cannot SELECT User A tool_config
SELECT tests.authenticate_as('tool_intruder');
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config),
  0,
  'User B cannot see User A tool_config'
);

-- Test 5: User B cannot INSERT with User A user_id
SELECT throws_ok(
  $$ INSERT INTO hub.user_tool_config (user_id, tool_name, enabled)
     VALUES (tests.get_supabase_uid('tool_owner'), 'CHEFBYTE_SCAN_BARCODE', true) $$,
  '42501',
  NULL,
  'User B cannot insert tool_config for User A'
);

-- Test 6: User B cannot UPDATE User A tool_config
SELECT tests.authenticate_as('tool_intruder');
UPDATE hub.user_tool_config SET enabled = true
  WHERE user_id = tests.get_supabase_uid('tool_owner');
SELECT tests.authenticate_as('tool_owner');
SELECT is(
  (SELECT enabled FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET'),
  false,
  'User B cannot update User A tool_config'
);

-- Test 7: User can DELETE own tool_config
SELECT tests.authenticate_as('tool_owner');
DELETE FROM hub.user_tool_config WHERE tool_name = 'COACHBYTE_LOG_SET';
SELECT is(
  (SELECT count(*)::integer FROM hub.user_tool_config
    WHERE user_id = tests.get_supabase_uid('tool_owner')),
  0,
  'User can delete own tool_config'
);

-- Test 8: Anon cannot access tool_config
SELECT tests.clear_authentication();
SELECT throws_ok(
  $$ SELECT * FROM hub.user_tool_config $$,
  '42501',
  NULL,
  'Anon cannot access tool_config'
);

-- Cleanup
SELECT tests.authenticate_as('tool_owner');
SELECT tests.delete_supabase_user('tool_owner');
SELECT tests.delete_supabase_user('tool_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
```

**Verify:** `supabase test db` — expect new file passes (8 tests), total pgTAP count increases.

**Commit:** `git add supabase/tests/hub/tool_config.test.sql && git commit -m "test(pgTAP): add user_tool_config RLS tests (8 tests)"`

---

## Task 2: pgTAP — extension_settings RLS (NEW FILE)

**Files:**

- Create: `supabase/tests/hub/extension_settings.test.sql`

**What to test:** The `hub.extension_settings` table has SELECT/INSERT/UPDATE/DELETE RLS policies. Zero pgTAP coverage exists.

**Implementation:**

Create `supabase/tests/hub/extension_settings.test.sql`:

```sql
BEGIN;
SELECT plan(8);

-- Setup
SELECT tests.create_supabase_user('ext_owner');
SELECT tests.create_supabase_user('ext_intruder');

-- Authenticate as ext_owner
SELECT tests.authenticate_as('ext_owner');

-- Test 1: User can INSERT own extension_settings
SELECT lives_ok(
  $$ INSERT INTO hub.extension_settings (user_id, extension_name, enabled, credentials_encrypted)
     VALUES (tests.get_supabase_uid('ext_owner'), 'obsidian', true, '{"vault_path":"/notes"}') $$,
  'User can insert own extension_settings'
);

-- Test 2: User can SELECT own extension_settings
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  1,
  'User can read own extension_settings'
);

-- Test 3: User can UPDATE own extension_settings
UPDATE hub.extension_settings SET enabled = false WHERE extension_name = 'obsidian';
SELECT is(
  (SELECT enabled FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  false,
  'User can update own extension_settings'
);

-- Test 4: User B cannot SELECT User A extension_settings
SELECT tests.authenticate_as('ext_intruder');
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings),
  0,
  'User B cannot see User A extension_settings'
);

-- Test 5: User B cannot INSERT with User A user_id
SELECT throws_ok(
  $$ INSERT INTO hub.extension_settings (user_id, extension_name, enabled)
     VALUES (tests.get_supabase_uid('ext_owner'), 'todoist', true) $$,
  '42501',
  NULL,
  'User B cannot insert extension_settings for User A'
);

-- Test 6: User B cannot UPDATE User A extension_settings
SELECT tests.authenticate_as('ext_intruder');
UPDATE hub.extension_settings SET enabled = true
  WHERE user_id = tests.get_supabase_uid('ext_owner');
SELECT tests.authenticate_as('ext_owner');
SELECT is(
  (SELECT enabled FROM hub.extension_settings WHERE extension_name = 'obsidian'),
  false,
  'User B cannot update User A extension_settings'
);

-- Test 7: User can DELETE own extension_settings
SELECT tests.authenticate_as('ext_owner');
DELETE FROM hub.extension_settings WHERE extension_name = 'obsidian';
SELECT is(
  (SELECT count(*)::integer FROM hub.extension_settings
    WHERE user_id = tests.get_supabase_uid('ext_owner')),
  0,
  'User can delete own extension_settings'
);

-- Test 8: Anon cannot access extension_settings
SELECT tests.clear_authentication();
SELECT throws_ok(
  $$ SELECT * FROM hub.extension_settings $$,
  '42501',
  NULL,
  'Anon cannot access extension_settings'
);

-- Cleanup
SELECT tests.authenticate_as('ext_owner');
SELECT tests.delete_supabase_user('ext_owner');
SELECT tests.delete_supabase_user('ext_intruder');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
```

**Verify:** `supabase test db`

**Commit:** `git add supabase/tests/hub/extension_settings.test.sql && git commit -m "test(pgTAP): add extension_settings RLS tests (8 tests)"`

---

## Task 3: pgTAP — get_logical_date + fix existing weak tests

**Files:**

- Create: `supabase/tests/hub/logical_date.test.sql`
- Modify: `supabase/tests/hub/api_keys.test.sql` (test 11: change `> 0` to exact count)
- Modify: `supabase/tests/hub/activation.test.sql` (test 3: add data assertion after lives_ok)

**Part A — get_logical_date tests:**

Create `supabase/tests/hub/logical_date.test.sql`:

```sql
BEGIN;
SELECT plan(5);

-- Test 1: Standard case — 2pm Eastern → same date
SELECT is(
  private.get_logical_date(
    '2026-03-02 14:00:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-02'::date,
  'Afternoon Eastern time returns same date'
);

-- Test 2: Before day boundary — 5:59am with day_start=6 → previous date
SELECT is(
  private.get_logical_date(
    '2026-03-02 05:59:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-01'::date,
  '5:59am with day_start=6 returns previous date'
);

-- Test 3: At day boundary — 6:00am with day_start=6 → current date
SELECT is(
  private.get_logical_date(
    '2026-03-02 06:00:00-05'::timestamptz,
    'America/New_York',
    6
  ),
  '2026-03-02'::date,
  '6:00am with day_start=6 returns current date'
);

-- Test 4: Midnight boundary — day_start=0 behaves as standard date
SELECT is(
  private.get_logical_date(
    '2026-03-02 23:59:00-05'::timestamptz,
    'America/New_York',
    0
  ),
  '2026-03-02'::date,
  'day_start=0 at 11:59pm returns same date'
);

-- Test 5: Different timezone — same UTC instant, different local date
SELECT is(
  private.get_logical_date(
    '2026-03-02 02:00:00+00'::timestamptz,
    'Asia/Tokyo',
    6
  ),
  '2026-03-02'::date,
  'UTC 2am = Tokyo 11am, with day_start=6 returns Mar 2'
);

SELECT * FROM finish();
ROLLBACK;
```

**Part B — Fix api_keys test 11:**

In `supabase/tests/hub/api_keys.test.sql`, find the test that uses `ok(count(*)::integer > 0, ...)` and change it to use the exact expected count. After test 10 deletes `hash_jkl012`, User A should have 3 keys total: `hash_abc123` (revoked), `hash_def456` (revoked), `hash_ghi789` (active). So the cross-user DELETE check should verify count = 3:

Change:

```sql
SELECT ok(
  (SELECT count(*)::integer FROM hub.api_keys WHERE user_id = tests.get_supabase_uid('key_owner')) > 0,
```

To:

```sql
SELECT is(
  (SELECT count(*)::integer FROM hub.api_keys WHERE user_id = tests.get_supabase_uid('key_owner')),
  3,
```

Also update the test description to match.

**Part C — Fix activation test 3:**

In `supabase/tests/hub/activation.test.sql`, after the `lives_ok` for deactivating an unactivated app, add a data assertion:

After the `lives_ok(...)` line, add:

```sql
-- Verify table is still empty for this user (no side effects)
SELECT is(
  (SELECT count(*)::integer FROM hub.app_activations
    WHERE user_id = tests.get_supabase_uid('activation_owner')),
  0,
  'Deactivate unactivated app has no side effects'
);
```

Update the `SELECT plan(7)` to `SELECT plan(8)` to account for the new assertion.

**Verify:** `supabase test db`

**Commit:** `git add supabase/tests/ && git commit -m "test(pgTAP): add get_logical_date tests, fix weak assertions in api_keys and activation"`

---

## Task 4: Integration — RLS isolation + fix readbacks + fix weak tests

**Files:**

- Modify: `apps/web/src/__tests__/integration/hub/profile-crud.test.ts`
- Modify: `apps/web/src/__tests__/integration/hub/api-key-lifecycle.test.ts`
- Modify: `apps/web/src/__tests__/integration/hub/app-activation.test.ts`
- Modify: `apps/web/src/__tests__/integration/hub/auth-lifecycle.test.ts`

**Part A — Add RLS isolation tests:**

**profile-crud.test.ts** — Add at the end of the describe block:

```typescript
it('RLS: user B cannot read user A profile', async () => {
  const { userId: userAId, client: clientA } = await createTestUser('prof-rls-a');
  userIds.push(userAId);
  const { userId: userBId, client: clientB } = await createTestUser('prof-rls-b');
  userIds.push(userBId);

  // User A has a profile (created by trigger)
  const { data: ownProfile, error: ownError } = await clientA
    .schema('hub')
    .from('profiles')
    .select('user_id')
    .eq('user_id', userAId)
    .single();
  expect(ownError).toBeNull();
  expect(ownProfile).not.toBeNull();

  // User B cannot see User A's profile
  const { data, error } = await clientB.schema('hub').from('profiles').select('user_id').eq('user_id', userAId);
  expect(error).toBeNull();
  expect(data).toHaveLength(0);
});

it('RLS: user B cannot update user A profile', async () => {
  const { userId: userAId, client: clientA } = await createTestUser('prof-rls-upd-a');
  userIds.push(userAId);
  const { userId: userBId, client: clientB } = await createTestUser('prof-rls-upd-b');
  userIds.push(userBId);

  // User B tries to update User A's profile
  await clientB.schema('hub').from('profiles').update({ display_name: 'HACKED' }).eq('user_id', userAId);

  // Verify User A's profile is unchanged
  const { data, error } = await clientA
    .schema('hub')
    .from('profiles')
    .select('display_name')
    .eq('user_id', userAId)
    .single();
  expect(error).toBeNull();
  expect(data!.display_name).not.toBe('HACKED');
});
```

**api-key-lifecycle.test.ts** — Add at the end of the describe block:

```typescript
it('RLS: user B cannot read user A api keys', async () => {
  const { userId: userAId, client: clientA } = await createTestUser('key-rls-a');
  userIds.push(userAId);
  const { userId: userBId, client: clientB } = await createTestUser('key-rls-b');
  userIds.push(userBId);

  // User A inserts a key
  const { error: insertError } = await clientA
    .schema('hub')
    .from('api_keys')
    .insert({ user_id: userAId, api_key_hash: 'hash_rls_test', label: 'RLS test' });
  expect(insertError).toBeNull();

  // User B queries — should see nothing
  const { data, error } = await clientB.schema('hub').from('api_keys').select('*').eq('user_id', userAId);
  expect(error).toBeNull();
  expect(data).toHaveLength(0);
});

it('RLS: user B cannot revoke user A api keys', async () => {
  const { userId: userAId, client: clientA } = await createTestUser('key-rls-rev-a');
  userIds.push(userAId);
  const { userId: userBId, client: clientB } = await createTestUser('key-rls-rev-b');
  userIds.push(userBId);

  // User A inserts a key
  const { error: insertError } = await clientA
    .schema('hub')
    .from('api_keys')
    .insert({ user_id: userAId, api_key_hash: 'hash_rls_revoke', label: 'Revoke test' });
  expect(insertError).toBeNull();

  // User B tries to revoke it
  await clientB.schema('hub').from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('user_id', userAId);

  // Verify key is still active
  const { data, error } = await clientA
    .schema('hub')
    .from('api_keys')
    .select('revoked_at')
    .eq('api_key_hash', 'hash_rls_revoke')
    .single();
  expect(error).toBeNull();
  expect(data!.revoked_at).toBeNull();
});
```

**Part B — Fix app-activation readbacks:**

In `app-activation.test.ts`, change all readback queries from `adminClient` to the user's own `client`. This tests that the SELECT RLS policy works.

Find all instances of:

```typescript
const { data } = await adminClient.schema('hub').from('app_activations');
```

Replace with:

```typescript
const { data, error: readError } = await client.schema('hub').from('app_activations');
```

And add `expect(readError).toBeNull();` after each.

Also add a cross-user test:

```typescript
it('RLS: user B cannot see user A activations', async () => {
  const { userId: userAId, client: clientA } = await createTestUser('act-rls-a');
  userIds.push(userAId);
  const { userId: userBId, client: clientB } = await createTestUser('act-rls-b');
  userIds.push(userBId);

  // User A activates coachbyte
  const { error: activateError } = await clientA.schema('hub').rpc('activate_app', { p_app_name: 'coachbyte' });
  expect(activateError).toBeNull();

  // User B queries — should see nothing
  const { data, error } = await clientB.schema('hub').from('app_activations').select('*');
  expect(error).toBeNull();
  expect(data).toHaveLength(0);
});
```

**Part C — Fix auth-lifecycle weak tests:**

In `auth-lifecycle.test.ts`:

1. In the logout test, add error check on the signIn call:

```typescript
const { error: signInError } = await client.auth.signInWithPassword({ email, password });
expect(signInError).toBeNull();
```

2. In the duplicate signup test, capture the second signUp return value:

```typescript
const { error: dupError } = await client2.auth.signUp({ ... });
// Supabase may return success (anti-enumeration) or error — either is acceptable
// The important thing is only 1 user exists
```

**Verify:** `cd /home/jeremy/luna-hub-lite/apps/web && pnpm exec vitest run --config vitest.integration.config.ts`

**Commit:** `git add apps/web/src/__tests__/integration/ && git commit -m "test(integration): add RLS isolation tests, fix readbacks to use user client, fix weak assertions"`

---

## Task 5: Unit — Fix weak tests + add missing coverage

**Files:**

- Modify: `apps/web/src/__tests__/unit/hub/ApiKeyGenerator.test.tsx`
- Modify: `apps/web/src/__tests__/unit/hub/ExtensionCard.test.tsx`
- Modify: `apps/web/src/__tests__/unit/hub/SignupForm.test.tsx`
- Modify: `apps/web/src/__tests__/unit/hub/AppActivationCard.test.tsx`
- Modify: `apps/web/src/__tests__/unit/hub/ToolToggle.test.tsx`

Read each file first. Then add the following tests.

**ApiKeyGenerator.test.tsx** — Add these tests:

```tsx
it('passes label to onGenerate', async () => {
  const onGenerate = vi.fn().mockResolvedValue('sk-labeled-key');
  render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

  const labelInput = screen.getByLabelText(/key label/i);
  await userEvent.type(labelInput, 'Production Key');
  await userEvent.click(screen.getByRole('button', { name: /generate/i }));

  await waitFor(() => {
    expect(onGenerate).toHaveBeenCalledWith('Production Key');
  });
});

it('renders active keys list with labels and revoke buttons', () => {
  const activeKeys = [
    { id: 'key-1', label: 'Dev Key', created_at: '2026-01-15T00:00:00Z' },
    { id: 'key-2', label: null, created_at: '2026-02-20T00:00:00Z' },
  ];
  render(<ApiKeyGenerator {...defaultProps} activeKeys={activeKeys} />);

  expect(screen.getByText('Dev Key')).toBeInTheDocument();
  expect(screen.getByText('Untitled')).toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /revoke/i })).toHaveLength(2);
});

it('onRevoke called with correct key id', async () => {
  const onRevoke = vi.fn();
  const activeKeys = [{ id: 'key-abc', label: 'Test Key', created_at: '2026-01-15T00:00:00Z' }];
  render(<ApiKeyGenerator {...defaultProps} activeKeys={activeKeys} onRevoke={onRevoke} />);

  await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
  expect(onRevoke).toHaveBeenCalledWith('key-abc');
});

it('shows empty state when no active keys', () => {
  render(<ApiKeyGenerator {...defaultProps} activeKeys={[]} />);
  expect(screen.getByText(/no active api keys/i)).toBeInTheDocument();
});

it('disables generate button when loading', () => {
  render(<ApiKeyGenerator {...defaultProps} loading={true} />);
  expect(screen.getByRole('button', { name: /generate/i })).toBeDisabled();
});

it('handles onGenerate returning null', async () => {
  const onGenerate = vi.fn().mockResolvedValue(null);
  render(<ApiKeyGenerator {...defaultProps} onGenerate={onGenerate} />);

  await userEvent.click(screen.getByRole('button', { name: /generate/i }));

  await waitFor(() => {
    expect(onGenerate).toHaveBeenCalled();
  });
  // Key display should not appear when null returned
  expect(screen.queryByTestId('key-plaintext')).not.toBeInTheDocument();
});
```

Also fix the clipboard test (test 3) — use vi.spyOn pattern instead of Object.assign:

```tsx
// Before the test:
const writeText = vi.fn().mockResolvedValue(undefined);
const originalClipboard = navigator.clipboard;
Object.defineProperty(navigator, 'clipboard', {
  value: { writeText },
  writable: true,
  configurable: true,
});
// After the test (in afterEach or end of test):
Object.defineProperty(navigator, 'clipboard', {
  value: originalClipboard,
  writable: true,
  configurable: true,
});
```

**ExtensionCard.test.tsx** — Add:

```tsx
it('shows credentials configured text when hasCredentials is true', () => {
  render(<ExtensionCard {...defaultProps} enabled hasCredentials />);
  expect(screen.getByText(/credentials configured/i)).toBeInTheDocument();
});

it('shows error from onSaveCredentials', async () => {
  const onSave = vi.fn().mockResolvedValue({ error: 'Network error' });
  render(<ExtensionCard {...defaultProps} enabled onSaveCredentials={onSave} />);

  const input = screen.getByLabelText(/vault path/i);
  await userEvent.type(input, '/path');
  await userEvent.click(screen.getByRole('button', { name: /save credentials/i }));

  await waitFor(() => {
    expect(screen.getByText(/network error/i)).toBeInTheDocument();
  });
});

it('toggle from enabled to disabled calls onToggle(false)', async () => {
  const onToggle = vi.fn();
  render(<ExtensionCard {...defaultProps} enabled onToggle={onToggle} />);

  await userEvent.click(screen.getByRole('checkbox'));
  expect(onToggle).toHaveBeenCalledWith(false);
});
```

**SignupForm.test.tsx** — Add:

```tsx
it('disables submit button while request in flight', async () => {
  const neverResolve = new Promise(() => {});
  mockSignUp.mockReturnValue(neverResolve);
  render(component);

  await userEvent.type(screen.getByLabelText(/display name/i), 'Test');
  await userEvent.type(screen.getByLabelText(/email/i), 'test@test.com');
  await userEvent.type(screen.getByLabelText(/password/i), 'password123');
  await userEvent.click(screen.getByRole('button', { name: /sign up/i }));

  expect(screen.getByRole('button', { name: /creating account/i })).toBeDisabled();
});
```

Also delete the redundant test 5 (`passes display_name as user metadata`) since it's identical to test 4.

**AppActivationCard.test.tsx** — Add:

```tsx
it('buttons are disabled when loading', () => {
  const { rerender } = render(<AppActivationCard {...defaultProps} loading />);
  expect(screen.getByRole('button', { name: /activate/i })).toBeDisabled();

  rerender(<AppActivationCard {...defaultProps} active loading />);
  expect(screen.getByRole('button', { name: /deactivate/i })).toBeDisabled();
});
```

**ToolToggle.test.tsx** — Add:

```tsx
it('toggling enabled tool off calls onToggle with false', async () => {
  render(<ToolToggle {...defaultProps} />);
  const checkboxes = screen.getAllByRole('checkbox');
  // First tool (COACHBYTE_LOG_SET) is enabled — toggle it off
  await userEvent.click(checkboxes[0]);
  expect(defaultProps.onToggle).toHaveBeenCalledWith('COACHBYTE_LOG_SET', false);
});
```

**Verify:** `cd /home/jeremy/luna-hub-lite/apps/web && pnpm exec vitest run`

**Commit:** `git add apps/web/src/__tests__/ && git commit -m "test(unit): add missing coverage for ApiKeyGenerator, ExtensionCard, SignupForm, AppActivationCard, ToolToggle"`

---

## Task 6: E2E — Fix all URL-only assertions in auth.spec.ts

**Files:**

- Modify: `apps/web/e2e/hub/auth.spec.ts`

Read the file first. Then make these changes:

**Test 1** (`visit / redirects to /login`) — Add content check:

```typescript
await expect(page).toHaveURL(/\/login/);
await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
```

**Test 3** (`login with invalid password`) — Already has content assertion (`/invalid.*credentials/i`). Add session verification:

```typescript
await expect(page.getByText(/invalid.*credentials/i)).toBeVisible();
await expect(page).toHaveURL(/\/login/);
// Verify no session was created — attempt to visit hub should redirect back
await page.goto('/hub');
await expect(page).toHaveURL(/\/login/);
```

**Test 4** (`signup with valid inputs`) — Add hub content check:

```typescript
await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });
await expect(page.getByRole('button', { name: /logout/i })).toBeVisible();
```

**Test 5** (`signup with duplicate email`) — Fix false-positive risk. Replace the `waitForURL` + `listUsers` pattern with a proper assertion. Since Supabase local dev silently succeeds (redirects to /hub), we can only check the user count:

```typescript
await page.getByRole('button', { name: /sign up/i }).click();
// Supabase local dev may redirect to /hub (anti-enumeration) or stay on /signup
// Wait for either outcome
await page.waitForURL(/\/(hub|signup)/, { timeout: 5000 });
// The key assertion: only 1 user with this email exists in the DB
const { data } = await admin.auth.admin.listUsers();
const matches = data.users.filter((u) => u.email === email);
expect(matches.length).toBe(1);
```

(Keep as-is — the current implementation is the best we can do given Supabase's anti-enumeration behavior. Add a comment explaining why.)

**Test 6** (`logout redirects to /login`) — Add content check:

```typescript
await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
```

**Test 8** (`visit /coach without login`) — Add content check:

```typescript
await expect(page).toHaveURL(/\/login/);
await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
```

**Test 9** (`visit /chef without login`) — Add content check:

```typescript
await expect(page).toHaveURL(/\/login/);
await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
```

**Verify:** Copy modified file to main, run `pnpm exec playwright test e2e/hub/auth.spec.ts`

**Commit:** `git add apps/web/e2e/hub/auth.spec.ts && git commit -m "test(e2e): add content assertions to all URL-only auth tests"`

---

## Task 7: E2E — Fix navigation weak tests

**Files:**

- Modify: `apps/web/e2e/hub/navigation.spec.ts`

Read the file first. Then make these changes:

**Test 4** (`click Tools in side nav`) — Replace `ion-toggle` with page-specific selector:

```typescript
await expect(page).toHaveURL(/\/hub\/tools/);
await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible();
```

(Tool names only appear on the Tools page, not Extensions.)

**Test 7** (`active page highlighted`) — Add count assertion:

```typescript
const nav = page.getByLabel('Hub navigation');
// Verify exactly one item is highlighted
await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
const accountItem = nav.locator('[aria-current="page"]');
await expect(accountItem).toContainText('Account');

// Navigate to Apps and verify highlight changes
await nav.getByText('Apps').click();
await expect(page).toHaveURL(/\/hub\/apps/);
await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
const appsItem = nav.locator('[aria-current="page"]');
await expect(appsItem).toContainText('Apps');
```

**Test 8** (`module switcher: CoachByte`) — CoachByte and ChefByte pages don't exist yet (Phase 5+), so we can't add content assertions. Add a comment documenting this:

```typescript
// Note: CoachByte page not yet built (Phase 5). URL assertion is sufficient until then.
await expect(page).toHaveURL(/\/coach/, { timeout: 5000 });
```

**Test 9** (`module switcher: ChefByte`) — Same treatment:

```typescript
// Note: ChefByte page not yet built (Phase 7). URL assertion is sufficient until then.
await expect(page).toHaveURL(/\/chef/, { timeout: 5000 });
```

**Verify:** Copy modified file to main, run `pnpm exec playwright test e2e/hub/navigation.spec.ts`

**Commit:** `git add apps/web/e2e/hub/navigation.spec.ts && git commit -m "test(e2e): fix navigation tests — page-specific selectors, highlight count assertion"`

---

## Task 8: E2E — New tools.spec.ts

**Files:**

- Create: `apps/web/e2e/hub/tools.spec.ts`

**Implementation:**

```typescript
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-tools-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Tools page', () => {
  test('shows all 10 tool toggles', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'list');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });
      await expect(page.locator('ion-toggle')).toHaveCount(10);
    } finally {
      await cleanup();
    }
  });

  test('toggle tool off and verify state change', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'toggle');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });

      // All tools start enabled — find the first toggle and click it off
      const firstToggle = page.locator('ion-toggle').first();
      await firstToggle.click();

      // Verify the toggle state changed (checked attribute removed)
      await expect(firstToggle).not.toBeChecked();
    } finally {
      await cleanup();
    }
  });

  test('tool toggle persists after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/tools');
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 5000 });

      // Toggle first tool off
      const firstToggle = page.locator('ion-toggle').first();
      await firstToggle.click();
      await expect(firstToggle).not.toBeChecked();

      // Reload and verify state persisted
      await page.reload();
      await expect(page.getByText('COACHBYTE_LOG_SET')).toBeVisible({ timeout: 15000 });
      await expect(page.locator('ion-toggle').first()).not.toBeChecked();
    } finally {
      await cleanup();
    }
  });
});
```

**Verify:** Copy to main, run `pnpm exec playwright test e2e/hub/tools.spec.ts`

**Commit:** `git add apps/web/e2e/hub/tools.spec.ts && git commit -m "test(e2e): add tools page tests (toggle, persistence, all 10 tools)"`

---

## Task 9: E2E — New extensions.spec.ts

**Files:**

- Create: `apps/web/e2e/hub/extensions.spec.ts`

**Implementation:**

```typescript
import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function seedAndLogin(page: import('@playwright/test').Page, suffix: string) {
  const email = `e2e-ext-${suffix}-${Date.now()}@test.com`;
  const password = 'testpass123';
  const { data } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = data.user!.id;

  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/hub/, { timeout: 5000 });

  return { userId, cleanup: () => admin.auth.admin.deleteUser(userId) };
}

test.describe('Extensions page', () => {
  test('shows all three extension cards', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'cards');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Home Assistant' })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('enable extension toggle shows credential form', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'enable');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      // Find the Obsidian card and toggle it on
      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();

      // Credential form should appear
      await expect(obsidianCard.getByText(/vault path/i)).toBeVisible();
      await expect(obsidianCard.getByRole('button', { name: /save credentials/i })).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('save credentials shows success message', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'save');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Todoist' })).toBeVisible({ timeout: 5000 });

      // Enable Todoist
      const todoistCard = page.locator('ion-card', { hasText: 'Todoist' });
      await todoistCard.locator('ion-toggle').click();

      // Fill API token and save
      await todoistCard.getByLabel(/api token/i).fill('test-token-123');
      await todoistCard.getByRole('button', { name: /save credentials/i }).click();

      // Verify success
      await expect(todoistCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });
    } finally {
      await cleanup();
    }
  });

  test('credentials persist after reload', async ({ page }) => {
    const { cleanup } = await seedAndLogin(page, 'persist');
    try {
      await page.goto('/hub/extensions');
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 5000 });

      // Enable Obsidian and save credentials
      const obsidianCard = page.locator('ion-card', { hasText: 'Obsidian' });
      await obsidianCard.locator('ion-toggle').click();
      await obsidianCard.getByLabel(/vault path/i).fill('/my/vault');
      await obsidianCard.getByRole('button', { name: /save credentials/i }).click();
      await expect(obsidianCard.getByText(/credentials saved/i)).toBeVisible({ timeout: 5000 });

      // Reload and verify
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Obsidian' })).toBeVisible({ timeout: 15000 });
      await expect(
        page.locator('ion-card', { hasText: 'Obsidian' }).getByText(/credentials configured/i),
      ).toBeVisible();
    } finally {
      await cleanup();
    }
  });
});
```

**Verify:** Copy to main, run `pnpm exec playwright test e2e/hub/extensions.spec.ts`

**Commit:** `git add apps/web/e2e/hub/extensions.spec.ts && git commit -m "test(e2e): add extensions page tests (cards, toggle, credentials, persistence)"`

---

## Task 10: E2E — App activation confirm/cancel + persistence

**Files:**

- Modify: `apps/web/e2e/hub/app-activation.spec.ts`

Read the file first. Add these tests to the existing describe block:

```typescript
test('confirm deactivation returns to Inactive', async ({ page }) => {
  const { cleanup } = await seedAndLogin(page, 'deact-confirm');
  try {
    await page.goto('/hub/apps');
    const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

    // Activate
    await coachCard.getByRole('button', { name: /activate/i }).click();
    await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

    // Deactivate — click confirm in the alert
    await coachCard.getByRole('button', { name: /deactivate/i }).click();
    await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /confirm/i }).click();

    // Should be back to Inactive
    await expect(coachCard.getByText('Inactive', { exact: true })).toBeVisible({ timeout: 5000 });
  } finally {
    await cleanup();
  }
});

test('cancel deactivation keeps app Active', async ({ page }) => {
  const { cleanup } = await seedAndLogin(page, 'deact-cancel');
  try {
    await page.goto('/hub/apps');
    const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

    // Activate
    await coachCard.getByRole('button', { name: /activate/i }).click();
    await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

    // Deactivate — click cancel in the alert
    await coachCard.getByRole('button', { name: /deactivate/i }).click();
    await expect(page.getByText('Are you sure you want to deactivate CoachByte?')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: /cancel/i }).click();

    // Should still be Active
    await expect(coachCard.getByText('Active', { exact: true })).toBeVisible();
  } finally {
    await cleanup();
  }
});

test('activation persists after page reload', async ({ page }) => {
  const { cleanup } = await seedAndLogin(page, 'persist');
  try {
    await page.goto('/hub/apps');
    const coachCard = page.locator('ion-card', { hasText: 'CoachByte' });

    // Activate CoachByte
    await coachCard.getByRole('button', { name: /activate/i }).click();
    await expect(coachCard.getByText('Active', { exact: true })).toBeVisible({ timeout: 5000 });

    // Reload
    await page.reload();
    await expect(page.locator('ion-card', { hasText: 'CoachByte' }).getByText('Active', { exact: true })).toBeVisible({
      timeout: 15000,
    });

    // ChefByte should still be Inactive
    await expect(
      page.locator('ion-card', { hasText: 'ChefByte' }).getByText('Inactive', { exact: true }),
    ).toBeVisible();
  } finally {
    await cleanup();
  }
});
```

**Verify:** Copy to main, run `pnpm exec playwright test e2e/hub/app-activation.spec.ts`

**Commit:** `git add apps/web/e2e/hub/app-activation.spec.ts && git commit -m "test(e2e): add deactivation confirm/cancel and activation persistence tests"`

---

## Verification

After all 10 tasks complete, run the full suite:

1. `supabase test db` — expect ~50+ pgTAP tests (was 27)
2. `cd apps/web && pnpm exec vitest run` — expect ~55+ unit tests (was 40)
3. `cd apps/web && pnpm exec vitest run --config vitest.integration.config.ts` — expect ~46+ integration (was 39)
4. `cd apps/web && pnpm exec playwright test` — expect ~44+ E2E (was 31)
5. Total: ~195+ tests (was 137)

All must pass with 0 failures.
