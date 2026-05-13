import type { PlateBreakdown, PlateInventory } from './types';

export interface CalculatePlatesOptions {
  /**
   * When set, the calculator first attempts to load the target weight using
   * only plates whose weight is `<= preferredMaxPlateKg`. If that produces an
   * achievable loadout, it's returned. Otherwise, falls back to the full
   * inventory so the user is never blocked from hitting their target.
   *
   * Use case: the user has 25 kg plates available but they're rare in the
   * gym, so they prefer realistic loadouts using only 20 kg or smaller.
   */
  preferredMaxPlateKg?: number;
}

/**
 * Compute the per-side plate loadout for a target weight given the user's plate inventory.
 * Greedy from heaviest to lightest plate. Reports unachievable weight as a remainder.
 *
 * Notes:
 * - Plates are loaded in pairs (one per side). `pairsByWeight` is the *number of pairs*
 *   available for each plate weight.
 * - If the target is below or equal to bar weight, returns no plates.
 * - When `options.preferredMaxPlateKg` is set, prefers loadouts that don't use plates
 *   above that cap (falling back to the full inventory only if necessary).
 */
export function calculatePlates(
  targetWeightKg: number,
  inventory: PlateInventory,
  options?: CalculatePlatesOptions,
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

  const cap = options?.preferredMaxPlateKg;
  // Pass 1: try with cap applied (if any). Pass 2: full inventory fallback.
  if (typeof cap === 'number' && cap > 0) {
    const reduced: PlateInventory = {
      barWeightKg: bar,
      pairsByWeight: Object.fromEntries(
        Object.entries(inventory.pairsByWeight).filter(([w]) => Number(w) <= cap),
      ),
    };
    const capped = greedyLoadout(targetWeightKg, reduced);
    if (capped.achievable) return capped;
  }
  return greedyLoadout(targetWeightKg, inventory);
}

function greedyLoadout(targetWeightKg: number, inventory: PlateInventory): PlateBreakdown {
  const bar = inventory.barWeightKg;
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

/**
 * Pick the correct bar weight for a movement so the plate calculator stays
 * accurate when the lift uses a non-standard implement (e.g. a trap bar that
 * weighs more than the user's Olympic bar). Falls back to the standard bar
 * weight when no equipment-specific value is configured.
 */
export function resolveBarWeightKg(
  equipment: import('./types').EquipmentType | undefined,
  settings: { barWeightKg: number; trapBarWeightKg?: number },
): number {
  if (equipment === 'trap-bar' && typeof settings.trapBarWeightKg === 'number') {
    return settings.trapBarWeightKg;
  }
  return settings.barWeightKg;
}
