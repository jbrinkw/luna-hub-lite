export type LivetrackTagColor = 'red' | 'blue' | 'normal';

export interface LivetrackTagState {
  color: LivetrackTagColor;
  tooltip: string;
  label: string;
}

export interface LivetrackTagInputs {
  tare_weight_g: number | null;
  measured_full_at: string | null;
  net_weight_g?: number | null;
  /**
   * Whether the product is fully certified (LiveTrack enrolment complete on
   * the Pi side). Optional + back-compat: callers that don't pass it get the
   * pre-existing behaviour. When explicitly `false`, the red-tooltip wording
   * is tweaked to clarify that the product has been touched by LiveTrack but
   * has not yet been calibrated — this is the natural state for a near-full
   * container placed on the catch-all where the empty-bottle auto-tare
   * heuristic (< 30% of net_weight_g) doesn't fire. Blue + normal tooltips
   * are unaffected: those branches assume tare is already set, which only
   * happens after certification on the Pi side.
   */
  certified?: boolean | null;
}

/**
 * The set of `chefbyte.stock_lots.last_update_source` values that indicate
 * the lot has been observed by the LiveTrack system (Pi-side scales). Used
 * by ``livetrackTagVisible`` to decide whether the red LiveTrack tag should
 * render for an UNCERTIFIED product — the "delta-only tracking" state is
 * the natural intermediate state between "first touched" and "tare captured".
 *
 * Kept in lockstep with the matching server-side enum on
 * ``chefbyte.stock_lots.last_update_source``. ``'manual'`` is intentionally
 * excluded: a hand-entered lot has never been seen by a LiveTrack scale and
 * does NOT warrant the tag.
 */
export const LIVETRACK_LAST_UPDATE_SOURCES = ['catch_all', 'live_shelf', 'live_scale'] as const;
export type LivetrackLotSource = (typeof LIVETRACK_LAST_UPDATE_SOURCES)[number];

export interface LivetrackTagVisibilityInputs {
  /** Per-product `chefbyte.products.certified` flag. */
  certified: boolean | null | undefined;
  /**
   * For the grouped-view: pass each lot's ``last_update_source``. Any single
   * match against ``LIVETRACK_LAST_UPDATE_SOURCES`` makes the tag visible.
   * For the per-lot view: pass a singleton ``[lot.last_update_source]`` so
   * the per-row decision matches the grouped-row decision for a 1-lot
   * product.
   *
   * Values are accepted as the broader ``string | null | undefined`` rather
   * than the narrow lot-source union so callers don't have to pre-cast — the
   * function defensively ignores anything outside the LiveTrack set.
   */
  lotLastUpdateSources: ReadonlyArray<string | null | undefined>;
}

/**
 * Decides whether the LiveTrack tag should render for a product.
 *
 * Returns true when:
 * - The product is ``certified`` (preserves the original visibility rule —
 *   certified products always show the tag, even if no lot has a LiveTrack
 *   source tag yet), OR
 * - Any lot has a ``last_update_source`` in ``LIVETRACK_LAST_UPDATE_SOURCES``
 *   (the bug fix — an uncertified product that has been seen by the Pi
 *   still deserves the red "delta-only" tag).
 *
 * The blue + emerald colour variants — both of which require a captured
 * tare and live behind the certified gate on the Pi — are filtered upstream
 * by the caller (they pass tare/full inputs through ``livetrackTagState``);
 * this helper only governs visibility of the OUTER tag element. The colour
 * choice still flows from ``livetrackTagState``.
 */
export function livetrackTagVisible(inputs: LivetrackTagVisibilityInputs): boolean {
  if (inputs.certified === true) return true;
  return inputs.lotLastUpdateSources.some(
    (s) => s != null && (LIVETRACK_LAST_UPDATE_SOURCES as readonly string[]).includes(s),
  );
}

export function livetrackTagState(inputs: LivetrackTagInputs): LivetrackTagState {
  const tareSet = inputs.tare_weight_g !== null && inputs.tare_weight_g !== undefined;
  const fullSet = inputs.measured_full_at !== null && inputs.measured_full_at !== undefined;

  if (!tareSet) {
    // Uncertified-but-touched products get a wording tweak that clarifies
    // why no tare is recorded yet (the product hasn't been calibrated) and
    // gives the user a concrete next step. Colour stays red so the visual
    // affordance — "this product is delta-only" — is preserved.
    if (inputs.certified === false) {
      return {
        color: 'red',
        label: 'LiveTrack',
        tooltip:
          'Recently seen by the catch-all but not yet calibrated — only relative weight changes are tracked. Place an empty container on the catch-all to capture tare automatically.',
      };
    }
    return {
      color: 'red',
      label: 'LiveTrack',
      tooltip:
        'No tare measured yet — only relative weight changes are tracked. Place this product on the catch-all scale to capture tare automatically.',
    };
  }
  if (!fullSet) {
    const netMissing = inputs.net_weight_g === null || inputs.net_weight_g === undefined;
    return {
      color: 'blue',
      label: 'LiveTrack',
      tooltip: netMissing
        ? "Tare is estimated, not measured. Set the product's net weight (in product details), then place a fresh container on the catch-all to confirm calibration."
        : 'Tare is estimated, not measured. Place a fresh container on the catch-all scale to confirm and lock the calibration.',
    };
  }
  return {
    color: 'normal',
    label: 'LiveTrack',
    tooltip: 'Fully calibrated. Tare is measured and full mass confirmed.',
  };
}

export function livetrackTagClassNames(color: LivetrackTagColor): string {
  switch (color) {
    case 'red':
      return 'bg-red-50 text-red-800 border border-red-200';
    case 'blue':
      return 'bg-blue-50 text-blue-800 border border-blue-200';
    case 'normal':
      return 'bg-emerald-50 text-emerald-800 border border-emerald-200';
  }
}
