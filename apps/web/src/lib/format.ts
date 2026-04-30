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

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function fmtKg(kg: number): string {
  return kg % 1 === 0 ? `${kg} kg` : `${kg.toFixed(2).replace(/\.?0+$/, '')} kg`;
}
