'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { nanoid } from 'nanoid';
import {
  buildMainSets,
  buildSupplementalSets,
  buildWarmupSets,
  calculatePlates,
  detectPrs,
  epley1RM,
  suggestNewTrainingMax,
  SUPPLEMENTAL_TEMPLATES,
  type PrescribedSet,
  type SupplementalTemplateId,
  type WendlerWeek,
} from '@wendler/domain';
import type { MainLift, SetRecord } from '@wendler/db-schema';
import { fmtDate, fmtKg, liftLabel } from '@/lib/format';
import {
  useActiveBlock,
  useCurrentTrainingMax,
  useMainLiftMovement,
  useSchedule,
  useSession,
  useSetsForMovement,
  useSetsForSession,
  useSettings,
} from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { PlateView } from '@/components/PlateView';

export default function SessionPageWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <SessionPage />
    </Suspense>
  );
}

function SessionPage() {
  const params = useSearchParams();
  const router = useRouter();
  const liftParam = (params.get('lift') as MainLift | null) ?? null;
  const weekRaw = params.get('week');
  const week: WendlerWeek | null =
    weekRaw === 'deload'
      ? 'deload'
      : weekRaw === '1' || weekRaw === '2' || weekRaw === '3'
        ? (Number(weekRaw) as 1 | 2 | 3)
        : null;
  const sessionId = params.get('id');
  const supplementalParam = params.get('supplemental') as SupplementalTemplateId | null;

  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId);

  const settings = useSettings();
  const existing = useSession(activeSessionId ?? undefined);
  const activeBlock = useActiveBlock();
  const schedule = useSchedule();
  const lift: MainLift | null = liftParam ?? existing?.mainLift ?? null;
  const finalWeek: WendlerWeek | null = week ?? existing?.week ?? null;
  const tm = useCurrentTrainingMax(lift ?? 'squat');
  const movement = useMainLiftMovement(lift ?? 'squat');
  const loggedSets = useSetsForSession(activeSessionId ?? undefined);
  const movementHistory = useSetsForMovement(movement?.id ?? '');

  const supplementalId: SupplementalTemplateId =
    supplementalParam ?? existing?.supplementalTemplateId ?? activeBlock?.supplementalTemplate ?? 'none';

  // Auto-create session if we have lift+week but no session id
  useEffect(() => {
    if (activeSessionId || !lift || !finalWeek || !settings) return;
    const id = nanoid();
    const dayIndex = schedule?.dayOrder.indexOf(lift) ?? 0;
    void getDb()
      .sessions.add({
        id,
        performedAt: new Date().toISOString(),
        mainLift: lift,
        week: finalWeek,
        blockId: activeBlock?.id,
        dayIndex,
        supplementalTemplateId: supplementalId,
      })
      .then(() => setActiveSessionId(id));
  }, [activeSessionId, lift, finalWeek, settings, activeBlock?.id, schedule, supplementalId]);

  const prescribed = useMemo<PrescribedSet[]>(() => {
    if (!settings || !tm || !finalWeek) return [];
    const main = buildMainSets({
      trainingMaxKg: tm.trainingMaxKg,
      week: finalWeek,
      roundingKg: settings.roundingKg,
    });
    const topWeight = main[main.length - 1]?.weightKg ?? 0;
    const warmups = buildWarmupSets(topWeight, settings.roundingKg, {
      percents: settings.warmupPercents,
      reps: settings.warmupReps,
    });
    const supplemental = buildSupplementalSets({
      templateId: supplementalId,
      trainingMaxKg: tm.trainingMaxKg,
      week: finalWeek,
      roundingKg: settings.roundingKg,
    });
    return [...warmups, ...main, ...supplemental];
  }, [settings, tm, finalWeek, supplementalId]);

  if (!lift) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">Session</h1>
        <p className="text-sm text-muted">Pick a lift and week from the home screen.</p>
      </div>
    );
  }

  if (!tm) {
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight">{liftLabel(lift)}</h1>
        <p className="text-sm text-muted">
          You haven&apos;t set a Training Max for this lift yet.{' '}
          <a href="/program/setup" className="text-accent underline">
            Set it up
          </a>{' '}
          first.
        </p>
      </div>
    );
  }

  const supplementalName = SUPPLEMENTAL_TEMPLATES.find((s) => s.id === supplementalId)?.name;

  // Group prescribed sets visually
  const warmupSets = prescribed.filter((p) => p.kind === 'warmup');
  const mainSets = prescribed.filter((p) => p.kind === 'main' || p.kind === 'amrap');
  const suppSets = prescribed.filter((p) => p.kind === 'supplemental');

  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-bold tracking-tight">{liftLabel(lift)}</h1>
          <div className="text-sm text-muted">
            {finalWeek === 'deload' ? 'Deload' : `Week ${finalWeek}`}
          </div>
        </div>
        <p className="text-sm text-muted">
          TM <span className="font-mono text-fg">{fmtKg(tm.trainingMaxKg)}</span>
          {activeBlock && (
            <>
              {' '}· {activeBlock.name}{' '}
              <span className="rounded bg-card px-1.5 py-0.5 text-xs ring-1 ring-border">
                {activeBlock.kind}
              </span>
            </>
          )}{' '}
          · {fmtDate(existing?.performedAt ?? new Date().toISOString())}
        </p>
      </header>

      <SectionHeader title="Warm-up" count={warmupSets.length} />
      <ol className="space-y-2">
        {warmupSets.map((set, i) => (
          <SetRow
            key={`w${i}`}
            index={i}
            set={set}
            settings={settings!}
            sessionId={activeSessionId}
            movementId={movement?.id ?? ''}
            tmAtTime={tm.trainingMaxKg}
            history={movementHistory ?? []}
            existing={findExisting(loggedSets, set)}
          />
        ))}
      </ol>

      <SectionHeader title="Working sets" count={mainSets.length} />
      <ol className="space-y-2">
        {mainSets.map((set, i) => (
          <SetRow
            key={`m${i}`}
            index={i}
            set={set}
            settings={settings!}
            sessionId={activeSessionId}
            movementId={movement?.id ?? ''}
            tmAtTime={tm.trainingMaxKg}
            history={movementHistory ?? []}
            existing={findExisting(loggedSets, set)}
          />
        ))}
      </ol>

      {suppSets.length > 0 && (
        <>
          <SectionHeader
            title={`Supplemental — ${supplementalName ?? supplementalId}`}
            count={suppSets.length}
          />
          <ol className="space-y-2">
            {suppSets.map((set, i) => (
              <SetRow
                key={`s${i}`}
                index={i}
                set={set}
                settings={settings!}
                sessionId={activeSessionId}
                movementId={movement?.id ?? ''}
                tmAtTime={tm.trainingMaxKg}
                history={movementHistory ?? []}
                existing={findExisting(loggedSets, set)}
              />
            ))}
          </ol>
        </>
      )}

      <AmrapAnalysis
        lift={lift}
        prescribed={prescribed}
        logged={loggedSets ?? []}
        currentTmKg={tm.trainingMaxKg}
      />

      <button
        onClick={async () => {
          if (activeSessionId) {
            await getDb().sessions.update(activeSessionId, {
              completedAt: new Date().toISOString(),
            });
          }
          router.push('/');
        }}
        className="mt-6 w-full rounded-lg bg-card py-3 ring-1 ring-border"
      >
        Done
      </button>
    </div>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  if (count === 0) return null;
  return (
    <h2 className="mt-4 text-sm font-semibold uppercase tracking-wide text-muted">
      {title}{' '}
      <span className="ml-1 rounded bg-card px-1.5 py-0.5 text-xs text-fg ring-1 ring-border">
        {count}
      </span>
    </h2>
  );
}

