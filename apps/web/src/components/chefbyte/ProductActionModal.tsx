import { ModalOverlay } from '@/components/shared/ModalOverlay';
import type { ChefbyteProduct } from '@/shared/useChefbyteProducts';
import { formatQuantityWithVisual } from '@/shared/recipes/formatIngredientDisplay';

/**
 * Inventory product action modal.
 *
 * Replaces the prior "expand the row in place" affordance with a popup —
 * matches the user's "edit product should be a popup not expand in place"
 * feedback. The modal opens scoped to a single product and exposes the
 * same five action buttons that used to live in the inline detail panel:
 *
 *   - Add Container       (opens the Add Stock modal pre-filled to 1 ctn)
 *   - Remove Container    (consume mutation, qty=1 unit=container)
 *   - Add Serving         (opens Add Stock modal pre-filled to 1/spc ctn)
 *   - Remove Serving      (consume mutation, qty=1 unit=serving)
 *   - Consume All         (text-style link, fires the confirm modal)
 *
 * Implementation strategy: the parent (InventoryPage) owns all the state
 * (`expandedProductId`, mutations, `openAddStockModal`, `handleConsumeAll`)
 * — this component is intentionally thin to avoid duplicating any of that
 * logic. We only render the modal chrome + the existing action buttons,
 * preserving every `data-testid` so the e2e suite (`apps/web/e2e/chefbyte/
 * inventory.spec.ts`) and unit tests keep targeting the same elements.
 *
 * Cancel = same as the old "click the row again" close — discard form
 * state by setting `expandedProductId` back to null. Save = no-op here:
 * each action button kicks off its own mutation which closes the modal
 * via the `onClose` prop in the parent's success handler chain (or keeps
 * the modal open when the user wants to fire multiple ± actions in a row,
 * matching the prior expand-in-place behaviour).
 */
export interface ProductActionModalProps {
  /** When falsy, the modal is unmounted. */
  isOpen: boolean;
  /** Product the modal is scoped to. Null when `isOpen` is false. */
  product: ChefbyteProduct | null;
  /** Total stock in containers (sum across lots). */
  totalStock: number;
  /** Total stock in servings (totalStock * servings_per_container). */
  servingsTotal: number;
  /**
   * Pre-formatted nearest-expiry label ("Apr 30" / "—"). Pre-formatted by
   * the parent so locale handling stays in one place.
   */
  expiryLabel: string;
  /**
   * True iff `totalStock <= 0 && inFlightSince !== null`. Drives the
   * "(picked up — awaiting reunite)" detail label. Matches the badge
   * predicate in the collapsed row.
   */
  isPickedUp: boolean;
  /** Close the modal (discard any pending state). */
  onClose: () => void;
  /** Open the Add Stock modal scoped to this product, pre-filled to qty. */
  onOpenAddStock: (productId: string, qtyContainers: number) => void;
  /**
   * Fire the consume mutation with explicit unit. Container = 1 ctn,
   * serving = 1 svg. Closing the modal is left to the caller; matches
   * the prior expand-panel behaviour where the row stayed open after a
   * consume so the user could chain actions.
   */
  onConsume: (args: { productId: string; qty: number; unit: 'container' | 'serving'; productName: string }) => void;
  /** Open the "Consume all stock" confirm modal scoped to this product. */
  onConsumeAll: (productId: string) => void;
}

export function ProductActionModal({
  isOpen,
  product,
  totalStock,
  servingsTotal,
  expiryLabel,
  isPickedUp,
  onClose,
  onOpenAddStock,
  onConsume,
  onConsumeAll,
}: ProductActionModalProps) {
  // ModalOverlay handles its own unmount when isOpen=false; the null guard
  // here keeps TypeScript narrowing happy for the body of the modal.
  if (!isOpen || !product) {
    return (
      <ModalOverlay isOpen={false} onClose={onClose} title="">
        <></>
      </ModalOverlay>
    );
  }

  const visualSet =
    product.visual_unit_label != null &&
    product.visual_units_per_serving != null &&
    Number(product.visual_units_per_serving) > 0;
  // When the product has a visual unit, swap the redundant "(servings)"
  // half of the pair for a "(N visual-units)" half. Mirrors the prior
  // inline panel behaviour exactly.
  const visualHalf = visualSet
    ? formatQuantityWithVisual({
        quantity: totalStock,
        unit: 'container',
        visualUnitLabel: product.visual_unit_label,
        visualUnitsPerServing: Number(product.visual_units_per_serving),
        servingsPerContainer: Number(product.servings_per_container) || 1,
      })
    : `${servingsTotal.toFixed(1)} servings`;
  const stockLabel = isPickedUp
    ? '(picked up — awaiting reunite)'
    : `${totalStock.toFixed(1)} containers (${visualHalf})`;

  return (
    <ModalOverlay isOpen={isOpen} onClose={onClose} title={product.name} testId={`inv-detail-${product.product_id}`}>
      {/* Detail info row — mirrors the prior inline detail panel. */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-secondary mb-3">
        <span data-testid={`stock-servings-${product.product_id}`}>{stockLabel}</span>
        <span data-testid={`min-stock-${product.product_id}`}>
          Min stock: {Number(product.min_stock_amount).toFixed(1)}
        </span>
        <span data-testid={`detail-expiry-${product.product_id}`}>Expires: {expiryLabel}</span>
        {product.barcode && <span data-testid={`barcode-${product.product_id}`}>Barcode: {product.barcode}</span>}
      </div>

      {/* Action buttons — clean grid layout, identical to the prior panel. */}
      <div className="grid grid-cols-2 gap-2 max-w-sm">
        <button
          className="flex items-center justify-center gap-1.5 bg-success text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-success-hover transition-colors"
          onClick={() => onOpenAddStock(product.product_id, 1)}
          data-testid={`add-ctn-${product.product_id}`}
        >
          Add Container
        </button>
        <button
          className="flex items-center justify-center gap-1.5 bg-danger text-white border-none px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-danger-hover transition-colors"
          onClick={() =>
            onConsume({
              productId: product.product_id,
              qty: 1,
              unit: 'container',
              productName: product.name,
            })
          }
          data-testid={`sub-ctn-${product.product_id}`}
        >
          Remove Container
        </button>
        <button
          className="flex items-center justify-center gap-1.5 bg-surface text-success-text border-2 border-success px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-success-subtle transition-colors"
          onClick={() => onOpenAddStock(product.product_id, 1 / Number(product.servings_per_container))}
          data-testid={`add-srv-${product.product_id}`}
        >
          Add Serving
        </button>
        <button
          className="flex items-center justify-center gap-1.5 bg-surface text-danger-text border-2 border-danger px-3 py-2 rounded-lg cursor-pointer text-sm font-semibold hover:bg-danger-subtle transition-colors"
          onClick={() =>
            onConsume({
              productId: product.product_id,
              qty: 1,
              unit: 'serving',
              productName: product.name,
            })
          }
          data-testid={`sub-srv-${product.product_id}`}
        >
          Remove Serving
        </button>
      </div>

      {/* Consume All — separate, text-style. Same testid as before. */}
      <button
        className="mt-2 bg-transparent text-text-secondary border-none px-0 py-1 cursor-pointer text-sm underline hover:text-text transition-colors"
        onClick={() => onConsumeAll(product.product_id)}
        data-testid={`consume-all-${product.product_id}`}
      >
        Consume All
      </button>
    </ModalOverlay>
  );
}
