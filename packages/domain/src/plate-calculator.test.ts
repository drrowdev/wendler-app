import { describe, it, expect } from 'vitest';
import { calculatePlates, DEFAULT_INVENTORY_KG } from './plate-calculator';

describe('plate-calculator', () => {
  it('returns no plates for bar-only weight', () => {
    const r = calculatePlates(20, DEFAULT_INVENTORY_KG);
    expect(r.perSide).toEqual([]);
    expect(r.achievable).toBe(true);
  });

  it('breaks down 100 kg correctly with default inventory', () => {
    // 100 kg = 20 bar + 40 per side = 25 + 15? but inventory has only 1 pair of 15.
    // Actually 25 + 10 + 5 = 40 per side. Let's verify:
    const r = calculatePlates(100, DEFAULT_INVENTORY_KG);
    const totalPerSide = r.perSide.reduce((a, p) => a + p.weightKg * p.count, 0);
    expect(totalPerSide).toBe(40);
    expect(r.totalWeightKg).toBe(100);
    expect(r.achievable).toBe(true);
  });

  it('handles 142.5 kg (25+25+10+5+2.5+1.25 ish)', () => {
    const r = calculatePlates(142.5, DEFAULT_INVENTORY_KG);
    expect(r.totalWeightKg).toBe(142.5);
    expect(r.achievable).toBe(true);
  });

  it('reports unachievable weight when inventory runs out', () => {
    const r = calculatePlates(500, {
      barWeightKg: 20,
      pairsByWeight: { 25: 1, 10: 1 },
    });
    expect(r.achievable).toBe(false);
    expect(r.remainderKg).toBeGreaterThan(0);
    expect(r.totalWeightKg).toBe(20 + 2 * 25 + 2 * 10);
  });

  it('reports unachievable when fractional remainder cannot be loaded', () => {
    const r = calculatePlates(101, DEFAULT_INVENTORY_KG);
    expect(r.achievable).toBe(false);
    expect(r.remainderKg).toBeGreaterThan(0);
  });
});