function findExisting(loggedSets: SetRecord[] | undefined, set: PrescribedSet): SetRecord | undefined {
  return loggedSets?.find(
    (s) =>
      !s.deletedAt &&
      Math.round(s.weightKg * 100) === Math.round(set.weightKg * 100) &&
      s.kind === set.kind,
  );
}

function SetRow({
  index,
  set,
  settings,
  sessionId,
  movementId,
  tmAtTime,
  history,
  existing,
}: {
  index: number;
  set: PrescribedSet;
  settings: NonNullable<ReturnType<typeof useSettings>>;
  sessionId: string | null;
  movementId: string;
  tmAtTime: number;
  history: SetRecord[];
  existing: SetRecord | undefined;
}) {
  const plates = calculatePlates(set.weightKg, {
    barWeightKg: settings.barWeightKg,
    pairsByWeight: settings.pairsByWeight,
  });
  const [reps, setReps] = useState<string>(existing ? String(existing.reps) : String(set.reps));
  const [weight, setWeight] = useState<string>(
    existing ? String(existing.weightKg) : String(set.weightKg),
  );
  const [saving, setSaving] = useState(false);
  const done = !!existing;

  const onSave = async () => {
    if (!sessionId || !movementId) return;
    setSaving(true);
    const w = parseFloat(weight);
    const r = parseInt(reps, 10);
    if (!isFinite(w) || !isFinite(r) || w <= 0 || r <= 0) {
      setSaving(false);
      return;
    }
    const record: SetRecord = {
      id: existing?.id ?? nanoid(),
      sessionId,
      movementId,
      performedAt: new Date().toISOString(),
      weightKg: w,
      reps: r,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    setSaving(false);
  };

  const adjust = (delta: number) => {
    const w = parseFloat(weight);
    if (!isFinite(w)) return;
    setWeight(String(Math.max(0, w + delta)));
  };

  const previewPrs =
    isFinite(parseFloat(weight)) && isFinite(parseInt(reps, 10))
      ? detectPrs(
          { weightKg: parseFloat(weight), reps: parseInt(reps, 10) },
          { sets: history.filter((s) => !s.deletedAt && s.id !== existing?.id) },
        )
      : [];

  const newE1rm =
    set.isAmrap && isFinite(parseFloat(weight)) && isFinite(parseInt(reps, 10))
      ? epley1RM(parseFloat(weight), parseInt(reps, 10))
      : 0;

  const kindLabel: Record<PrescribedSet['kind'], string> = {
    warmup: 'Warm-up',
    main: 'Working',
    amrap: 'AMRAP',
    supplemental: 'Supplemental',
    assistance: 'Assistance',
    joker: 'Joker',
  };

  return (
    <li
      className={`rounded-xl border p-3 ${
        done ? 'border-emerald-700/60 bg-emerald-900/10' : 'border-border bg-card'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-xs uppercase tracking-wide text-muted">
            Set {index + 1} · {kindLabel[set.kind]}
            {set.percentOfTm && ` · ${(set.percentOfTm * 100).toFixed(0)}%`}
          </span>
          <div className="text-xl font-semibold">
            {fmtKg(set.weightKg)} × {set.reps}
            {set.isAmrap && <span className="text-accent">+</span>}
          </div>
          <div className="mt-1">
            <PlateView breakdown={plates} />
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <span className="block text-xs text-muted">Weight (kg)</span>
          <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg">
            <button
              onClick={() => adjust(-2.5)}
              className="px-3 text-xl font-semibold text-muted active:bg-card"
            >
              −
            </button>
            <input
              type="number"
              inputMode="decimal"
              step={2.5}
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              className="w-full bg-transparent px-2 py-2 text-center text-lg"
            />
            <button
              onClick={() => adjust(2.5)}
              className="px-3 text-xl font-semibold text-muted active:bg-card"
            >
              +
            </button>
          </div>
        </div>
        <div>
          <span className="block text-xs text-muted">Reps</span>
          <div className="mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg">
            <button
              onClick={() => setReps(String(Math.max(0, parseInt(reps || '0', 10) - 1)))}
              className="px-3 text-xl font-semibold text-muted active:bg-card"
            >
              −
            </button>
            <input
              type="number"
              inputMode="numeric"
              value={reps}
              onChange={(e) => setReps(e.target.value)}
              className="w-full bg-transparent px-2 py-2 text-center text-lg"
            />
            <button
              onClick={() => setReps(String(parseInt(reps || '0', 10) + 1))}
              className="px-3 text-xl font-semibold text-muted active:bg-card"
            >
              +
            </button>
          </div>
        </div>
      </div>

      {previewPrs.length > 0 && set.kind !== 'warmup' && (
        <div className="mt-2 flex flex-wrap gap-1">
          {previewPrs.map((pr) => (
            <span
              key={pr.kind}
              className="rounded bg-amber-500/20 px-2 py-0.5 text-xs text-amber-300"
            >
              ⭐ {pr.kind === 'reps-at-weight' ? 'rep' : pr.kind} PR
            </span>
          ))}
        </div>
      )}

      {set.isAmrap && newE1rm > 0 && (
        <div className="mt-2 text-xs text-muted">
          e1RM: <span className="font-mono text-fg">{newE1rm.toFixed(1)} kg</span>
        </div>
      )}

      <button
        onClick={onSave}
        disabled={saving}
        className={`mt-3 w-full rounded-lg py-2 text-sm font-semibold ${
          done ? 'bg-emerald-600 text-white' : 'bg-accent text-bg'
        }`}
      >
        {done ? 'Update' : 'Log set'}
      </button>
    </li>
  );
}

function AmrapAnalysis({
  lift,
  prescribed,
  logged,
  currentTmKg,
}: {
  lift: MainLift;
  prescribed: PrescribedSet[];
  logged: SetRecord[];
  currentTmKg: number;
}) {
  const settings = useSettings();
  const amrapTarget = prescribed.find((s) => s.isAmrap && s.kind !== 'supplemental');
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(false);

  if (!amrapTarget) return null;
  const amrapLogged = logged
    .filter((s) => !s.deletedAt && s.isAmrap && s.kind !== 'supplemental')
    .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
  if (!amrapLogged) return null;

  const e1rm = epley1RM(amrapLogged.weightKg, amrapLogged.reps);
  const newTm = suggestNewTrainingMax(amrapLogged.weightKg, amrapLogged.reps);
  const delta = newTm - currentTmKg;
  const tmPercent = settings?.defaultTmPercent ?? 0.85;

  const onApply = async () => {
    setApplying(true);
    await getDb().trainingMaxes.add({
      id: nanoid(),
      lift,
      trainingMaxKg: newTm,
      tmPercent,
      createdAt: new Date().toISOString(),
      source: 'amrap-suggestion',
      note: `From AMRAP ${amrapLogged.weightKg}×${amrapLogged.reps}`,
    });
    setApplying(false);
    setApplied(true);
  };

  return (
    <section className="rounded-xl border border-accent/40 bg-accent/5 p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-accent">
        AMRAP analysis
      </h2>
      <p className="mt-1 text-sm">
        {amrapLogged.weightKg} kg × <span className="font-bold">{amrapLogged.reps}</span> reps
      </p>
      <p className="mt-1 text-sm">
        Estimated 1RM: <span className="font-mono">{e1rm.toFixed(1)} kg</span>
      </p>
      <p className="mt-1 text-sm">
        Suggested new TM (90% e1RM): <span className="font-mono">{newTm.toFixed(1)} kg</span>{' '}
        <span className={delta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
          ({delta >= 0 ? '+' : ''}
          {delta.toFixed(1)} kg)
        </span>
      </p>
      <button
        onClick={onApply}
        disabled={applying || applied}
        className="mt-3 w-full rounded-lg bg-accent py-2 font-semibold text-bg disabled:opacity-50"
      >
        {applied ? 'New TM applied ✓' : `Apply new TM (${newTm.toFixed(1)} kg)`}
      </button>
    </section>
  );
}
