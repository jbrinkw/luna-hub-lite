import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{displayName}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Badge variant={active ? 'success' : 'default'}>{active ? 'Active' : 'Inactive'}</Badge>
          {active ? (
            <Button variant="danger" size="sm" onClick={() => setShowConfirm(true)} disabled={loading}>
              Deactivate
            </Button>
          ) : (
            <Button size="sm" onClick={onActivate} disabled={loading} loading={loading}>
              Activate
            </Button>
          )}
        </div>

        <Modal
          open={showConfirm}
          onClose={() => setShowConfirm(false)}
          title={`Deactivate ${displayName}?`}
          maxWidth="sm"
        >
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
          <div className="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setShowConfirm(false);
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
