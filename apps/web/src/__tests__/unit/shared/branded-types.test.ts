/**
 * Unit tests for branded ID types and their parsers.
 *
 * Key regression: A Pi-local lot UUID and a cloud stock_lot UUID are both
 * valid UUID strings but live in entirely different namespaces. Tests use
 * distinct UUIDs for each namespace and verify that format-valid-but-wrong-
 * namespace UUIDs are rejected by the lookup-table check.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseCloudLotId,
  parseCloudProductId,
  parseCloudEventId,
  InvalidIdError,
  type CloudLotId,
  type CloudProductId,
  type CloudEventId,
} from '@/shared/types/branded';

// ---------------------------------------------------------------------------
// Distinct UUIDs — intentionally using different values to prevent the
// regression where a Pi-local lot_id accidentally matches a cloud lot_id.
// ---------------------------------------------------------------------------
const CLOUD_LOT_UUID = '11111111-0000-4000-8000-000000000001';
const PI_LOCAL_LOT_UUID = '22222222-0000-4000-8000-000000000002'; // different namespace
const CLOUD_PRODUCT_UUID = '33333333-0000-4000-8000-000000000003';
const CLOUD_EVENT_UUID = '44444444-0000-4000-8000-000000000004';
const ABSENT_UUID = '99999999-0000-4000-8000-000000000099'; // valid format, not in any table

// ---------------------------------------------------------------------------
// Helpers — mock Supabase connection builder
// ---------------------------------------------------------------------------

function makeConn(returnData: Record<string, unknown> | null) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: returnData, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from, select, eq, maybeSingle };
}

// ---------------------------------------------------------------------------
// parseCloudLotId
// ---------------------------------------------------------------------------

describe('parseCloudLotId', () => {
  it('returns a CloudLotId when UUID exists in stock_lots', async () => {
    const conn = makeConn({ lot_id: CLOUD_LOT_UUID });
    const result = await parseCloudLotId(CLOUD_LOT_UUID, conn);
    expect(result).toBe(CLOUD_LOT_UUID);
    expect(conn.from).toHaveBeenCalledWith('stock_lots');
    // Compile-time: result is assignable to CloudLotId
    const _typed: CloudLotId = result;
    expect(_typed).toBeTruthy();
  });

  it('rejects a valid-format UUID absent from stock_lots (namespace mismatch)', async () => {
    // PI_LOCAL_LOT_UUID is a valid UUID but does NOT exist in stock_lots —
    // this is the exact bug class we are guarding against.
    const conn = makeConn(null);
    await expect(parseCloudLotId(PI_LOCAL_LOT_UUID, conn)).rejects.toThrow(InvalidIdError);
    await expect(parseCloudLotId(PI_LOCAL_LOT_UUID, conn)).rejects.toThrow('stock_lots');
  });

  it('rejects a UUID not present in stock_lots at all', async () => {
    const conn = makeConn(null);
    const err = await parseCloudLotId(ABSENT_UUID, conn).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.expectedNamespace).toBe('CloudLotId');
    expect(err.tableQueried).toBe('stock_lots');
    expect(err.raw).toBe(ABSENT_UUID);
  });

  it('rejects a non-UUID string without hitting the DB', async () => {
    const conn = makeConn({ lot_id: 'whatever' });
    const err = await parseCloudLotId('not-a-uuid', conn).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.tableQueried).toBe('format check');
    // DB must NOT have been called
    expect(conn.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseCloudProductId
// ---------------------------------------------------------------------------

describe('parseCloudProductId', () => {
  it('returns a CloudProductId when UUID exists in products', async () => {
    const conn = makeConn({ product_id: CLOUD_PRODUCT_UUID });
    const result = await parseCloudProductId(CLOUD_PRODUCT_UUID, conn);
    expect(result).toBe(CLOUD_PRODUCT_UUID);
    expect(conn.from).toHaveBeenCalledWith('products');
    const _typed: CloudProductId = result;
    expect(_typed).toBeTruthy();
  });

  it('rejects a valid-format UUID absent from products', async () => {
    const conn = makeConn(null);
    await expect(parseCloudProductId(ABSENT_UUID, conn)).rejects.toThrow(InvalidIdError);
    await expect(parseCloudProductId(ABSENT_UUID, conn)).rejects.toThrow('products');
  });

  it('rejects an invalid format string without DB call', async () => {
    const conn = makeConn(null);
    const err = await parseCloudProductId('bad', conn).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.tableQueried).toBe('format check');
    expect(conn.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// parseCloudEventId
// ---------------------------------------------------------------------------

describe('parseCloudEventId', () => {
  it('returns a CloudEventId when UUID exists in shelf_event_log', async () => {
    const conn = makeConn({ event_id: CLOUD_EVENT_UUID });
    const result = await parseCloudEventId(CLOUD_EVENT_UUID, conn);
    expect(result).toBe(CLOUD_EVENT_UUID);
    expect(conn.from).toHaveBeenCalledWith('shelf_event_log');
    const _typed: CloudEventId = result;
    expect(_typed).toBeTruthy();
  });

  it('rejects a valid-format UUID absent from shelf_event_log', async () => {
    const conn = makeConn(null);
    const err = await parseCloudEventId(ABSENT_UUID, conn).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.tableQueried).toBe('shelf_event_log');
  });

  it('rejects an invalid format string without DB call', async () => {
    const conn = makeConn(null);
    const err = await parseCloudEventId('not-uuid', conn).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.tableQueried).toBe('format check');
    expect(conn.from).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// InvalidIdError shape
// ---------------------------------------------------------------------------

describe('InvalidIdError', () => {
  it('carries raw, expectedNamespace, tableQueried fields', () => {
    const err = new InvalidIdError('bad-id', 'CloudLotId', 'stock_lots');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(InvalidIdError);
    expect(err.raw).toBe('bad-id');
    expect(err.expectedNamespace).toBe('CloudLotId');
    expect(err.tableQueried).toBe('stock_lots');
    expect(err.message).toContain('bad-id');
    expect(err.message).toContain('stock_lots');
    expect(err.message).toContain('CloudLotId');
  });
});
