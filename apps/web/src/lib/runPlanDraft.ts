import type { CardioModality, RunPlannedKind, RunPlanSlot } from '@wendler/domain';

/**
 * Per-weekday draft entry used by the cardio-plan editor. The legacy
 * RunPlannedKind[] shape didn't carry modality; we now keep modality
 * alongside kind so the user can pick "Wednesday = Z2 bike" or
 * "Saturday = long run" cleanly.
 *
 * `rest` is its own kind; modality is meaningless for it (stored as
 * 'run' by convention, never surfaced).
 */
export interface CardioDraftDay {
  kind: RunPlannedKind;
  modality: CardioModality;
}

export const EMPTY_RUN_PLAN_DRAFT: CardioDraftDay[] = Array.from({ length: 7 }, () => ({
  kind: 'rest',
  modality: 'run' as const,
}));

export function slotsToDraft(slots: RunPlanSlot[]): CardioDraftDay[] {
  const draft: CardioDraftDay[] = [...EMPTY_RUN_PLAN_DRAFT.map((d) => ({ ...d }))];
  for (const s of slots) {
    if (s.dayOfWeek < 0 || s.dayOfWeek > 6) continue;
    draft[s.dayOfWeek] = { kind: s.kind, modality: s.modality ?? 'run' };
  }
  return draft;
}

export function draftToSlots(draft: CardioDraftDay[]): RunPlanSlot[] {
  // Persist only non-rest days — keeps the singleton compact.
  const out: RunPlanSlot[] = [];
  for (let i = 0; i < draft.length; i++) {
    const d = draft[i]!;
    if (d.kind === 'rest') continue;
    out.push({ dayOfWeek: i, modality: d.modality, kind: d.kind });
  }
  return out;
}

export function startOfIsoWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  const day = out.getDay() || 7;
  if (day !== 1) out.setDate(out.getDate() - (day - 1));
  return out;
}
