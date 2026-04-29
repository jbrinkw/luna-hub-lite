import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';

interface AppActivationCardProps {
  appName: string;
  displayName: string;
  active: boolean;
  loading?: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
}

export function AppActivationCard({ displayName, active, loading, onActivate, onDeactivate }: AppActivationCardProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  // R2 audit F8: a single-click confirm on full-DB delete is too
  // light. Match the GitHub / Stripe / AWS baseline — operator must
  // type a literal phrase to enable the destructive button.
  const expectedPhrase = `delete ${displayName.toLowerCase()}`;
  const [confirmText, setConfirmText] = useState('');
  const phraseMatches = confirmText.trim().toLowerCase() === expectedPhrase;

  // Reset the confirm input every time the modal opens so a stray
  // typed value from a prior cancel doesn't pre-arm the next attempt.
  const openModal = () => {
    setConfirmText('');
    setShowConfirm(true);
  };
  const closeModal = () => {
    setConfirmText('');
    setShowConfirm(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{displayName}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Badge variant={active ? 'success' : 'default'}>{active ? 'Active' : 'Inactive'}</Badge>
          {active ? (
            <Button variant="danger" size="sm" onClick={openModal} disabled={loading}>
              Deactivate
            </Button>
          ) : (
            <Button size="sm" onClick={onActivate} disabled={loading} loading={loading}>
              Activate
            </Button>
          )}
        </div>

        <Modal open={showConfirm} onClose={closeModal} title={`Deactivate ${displayName}?`} maxWidth="sm">
          {/* hub.deactivate_app does a full DELETE of the module's data
              (per docs/apps/hub.md and private.deactivate_app SECURITY
              DEFINER fn). Make that explicit — the audit specifically
              flagged the prior copy as too vague for a destructive
              flow. */}
          <p className="text-sm text-text-secondary mb-2">
            Deactivating <span className="font-medium text-text">{displayName}</span> will permanently delete all of its
            data:
          </p>
          <ul className="mb-4 list-disc pl-5 text-sm text-text-secondary space-y-1" data-testid="deactivate-data-list">
            {displayName === 'CoachByte' && (
              <>
                <li>Workout plans, completed sets, and timer state</li>
                <li>Exercise PRs and workout history</li>
              </>
            )}
            {displayName === 'ChefByte' && (
              <>
                <li>Inventory, products, and recipes</li>
                <li>Meal plans, macro logs, and shopping list</li>
                <li>Live Shelf devices and scale pairings</li>
              </>
            )}
            {displayName !== 'CoachByte' && displayName !== 'ChefByte' && <li>All data created by this module</li>}
          </ul>
          <p className="mb-4 text-sm text-danger-text font-medium">
            This cannot be undone. Re-activating {displayName} starts you with an empty database.
          </p>
          <Input
            label={`Type "${expectedPhrase}" to confirm`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            data-testid="deactivate-phrase-input"
            placeholder={expectedPhrase}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="mt-4 flex gap-3 justify-end">
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!phraseMatches}
              onClick={() => {
                if (!phraseMatches) return;
                closeModal();
                onDeactivate();
              }}
              data-testid="deactivate-confirm"
            >
              Yes, delete my data
            </Button>
          </div>
        </Modal>
      </CardContent>
    </Card>
  );
}
