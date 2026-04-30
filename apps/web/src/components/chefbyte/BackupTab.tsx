import { useState, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/shared/auth/AuthProvider';
import { chefbyte } from '@/shared/supabase';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Shape the RPC returns + expects. Keep in sync with the migration. */
interface BackupPayload {
  schema_version: string;
  generated_at: string;
  user_id: string;
  tables: {
    locations?: unknown[];
    products?: unknown[];
    stock_lots?: unknown[];
    recipes?: unknown[];
    recipe_ingredients?: unknown[];
    meal_plan_entries?: unknown[];
    food_logs?: unknown[];
    temp_items?: unknown[];
    shopping_list?: unknown[];
    user_config?: unknown[];
  };
}

interface RestoreResult {
  schema_version: string;
  user_id: string;
  wiped: Record<string, number>;
  restored: Record<string, number>;
}

/* ------------------------------------------------------------------ */
/*  Reusable Tailwind class strings (match other tabs)                 */
/* ------------------------------------------------------------------ */

const cardCls = 'border border-border rounded-lg p-5 mb-4 bg-surface';
const sectionHeaderCls = 'text-base font-bold text-text mb-2';
const descCls = 'text-sm text-text-secondary mb-4';
const primaryBtnCls =
  'bg-emerald-600 text-white border-none px-4 py-2.5 rounded-md cursor-pointer font-semibold text-sm hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed';
const dangerBtnCls =
  'bg-red-600 text-white border-none px-4 py-2.5 rounded-md cursor-pointer font-semibold text-sm hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed';
const fileInputCls =
  'block w-full text-sm text-text file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:font-semibold file:bg-surface-hover file:text-text hover:file:bg-surface-sunken cursor-pointer';

/* ------------------------------------------------------------------ */
/*  Table keys included in backup — must match migration's v_insert_order */
/* ------------------------------------------------------------------ */

const BACKUP_TABLES = [
  'locations',
  'products',
  'stock_lots',
  'recipes',
  'recipe_ingredients',
  'meal_plan_entries',
  'food_logs',
  'temp_items',
  'shopping_list',
  'user_config',
] as const;

/** Short human label for the preview + restore summary. */
const TABLE_LABEL: Record<(typeof BACKUP_TABLES)[number], string> = {
  locations: 'Locations',
  products: 'Products',
  stock_lots: 'Stock lots',
  recipes: 'Recipes',
  recipe_ingredients: 'Recipe ingredients',
  meal_plan_entries: 'Meal plan entries',
  food_logs: 'Food logs',
  temp_items: 'Quick-add items',
  shopping_list: 'Shopping list',
  user_config: 'User config',
};

/* ================================================================== */
/*  Component                                                          */
/* ================================================================== */

export function BackupTab() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  /* -- restore state (file + parsed payload + consent) -- */
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsedBackup, setParsedBackup] = useState<BackupPayload | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /* -- export mutation -- */
  const exportMutation = useMutation({
    mutationFn: async (): Promise<BackupPayload> => {
      const { data, error } = await chefbyte().rpc('export_chefbyte_backup');
      if (error) throw new Error(error.message);
      if (!data || typeof data !== 'object') {
        throw new Error('Backup RPC returned no data');
      }
      return data as BackupPayload;
    },
    onSuccess: (data) => {
      // Trigger browser download. Filename includes today's date so the
      // user can keep multiple rolling backups without clobbering.
      const today = new Date().toISOString().slice(0, 10);
      const filename = `luna-hub-chefbyte-backup-${today}.json`;
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
  });

  /* -- restore mutation -- */
  const restoreMutation = useMutation({
    mutationFn: async (backup: BackupPayload): Promise<RestoreResult> => {
      const { data, error } = await chefbyte().rpc('restore_chefbyte_backup', {
        p_backup: backup,
      });
      if (error) throw new Error(error.message);
      return data as RestoreResult;
    },
    onSuccess: (result) => {
      setRestoreResult(result);
      setRestoreError(null);
      // Reset the file picker so a successful restore doesn't leave the
      // payload staged (which would be confusing).
      setSelectedFile(null);
      setParsedBackup(null);
      setConsent(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      // Nuke every chef-scoped cached query so the rest of the app
      // reflects the restored state on next visit. Blanket invalidate is
      // safer than enumerating all keys.
      if (user) {
        queryClient.invalidateQueries();
      }
    },
    onError: (err: Error) => {
      setRestoreError(err.message);
      setRestoreResult(null);
    },
  });

  /* -- file picker handler -- */
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setParseError(null);
    setRestoreError(null);
    setRestoreResult(null);

    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setParsedBackup(null);
    setConsent(false);
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BackupPayload;
      // Shape sanity check — more detailed validation happens server-side.
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.schema_version !== 'string' ||
        typeof parsed.user_id !== 'string' ||
        !parsed.tables ||
        typeof parsed.tables !== 'object'
      ) {
        throw new Error('File is not a Luna Hub ChefByte backup (missing schema_version / user_id / tables).');
      }
      setParsedBackup(parsed);
    } catch (err: any) {
      setParseError(err.message ?? String(err));
      setParsedBackup(null);
    }
  };

  /* ---------------------------------------------------------------- */
  /*  Render helpers                                                   */
  /* ---------------------------------------------------------------- */

  const renderPreview = () => {
    if (!parsedBackup) return null;

    const userMismatch = user && parsedBackup.user_id !== user.id;
    const currentExpectedVersion = '20260423010000'; // keep in sync w/ migration

    return (
      <div data-testid="restore-preview" className="mt-4 p-4 border border-border rounded-md bg-surface-sunken">
        <div className={sectionHeaderCls}>Backup preview</div>
        <dl className="grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-text-secondary">Schema version</dt>
          <dd
            className={
              parsedBackup.schema_version === currentExpectedVersion
                ? 'text-text font-mono'
                : 'text-danger-text font-mono'
            }
            data-testid="preview-schema-version"
          >
            {parsedBackup.schema_version}
            {parsedBackup.schema_version !== currentExpectedVersion && (
              <span className="ml-2 text-xs">(expected {currentExpectedVersion})</span>
            )}
          </dd>

          <dt className="text-text-secondary">Generated</dt>
          <dd className="text-text">
            {parsedBackup.generated_at ? new Date(parsedBackup.generated_at).toLocaleString() : '—'}
          </dd>

          <dt className="text-text-secondary">Owner user_id</dt>
          <dd className="text-text font-mono text-xs break-all">
            {parsedBackup.user_id}
            {userMismatch && (
              <span className="ml-2 text-danger-text font-semibold text-xs" data-testid="preview-user-mismatch">
                (different from your account!)
              </span>
            )}
          </dd>
        </dl>

        <div className={`${sectionHeaderCls} mt-4`}>Rows per table</div>
        <ul data-testid="preview-counts" className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-sm">
          {BACKUP_TABLES.map((key) => {
            const rows = (parsedBackup.tables as any)?.[key];
            const count = Array.isArray(rows) ? rows.length : 0;
            return (
              <li key={key} className="flex justify-between">
                <span className="text-text-secondary">{TABLE_LABEL[key]}</span>
                <span className="text-text font-semibold" data-testid={`preview-count-${key}`}>
                  {count}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  const renderResult = () => {
    if (!restoreResult) return null;
    return (
      <div
        data-testid="restore-success"
        className="mt-4 p-4 border border-emerald-300 bg-emerald-50 rounded-md text-sm"
      >
        <div className="font-bold text-emerald-800 mb-2">Restore complete</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
          <div>
            <div className="font-semibold text-emerald-900 mb-1">Wiped</div>
            <ul>
              {BACKUP_TABLES.map((key) => (
                <li key={`w-${key}`} className="flex justify-between">
                  <span>{TABLE_LABEL[key]}</span>
                  <span className="font-mono">
                    {
                      restoreResult.wiped?.[key] ??
                        0 /* eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: 0 is correct fallback — restore result counts default to 0 when table was untouched */
                    }
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="font-semibold text-emerald-900 mb-1">Restored</div>
            <ul>
              {BACKUP_TABLES.map((key) => (
                <li key={`r-${key}`} className="flex justify-between">
                  <span>{TABLE_LABEL[key]}</span>
                  <span className="font-mono">
                    {
                      restoreResult.restored?.[key] ??
                        0 /* eslint-disable-line @luna/anti-lazy/no-numeric-coalesce-default -- reason: 0 is correct fallback — restore result counts default to 0 when table was untouched */
                    }
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  };

  /* ================================================================ */
  /*  RENDER                                                           */
  /* ================================================================ */

  const currentExpectedVersion = '20260423010000';
  const versionOk = parsedBackup?.schema_version === currentExpectedVersion;
  const ownerOk = parsedBackup && user && parsedBackup.user_id === user.id;
  const restoreEnabled = !!parsedBackup && !!versionOk && !!ownerOk && consent && !restoreMutation.isPending;

  return (
    <div data-testid="backup-tab" className="p-5">
      {/* Section header */}
      <div className="mb-4 pb-3 border-b border-border">
        <h2 className="m-0 text-lg font-bold text-text">Backup &amp; Restore</h2>
        <p className="m-0 mt-1 text-sm text-text-secondary">
          Snapshot your ChefByte data to a JSON file, or roll back to a prior snapshot
        </p>
      </div>

      {/* ---------------- Export ---------------- */}
      <div className={cardCls} data-testid="export-section">
        <div className={sectionHeaderCls}>Download backup</div>
        <p className={descCls}>
          Saves a single JSON file containing every product, recipe, stock lot, meal-plan entry, food log, quick-add
          macro entry, shopping-list row, and macro goal tied to your account. Does <strong>not</strong> include Pi
          device state, shelf events, or LiveTrack scanning sessions — those are regenerated by the Pi.
        </p>
        <button
          type="button"
          className={primaryBtnCls}
          onClick={() => exportMutation.mutate()}
          disabled={exportMutation.isPending}
          data-testid="download-backup-btn"
        >
          {exportMutation.isPending ? 'Preparing…' : 'Download backup'}
        </button>
        {exportMutation.error && (
          <p className="mt-3 text-sm text-danger-text" data-testid="export-error">
            {(exportMutation.error as Error).message}
          </p>
        )}
      </div>

      {/* ---------------- Restore ---------------- */}
      <div className={cardCls} data-testid="restore-section">
        <div className={sectionHeaderCls}>Restore from backup</div>
        <p className={descCls}>
          <span className="text-danger-text font-semibold">Warning:</span> this will permanently <strong>wipe</strong>{' '}
          all of your current ChefByte data and replace it with the file's contents. There is no undo.
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileChange}
          data-testid="restore-file-input"
          className={fileInputCls}
        />

        {selectedFile && !parseError && !parsedBackup && (
          <p className="mt-3 text-sm text-text-secondary">Reading file…</p>
        )}

        {parseError && (
          <p
            className="mt-3 text-sm text-danger-text bg-danger-subtle px-3 py-2 rounded-md border border-danger"
            data-testid="parse-error"
          >
            {parseError}
          </p>
        )}

        {renderPreview()}

        {parsedBackup && versionOk && ownerOk && (
          <label className="mt-4 flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              data-testid="restore-consent"
              className="mt-1"
            />
            <span className="text-text">
              I understand this will wipe all of my current ChefByte data and replace it with the contents of this
              backup.
            </span>
          </label>
        )}

        {parsedBackup && (
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              className={dangerBtnCls}
              onClick={() => {
                if (parsedBackup) restoreMutation.mutate(parsedBackup);
              }}
              disabled={!restoreEnabled}
              data-testid="restore-confirm-btn"
            >
              {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
            </button>
            {(!versionOk || !ownerOk) && (
              <span className="text-xs text-danger-text self-center" data-testid="restore-blocked-reason">
                {!versionOk
                  ? 'Cannot restore: schema_version mismatch.'
                  : 'Cannot restore: backup belongs to a different account.'}
              </span>
            )}
          </div>
        )}

        {restoreError && (
          <p
            className="mt-3 text-sm text-danger-text bg-danger-subtle px-3 py-2 rounded-md border border-danger"
            data-testid="restore-error"
          >
            {restoreError}
          </p>
        )}

        {renderResult()}
      </div>
    </div>
  );
}
