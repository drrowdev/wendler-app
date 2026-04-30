import type { PlateBreakdown, PlateInventory } from './types';

/**
 * Compute the per-side plate loadout for a target weight given the user's plate inventory.
 * Greedy from heaviest to lightest plate. Reports unachievable weight as a remainder.
 *
 * Notes:
 * - Plates are loaded in pairs (one per side). `pairsByWeight` is the *number of pairs*
 *   available for each plate weight.
 * - If the target is below or equal to bar weight, returns no plates.
 */
export function calculatePlates(
  targetWeightKg: number,
  inventory: PlateInventory,
): PlateBreakdown {
  const bar = inventory.barWeightKg;
  if (targetWeightKg <= bar) {
    return {
      totalWeightKg: bar,
      perSide: [],
      achievable: targetWeightKg === bar,
      remainderKg: Math.max(0, bar - targetWeightKg),
    };
  }

  const perSideTarget = (targetWeightKg - bar) / 2;
  const plateWeights = Object.keys(inventory.pairsByWeight)
    .map(Number)
    .sort((a, b) => b - a);

  let remaining = perSideTarget;
  const perSide: { weightKg: number; count: number }[] = [];
  const epsilon = 1e-6;

  for (const w of plateWeights) {
    const available = inventory.pairsByWeight[w] ?? 0;
    if (available <= 0) continue;
    const count = Math.min(available, Math.floor((remaining + epsilon) / w));
    if (count > 0) {
      perSide.push({ weightKg: w, count });
      remaining -= count * w;
    }
  }

  const loaded = perSide.reduce((acc, p) => acc + p.weightKg * p.count * 2, 0);
  const totalWeight = bar + loaded;
  const remainderKg = Math.max(0, targetWeightKg - totalWeight);

  return {
    totalWeightKg: totalWeight,
    perSide,
    achievable: remainderKg < epsilon,
    remainderKg: remainderKg < epsilon ? 0 : remainderKg,
  };
}

/** Sensible kilo-gym default inventory. */
export const DEFAULT_INVENTORY_KG: PlateInventory = {
  barWeightKg: 20,
  pairsByWeight: { 25: 2, 20: 2, 15: 1, 10: 2, 5: 2, 2.5: 2, 1.25: 2 },
};
