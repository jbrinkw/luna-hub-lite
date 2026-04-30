/**
 * Branded UUID types for cross-process identity namespaces.
 *
 * Problem: A UUID that identifies a Pi-local lot and a UUID that identifies
 * a cloud stock lot can have identical format but carry entirely different
 * semantic meaning. Format-only validation (UUID regex) is insufficient —
 * a Pi-local lot_id will fail at the cloud handler even though it is a
 * "valid" UUID. Branded types make the compiler reject such misuse at the
 * call site; parsers validate namespace provenance against the actual
 * lookup table (not just format).
 */

/** A UUID known to exist in cloud `chefbyte.stock_lots.lot_id`. */
export type CloudLotId = string & { readonly __brand: 'CloudLotId' };

/** A UUID known to exist in Pi `lots.lot_id` (local mirror, different namespace). */
export type PiLocalLotId = string & { readonly __brand: 'PiLocalLotId' };

/** A UUID known to exist in cloud `chefbyte.products.product_id`. */
export type CloudProductId = string & { readonly __brand: 'CloudProductId' };

/** A UUID known to exist in cloud `chefbyte.shelf_event_log.event_id`. */
export type CloudEventId = string & { readonly __brand: 'CloudEventId' };

/** A UUID known to exist in Pi `scale_events.event_id`. */
export type PiLocalEventId = string & { readonly __brand: 'PiLocalEventId' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidIdError extends Error {
  constructor(
    readonly raw: string,
    readonly expectedNamespace: string,
    readonly tableQueried: string,
  ) {
    super(`'${raw}' not found in ${tableQueried} (expected ${expectedNamespace})`);
    this.name = 'InvalidIdError';
  }
}

// ---------------------------------------------------------------------------
// Supabase-backed parsers (used in web / edge function contexts)
// ---------------------------------------------------------------------------

type SupabaseConn = { from: (table: string) => any };

function assertUuidFormat(raw: string, namespace: string): void {
  if (!UUID_RE.test(raw)) {
    throw new InvalidIdError(raw, namespace, 'format check');
  }
}

/**
 * Parse a raw string as CloudLotId by verifying it exists in
 * `chefbyte.stock_lots` (or the Pi cloud_lots mirror when called from Pi-side
 * TypeScript code). Rejects valid-format UUIDs that belong to the wrong
 * namespace (e.g. a Pi-local lot_id).
 */
export async function parseCloudLotId(raw: string, conn: SupabaseConn): Promise<CloudLotId> {
  assertUuidFormat(raw, 'CloudLotId');
  const { data } = await conn.from('stock_lots').select('lot_id').eq('lot_id', raw).maybeSingle();
  if (!data) throw new InvalidIdError(raw, 'CloudLotId', 'stock_lots');
  return raw as CloudLotId;
}

/**
 * Parse a raw string as CloudProductId by verifying it exists in
 * `chefbyte.products`.
 */
export async function parseCloudProductId(raw: string, conn: SupabaseConn): Promise<CloudProductId> {
  assertUuidFormat(raw, 'CloudProductId');
  const { data } = await conn.from('products').select('product_id').eq('product_id', raw).maybeSingle();
  if (!data) throw new InvalidIdError(raw, 'CloudProductId', 'products');
  return raw as CloudProductId;
}

/**
 * Parse a raw string as CloudEventId by verifying it exists in
 * `chefbyte.shelf_event_log`.
 */
export async function parseCloudEventId(raw: string, conn: SupabaseConn): Promise<CloudEventId> {
  assertUuidFormat(raw, 'CloudEventId');
  const { data } = await conn.from('shelf_event_log').select('event_id').eq('event_id', raw).maybeSingle();
  if (!data) throw new InvalidIdError(raw, 'CloudEventId', 'shelf_event_log');
  return raw as CloudEventId;
}
