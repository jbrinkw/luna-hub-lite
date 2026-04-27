import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { seedFullAndLogin, seedChefByteData } from '../helpers/seed';
import { SUPABASE_URL, ANON_KEY } from '../helpers/constants';

/**
 * End-to-end coverage for the ChefByte Settings → Backup tab.
 *
 * Each test drives real UI + real Supabase RPCs (no stubs):
 *   - Navigate to /chef/settings?tab=backup
 *   - Download → assert a download event fires with the expected filename
 *   - File upload → parse preview + enable Restore via consent checkbox
 *   - Restore → assert the RPC ran by checking DB state post-operation
 */

test.describe('ChefByte Backup & Restore', () => {
  test('renders backup tab with export + restore sections', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'backup-render');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings?tab=backup');

      // Tab content loaded (not the products tab fallback).
      const backupTab = page.getByTestId('backup-tab');
      await expect(backupTab).toBeVisible();

      // Export + restore sections both present.
      await expect(page.getByTestId('export-section')).toBeVisible();
      await expect(page.getByTestId('restore-section')).toBeVisible();
      await expect(page.getByTestId('download-backup-btn')).toBeVisible();
      await expect(page.getByTestId('restore-file-input')).toBeVisible();
    } finally {
      await cleanup();
    }
  });

  test('download backup triggers a json download with expected filename', async ({ page }) => {
    const { userId, cleanup, client } = await seedFullAndLogin(page, 'backup-download');
    try {
      await seedChefByteData(client, userId);
      await page.goto('/chef/settings?tab=backup');

      await page.getByTestId('backup-tab').waitFor({ state: 'visible' });

      // Listen for the download that our click triggers.
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('download-backup-btn').click(),
      ]);

      const filename = download.suggestedFilename();
      expect(filename).toMatch(/^luna-hub-chefbyte-backup-\d{4}-\d{2}-\d{2}\.json$/);

      // Read the downloaded file's bytes and confirm it's a valid backup envelope.
      const stream = await download.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      expect(payload.schema_version).toBe('20260423010000');
      expect(payload.user_id).toBe(userId);
      expect(Array.isArray(payload.tables.products)).toBe(true);
      expect(payload.tables.products.length).toBeGreaterThanOrEqual(5);
    } finally {
      await cleanup();
    }
  });

  test('restore flow: upload → preview → consent → restore wipes-and-replaces', async ({ page }) => {
    const { userId, cleanup, client, email, password } = await seedFullAndLogin(page, 'backup-restore-flow');
    try {
      await seedChefByteData(client, userId);

      // Build a snapshot via the RPC directly (server-side is the source of truth;
      // using the UI download in the same test would require chaining two downloads).
      const { data: snapshot, error: snapErr } = await (client as any).schema('chefbyte').rpc('export_chefbyte_backup');
      expect(snapErr).toBeNull();
      expect(snapshot).toBeTruthy();

      // Mutate the server state AFTER taking the snapshot: add a new product
      // that should be wiped by the upcoming restore.
      const { error: addErr } = await (client as any).schema('chefbyte').from('products').insert({
        user_id: userId,
        name: 'Should Be Wiped',
        calories_per_serving: 1,
        carbs_per_serving: 0,
        protein_per_serving: 0,
        fat_per_serving: 0,
      });
      expect(addErr).toBeNull();

      // Navigate to Backup tab.
      await page.goto('/chef/settings?tab=backup');
      await page.getByTestId('backup-tab').waitFor({ state: 'visible' });

      // Upload the snapshot JSON via the file picker. Use setInputFiles with an
      // in-memory buffer so no tmp file is needed.
      const snapshotBytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
      await page.getByTestId('restore-file-input').setInputFiles({
        name: 'restore.json',
        mimeType: 'application/json',
        buffer: snapshotBytes,
      });

      // Preview appears with schema_version + per-table counts.
      const preview = page.getByTestId('restore-preview');
      await expect(preview).toBeVisible();
      await expect(page.getByTestId('preview-schema-version')).toHaveText('20260423010000');

      // Products preview count should match the seeded 5.
      await expect(page.getByTestId('preview-count-products')).toHaveText('5');

      // Restore button starts disabled (no consent yet).
      const restoreBtn = page.getByTestId('restore-confirm-btn');
      await expect(restoreBtn).toBeDisabled();

      // Tick consent → button enables.
      await page.getByTestId('restore-consent').check();
      await expect(restoreBtn).toBeEnabled();

      // Fire restore.
      await restoreBtn.click();

      // Success panel appears with per-table wiped/restored counts.
      await expect(page.getByTestId('restore-success')).toBeVisible({ timeout: 10_000 });

      // DB-state assertion: the 'Should Be Wiped' product is gone, and the
      // 5 originally-seeded products are present again.
      // Use a fresh client to bypass any stale cache.
      const fresh = createClient(SUPABASE_URL, ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { error: signInErr } = await fresh.auth.signInWithPassword({ email, password });
      expect(signInErr).toBeNull();
      const { data: finalProducts, error: finalErr } = await (fresh as any)
        .schema('chefbyte')
        .from('products')
        .select('product_id, name')
        .eq('user_id', userId);
      expect(finalErr).toBeNull();
      expect(finalProducts.length).toBe(5);
      expect(finalProducts.find((p: any) => p.name === 'Should Be Wiped')).toBeFalsy();
    } finally {
      await cleanup();
    }
  });
});
