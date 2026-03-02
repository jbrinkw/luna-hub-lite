import { describe, it, expect } from 'vitest';

describe('Unit test environment', () => {
  it('vitest + jsdom env works', () => {
    const div = document.createElement('div');
    div.textContent = 'Luna Hub Lite';
    expect(div.textContent).toBe('Luna Hub Lite');
    expect(document).toBeDefined();
  });
});
