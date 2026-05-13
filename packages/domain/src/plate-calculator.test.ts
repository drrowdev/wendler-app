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

  describe('preferredMaxPlateKg cap', () => {
    it('avoids 25 kg plates when capped at 20', () => {
      // 100 kg = 20 bar + 40/side. Default greedy picks 25+10+5. With cap 20,
      // we expect 20+20 (no 25s).
      const r = calculatePlates(100, DEFAULT_INVENTORY_KG, { preferredMaxPlateKg: 20 });
      expect(r.achievable).toBe(true);
      expect(r.totalWeightKg).toBe(100);
      expect(r.perSide.find((p) => p.weightKg === 25)).toBeUndefined();
    });

    it('falls back to full inventory when cap makes target unachievable', () => {
      // 142.5 kg with cap 20: per-side 61.25, max with cap = 20+20+15+5+1.25 ish
      // Actually 20*2 + 15 + 5 + 1.25 = 61.25 — achievable! Use a target that
      // genuinely needs a 25. E.g. 140 with limited 20s: cap 25 only available.
      // Use a stripped inventory: only {25: 2, 20: 1, 5: 2}, target 110.
      // perSide = 45. Cap 20: only one 20 + 5*5 = 20+25 = 45 — achievable.
      // Try cap 5 with target 130 (perSide 55): only 5 kg plates → 11x5 needs
      // 11 pairs but inventory has 2 → unachievable. Should fall back and use 25s.
      const inv = {
        barWeightKg: 20,
        pairsByWeight: { 25: 2, 20: 2, 5: 2 } as Record<number, number>,
      };
      const r = calculatePlates(140, inv, { preferredMaxPlateKg: 5 });
      // Fallback path: 25+25+10? no 10s. 25+20+5+5 = 55 per side. Total 130. Not 140.
      // 25+25+5 = 55 per side → 130. Use a more achievable target.
      // Use target 100: perSide 40. Cap 5: 8 pairs of 5 needed, only 2 → fall back.
      // Greedy: 25+10+5 (no 10s) → 25+5+5 = 35. Not 40. So inv is awkward.
      // Use inventory with 10s for the fallback path.
      void r; // sanity only — see explicit fallback test below
      const inv2 = {
        barWeightKg: 20,
        pairsByWeight: { 25: 2, 20: 2, 10: 2, 5: 2 } as Record<number, number>,
      };
      const r2 = calculatePlates(150, inv2, { preferredMaxPlateKg: 5 });
      // Target 150, perSide 65. Cap 5 only allows max 2x5=10 → unachievable.
      // Fallback uses heaviest: 25+25+10+5 = 65 → achievable.
      expect(r2.achievable).toBe(true);
      expect(r2.perSide.some((p) => p.weightKg === 25)).toBe(true);
    });

    it('cap of 20 still allows 100 kg via 20+20', () => {
      const r = calculatePlates(100, DEFAULT_INVENTORY_KG, { preferredMaxPlateKg: 20 });
      const twenties = r.perSide.find((p) => p.weightKg === 20);
      expect(twenties?.count).toBe(2);
    });

    it('no cap behaves identically to omitting options', () => {
      const a = calculatePlates(100, DEFAULT_INVENTORY_KG);
      const b = calculatePlates(100, DEFAULT_INVENTORY_KG, {});
      expect(a).toEqual(b);
    });
  });
});
