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
          <p className="text-sm text-text-secondary mb-4">Are you sure you want to deactivate {displayName}?</p>
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
            >
              Confirm
            </Button>
          </div>
        </Modal>
      </CardContent>
    </Card>
  );
}
