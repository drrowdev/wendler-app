import type { MainLift } from '@wendler/db-schema';

export const MAIN_LIFTS: { key: MainLift; label: string }[] = [
  { key: 'press', label: 'Overhead Press' },
  { key: 'deadlift', label: 'Deadlift' },
  { key: 'bench', label: 'Bench Press' },
  { key: 'squat', label: 'Squat' },
];

export function liftLabel(lift: MainLift): string {
  return MAIN_LIFTS.find((l) => l.key === lift)?.label ?? lift;
}

/**
 * Tight 2–3 char abbreviation for use in space-constrained UI like the
 * mobile calendar cells, where a full "Overhead Press · Bench Press"
 * gets truncated to two letters and becomes useless.
 */
export const SHORT_LIFT_LABEL: Record<MainLift, string> = {
  press: 'OHP',
  bench: 'BP',
  squat: 'SQ',
  deadlift: 'DL',
};

export function liftLabelShort(lift: MainLift): string {
  return SHORT_LIFT_LABEL[lift] ?? lift;
}

/**
 * Date formatting follows Finnish convention: D.M.YYYY (no leading zeros).
 *  - `fmtDate` for full dates ("3.5.2026")
 *  - `fmtDayMonth` for compact axis labels ("3.5")
 *  - `fmtWeekBucket` for ISO week buckets like "2026-W18" -> "W18"
 */
export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

export function fmtDayMonth(iso: string): string {
  // Parse YYYY-MM-DD directly to avoid timezone shifts that can flip the day.
  const [, m, d] = iso.split('-');
  return `${parseInt(d ?? '0', 10)}.${parseInt(m ?? '0', 10)}`;
}

export function fmtWeekBucket(bucket: string): string {
  return bucket.replace(/^\d{4}-/, '');
}

export function fmtKg(kg: number): string {
  return kg % 1 === 0 ? `${kg} kg` : `${kg.toFixed(2).replace(/\.?0+$/, '')} kg`;
}
