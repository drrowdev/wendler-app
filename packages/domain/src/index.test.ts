import { describe, it, expect } from 'vitest';
import { VERSION } from './index';

describe('domain', () => {
  it('exposes a version', () => {
    expect(VERSION).toBe('0.0.1');
  });
});
