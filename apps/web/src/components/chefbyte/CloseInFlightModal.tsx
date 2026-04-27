import { useState } from 'react';
import { Trash2, Utensils, RotateCcw } from 'lucide-react';
import { ModalOverlay } from '@/components/shared/ModalOverlay';

/**
 * Resolution kinds the user can pick when manually closing out an
 * in-flight lot via the badge → modal flow on the Inventory page.
 *
 * Mirrors the `p_resolution` literals accepted by
 * `chefbyte.close_in_flight_lot(...)` (migration
 * 20260427110000_close_in_flight_lot_rpc.sql).
 */
export type CloseInFlightResolution = 'discarded' | 'consumed' | 'returned';

export interface CloseInFlightModalProps {
  /** When falsy, the modal is unmounted (no callback fires). */
  isOpen: boolean;
  /** Lot the modal is scoped to — required when `isOpen` is true. */
  lotId: string | null;
  /** Product name shown in the modal header. */
  productName: string | null;
  /**
   * Pickup timestamp (ISO-8601) — rendered in the subtitle so the user
   * has a "this lot was picked up at HH:mm" cue. May be null on legacy
   * rows where in_flight_since hasn't been re-stamped.
   */
  pickupTs: string | null;
  /** Called when the user dismisses the modal without resolving. */
  onClose: () => void;
  /**
   * Called when the user picks a resolution + (optionally) supplies a
   * note. Must perform the RPC call and either close the modal on
   * success or surface a returned error to keep it open.
   *
   * The component handles the in-flight loading state + error display
   * itself; the parent only needs to do the network work.
   */
  onResolve: (args: {
    resolution: CloseInFlightResolution;
    note: string | null;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Modal: "Close out in-flight lot — <product name>".
 *
 * Three big resolution buttons (Discarded / Consumed / Returned), an
 * optional note textarea for the audit trail, and a Cancel button. Only
 * one resolution can be in flight at a time — clicking a button disables
 * all four buttons until `onResolve` settles.
 *
 * Errors returned from `onResolve` are surfaced inside the modal itself
 * (red callout above the buttons) so the user can retry without losing
 * their note.
 */
export function CloseInFlightModal({
  isOpen,
  lotId,
  productName,
  pickupTs,
  onClose,
  onResolve,
}: CloseInFlightModalProps) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<CloseInFlightResolution | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Note: transient state (note / busy / error) is reset by the
  // PARENT remounting this component on each new lot via a `key` prop —
  // see InventoryPage's <CloseInFlightModal key={closeModalLot?.lotId} />.
  // Resetting via useEffect on `isOpen`/`lotId` would trigger the
  // react-hooks/set-state-in-effect cascading-render warning; keying on
  // lotId is the React-recommended remount pattern for "fresh form state
  // every time a new entity is selected" and avoids that warning.

  const pickupLabel = (() => {
    if (!pickupTs) return null;
    const d = new Date(pickupTs);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleString([], {
      hour: '2-digit',
      minute: '2-digit',
      month: 'short',
      day: 'numeric',
    });
  })();

  async function handleResolve(resolution: CloseInFlightResolution) {
    if (busy !== null || !lotId) return;
    setBusy(resolution);
    setError(null);
    const trimmed = note.trim();
    const result = await onResolve({
      resolution,
      note: trimmed.length > 0 ? trimmed : null,
    });
    if (result.ok) {
      // Parent owns dismissal so it can also do TanStack Query
      // invalidation / toast / etc. before the modal disappears.
      // We purposely leave busy in place — the modal will unmount
      // on the parent's onClose, so flipping it back is unnecessary.
      return;
    }
    setBusy(null);
    setError(result.error);
  }

  return (
    <ModalOverlay
      isOpen={isOpen}
      onClose={() => {
        if (busy !== null) return; // Block dismiss mid-RPC
        onClose();
      }}
      title={`Close out in-flight lot — ${productName ?? 'lot'}`}
      testId="close-in-flight-modal"
      maxWidth="560px"
    >
      <p className="text-sm text-text-secondary m-0 mb-4" data-testid="close-modal-subtitle">
        {pickupLabel
          ? `This lot was picked up at ${pickupLabel}. Choose how to resolve it:`
          : 'Choose how to resolve this in-flight lot:'}
      </p>

      {error && (
        <div
          data-testid="close-modal-error"
          className="bg-danger-subtle border border-danger rounded-md p-2.5 mb-3 text-sm text-danger-text"
          role="alert"
        >
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3 mb-4">
        {/* DISCARDED */}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => handleResolve('discarded')}
          data-testid="close-modal-discarded"
          className="flex items-start gap-3 px-3 py-3 rounded-lg border-2 border-danger bg-surface hover:bg-danger-subtle text-left disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Trash2 className="w-5 h-5 text-danger-text shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            <span className="block font-semibold text-sm text-danger-text">
              {busy === 'discarded' ? 'Marking as discarded…' : 'Mark as discarded'}
            </span>
            <span className="block text-xs text-text-secondary mt-0.5">
              Thrown away, spilled, fed to a pet — does NOT log macros.
            </span>
          </span>
        </button>

        {/* CONSUMED */}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => handleResolve('consumed')}
          data-testid="close-modal-consumed"
          className="flex items-start gap-3 px-3 py-3 rounded-lg border-2 border-warning bg-surface hover:bg-warning-subtle text-left disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Utensils className="w-5 h-5 text-warning-text shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            <span className="block font-semibold text-sm text-warning-text">
              {busy === 'consumed' ? 'Marking as consumed…' : 'Mark as consumed'}
            </span>
            <span className="block text-xs text-text-secondary mt-0.5">
              Eaten but not measured — logs macros for the lot's last-known qty.
            </span>
          </span>
        </button>

        {/* RETURNED */}
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => handleResolve('returned')}
          data-testid="close-modal-returned"
          className="flex items-start gap-3 px-3 py-3 rounded-lg border-2 border-info bg-surface hover:bg-info-subtle text-left disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw className="w-5 h-5 text-info-text shrink-0 mt-0.5" aria-hidden="true" />
          <span className="flex-1">
            <span className="block font-semibold text-sm text-info-text">
              {busy === 'returned' ? 'Marking as returned…' : 'Mark as returned (still on shelf)'}
            </span>
            <span className="block text-xs text-text-secondary mt-0.5">
              False alarm — the bottle is still on the shelf. Restores the lot.
            </span>
          </span>
        </button>
      </div>

      <label className="block text-xs text-text-tertiary mb-1" htmlFor="close-modal-note">
        Note (optional, recorded in the audit trail)
      </label>
      <textarea
        id="close-modal-note"
        data-testid="close-modal-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={busy !== null}
        rows={2}
        placeholder="e.g. spilled in fridge, ate it on the run, classifier glitch…"
        className="w-full px-3 py-2 border border-border-strong rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-focus-ring focus:border-primary box-border resize-none disabled:bg-surface-sunken disabled:cursor-not-allowed"
      />

      <div className="flex justify-end mt-4">
        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          data-testid="close-modal-cancel"
          className="bg-transparent text-text-secondary border-none px-4 py-1.5 rounded-md cursor-pointer hover:text-text disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
      </div>
    </ModalOverlay>
  );
}
