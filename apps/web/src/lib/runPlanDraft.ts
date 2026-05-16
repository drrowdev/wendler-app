import type { RunPlannedKind, RunPlanSlot } from '@wendler/domain';

export const EMPTY_RUN_PLAN_DRAFT: RunPlannedKind[] = Array.from(
  { length: 7 },
  () => 'rest',
);

export function slotsToDraft(slots: RunPlanSlot[]): RunPlannedKind[] {
  const draft = [...EMPTY_RUN_PLAN_DRAFT];
  for (const s of slots) {
    if (s.dayOfWeek < 0 || s.dayOfWeek > 6) continue;
    draft[s.dayOfWeek] = s.kind;
  }
  return draft;
}

export function draftToSlots(draft: RunPlannedKind[]): RunPlanSlot[] {
  // Persist only non-rest days — keeps the singleton compact.
  const out: RunPlanSlot[] = [];
  for (let i = 0; i < draft.length; i++) {
    const k = draft[i]!;
    if (k === 'rest') continue;
    // Legacy draft is all-runs; new cardio plan editor will let the
    // user pick modality per slot.
    out.push({ dayOfWeek: i, modality: 'run', kind: k });
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
