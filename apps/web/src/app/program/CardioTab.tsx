'use client';

import { useEffect, useMemo, useState } from 'react';
import { useAllCardio, useRunPlan } from '@/lib/hooks';
import { rematchAllCardioAgainstPlan, saveRunPlan } from '@/lib/runPlan';
import {
  EMPTY_RUN_PLAN_DRAFT,
  draftToSlots,
  slotsToDraft,
  startOfIsoWeek,
} from '@/lib/runPlanDraft';
import { LinkActivityPicker } from '@/components/LinkActivityPicker';
import {
  RUN_DAY_LABELS,
  RUN_PLANNED_KINDS,
  planEmoji,
  planLabel,
  toLocalYmd,
  type RunPlannedKind,
} from '@wendler/domain';

export default function CardioTab() {
  const plan = useRunPlan();
  const allCardio = useAllCardio();
  const [draft, setDraft] = useState<RunPlannedKind[]>(EMPTY_RUN_PLAN_DRAFT);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [linkTarget, setLinkTarget] = useState<{ slotDate: string; slotKind: RunPlannedKind } | null>(null);

  // Hydrate the local draft from the persisted singleton on first load /
  // when the singleton arrives via sync.
  useEffect(() => {
    if (plan?.slots) setDraft(slotsToDraft(plan.slots));
  }, [plan?.updatedAt, plan?.slots]);

  const summary = useMemo(() => {
    const counts: Partial<Record<RunPlannedKind, number>> = {};
    for (const k of draft) counts[k] = (counts[k] ?? 0) + 1;
    const parts: string[] = [];
    for (const k of RUN_PLANNED_KINDS) {
      const n = counts[k.id];
      if (n && k.id !== 'rest') parts.push(`${n}× ${k.label.split(' ')[0]}`);
    }
    return parts.join(' · ') || 'No runs planned yet.';
  }, [draft]);

  const thisWeek = useMemo(() => {
    const monday = startOfIsoWeek(new Date());
    const todayYmd = toLocalYmd(new Date());
    const persistedSlots = plan?.slots ?? [];
    const fulfilledByYmd = new Set<string>();
    const performedRunYmds = new Set<string>();
    for (const c of allCardio ?? []) {
      if (c.planScheduledDate) fulfilledByYmd.add(c.planScheduledDate);
      if (c.modality === 'run') {
        performedRunYmds.add(toLocalYmd(new Date(c.performedAt)));
      }
    }
    return persistedSlots
      .filter((s) => s.kind !== 'rest')
      .map((s) => {
        const d = new Date(monday);
        d.setDate(monday.getDate() + s.dayOfWeek);
        const ymd = toLocalYmd(d);
        const done =
          fulfilledByYmd.has(ymd) ||
          (performedRunYmds.has(ymd) && !fulfilledByYmd.has(ymd));
        const isPast = ymd < todayYmd;
        return { ymd, slot: s, done, isPast };
      });
  }, [plan?.slots, allCardio]);

  function update(i: number, kind: RunPlannedKind) {
    setDraft((prev) => prev.map((d, idx) => (idx === i ? kind : d)));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      await saveRunPlan({ slots: draftToSlots(draft) });
      const n = await rematchAllCardioAgainstPlan();
      setMsg(`Plan saved. Re-matched ${n} cardio ${n === 1 ? 'entry' : 'entries'}.`);
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        The recurring shape of your training week. Imported Strava runs are
        auto-tagged with the slot they satisfy (day-of-week + run name).
        Targets, durations and pace come from Runna — no need to duplicate
        them here.
      </p>

      <div className="rounded-lg border border-border bg-card p-3 text-sm">
        <span className="text-muted">This week:</span> {summary}
      </div>

      <div className="space-y-2">
        {draft.map((kind, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
          >
            <div className="font-medium">{RUN_DAY_LABELS[i]}</div>
            <select
              value={kind}
              onChange={(e) => update(i, e.target.value as RunPlannedKind)}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
            >
              {RUN_PLANNED_KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.emoji} {k.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-bg disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save plan'}
        </button>
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>

      {thisWeek.length > 0 && (
        <section className="space-y-2">
          <header className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold">This week&apos;s runs</h2>
            <span className="text-xs text-muted">
              {thisWeek.filter((r) => r.done).length} / {thisWeek.length} done
            </span>
          </header>
          <p className="text-xs text-muted">
            Tap <span className="text-fg">Link activity</span> on a missed slot
            to attach an activity that was performed on a different day.
          </p>
          <ul className="space-y-1.5">
            {thisWeek.map((row) => (
              <li
                key={row.ymd}
                className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted">
                    {RUN_DAY_LABELS[row.slot.dayOfWeek]}
                  </span>
                  <span className="text-sm">
                    {planEmoji(row.slot.kind)} {planLabel(row.slot.kind)}
                  </span>
                  {row.done ? (
                    <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
                      ✓ done
                    </span>
                  ) : row.isPast ? (
                    <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300 ring-1 ring-rose-500/30">
                      missed
                    </span>
                  ) : (
                    <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300 ring-1 ring-sky-500/30">
                      planned
                    </span>
                  )}
                </div>
                {!row.done && (
                  <button
                    type="button"
                    onClick={() =>
                      setLinkTarget({ slotDate: row.ymd, slotKind: row.slot.kind })
                    }
                    className="rounded-md border border-border px-2.5 py-1 text-xs text-muted hover:text-fg"
                  >
                    Link activity
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {linkTarget && (
        <LinkActivityPicker
          slotDate={linkTarget.slotDate}
          slotKind={linkTarget.slotKind}
          onClose={() => setLinkTarget(null)}
        />
      )}
    </div>
  );
}
