/**
 * Round to the nearest increment (e.g. 2.5 kg). Used for resolving percentage-based
 * target weights into loadable plate combinations.
 */
export function roundToIncrement(weightKg: number, incrementKg: number): number {
  if (incrementKg <= 0) throw new Error('incrementKg must be > 0');
  return Math.round(weightKg / incrementKg) * incrementKg;
}

/** Always round DOWN to the increment, useful for warm-ups. */
export function floorToIncrement(weightKg: number, incrementKg: number): number {
  if (incrementKg <= 0) throw new Error('incrementKg must be > 0');
  return Math.floor(weightKg / incrementKg) * incrementKg;
}
