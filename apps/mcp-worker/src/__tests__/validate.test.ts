import { describe, it, expect } from 'vitest';
import { validateToolArgs } from '../validate';

describe('validateToolArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      count: { type: 'number' },
      active: { type: 'boolean' },
      tags: { type: 'array' },
      priority: { type: 'integer' },
    },
    required: ['name', 'count'],
  };

  it('returns null for valid args', () => {
    expect(validateToolArgs({ name: 'test', count: 5 }, schema)).toBeNull();
  });

  it('returns null when all optional fields included', () => {
    expect(validateToolArgs({ name: 'test', count: 5, active: true, tags: ['a'], priority: 1 }, schema)).toBeNull();
  });

  it('returns error for missing required field', () => {
    expect(validateToolArgs({ count: 5 }, schema)).toBe('Missing required argument: name');
  });

  it('returns error for null required field', () => {
    expect(validateToolArgs({ name: null, count: 5 } as any, schema)).toBe('Missing required argument: name');
  });

  it('returns error for wrong type: string expected', () => {
    expect(validateToolArgs({ name: 123, count: 5 }, schema)).toBe('Argument "name" must be a string');
  });

  it('returns error for wrong type: number expected', () => {
    expect(validateToolArgs({ name: 'test', count: 'five' }, schema)).toBe('Argument "count" must be a number');
  });

  it('returns error for wrong type: boolean expected', () => {
    expect(validateToolArgs({ name: 'test', count: 1, active: 'yes' }, schema)).toBe(
      'Argument "active" must be a boolean',
    );
  });

  it('returns error for wrong type: array expected', () => {
    expect(validateToolArgs({ name: 'test', count: 1, tags: 'not-array' }, schema)).toBe(
      'Argument "tags" must be an array',
    );
  });

  it('returns error for wrong type: integer expected (float)', () => {
    expect(validateToolArgs({ name: 'test', count: 1, priority: 1.5 }, schema)).toBe(
      'Argument "priority" must be an integer',
    );
  });

  it('returns error for wrong type: integer expected (string)', () => {
    expect(validateToolArgs({ name: 'test', count: 1, priority: '1' }, schema)).toBe(
      'Argument "priority" must be an integer',
    );
  });

  it('accepts integer for integer type', () => {
    expect(validateToolArgs({ name: 'test', count: 1, priority: 3 }, schema)).toBeNull();
  });

  it('ignores unknown properties', () => {
    expect(validateToolArgs({ name: 'test', count: 1, extra: 'ok' }, schema)).toBeNull();
  });

  it('returns null for non-object schema type', () => {
    expect(validateToolArgs({ foo: 'bar' }, { type: 'string' })).toBeNull();
  });

  it('returns null for empty schema', () => {
    expect(validateToolArgs({ foo: 'bar' }, {})).toBeNull();
  });

  it('handles schema with no required field', () => {
    const noRequired = {
      type: 'object',
      properties: { name: { type: 'string' } },
    };
    expect(validateToolArgs({}, noRequired)).toBeNull();
  });

  it('validates object type argument', () => {
    const withObj = {
      type: 'object',
      properties: { meta: { type: 'object' } },
      required: ['meta'],
    };
    expect(validateToolArgs({ meta: { key: 'val' } }, withObj)).toBeNull();
    expect(validateToolArgs({ meta: [1, 2] }, withObj)).toBe('Argument "meta" must be an object');
    expect(validateToolArgs({ meta: 'str' }, withObj)).toBe('Argument "meta" must be an object');
  });
});
