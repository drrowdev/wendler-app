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
  useRecentPainFlag,
  useSchedule,
  useSession,
  useSetsForMovement,
  useSetsForSession,
  useSettings,
} from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { PlateView } from '@/components/PlateView';
import { ensureNotificationPermission, RestTimer } from '@/components/RestTimer';
import { RpeButtons } from '@/components/RpeButtons';
import { PainFlagModal, type PainFlagValue } from '@/components/PainFlagModal';
import { SkipMenu } from '@/components/SkipMenu';
import { JokerPrompt } from '@/components/JokerPrompt';

export default function SessionPageWrapper() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <SessionPage />
    </Suspense>
  );
}

interface RestState {
  seconds: number;
  label: string;
  startId: number; // bumped each restart so RestTimer resets
}

interface ExtraJoker {
  weightKg: number;
  reps: number;
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
  const quick = params.get('mode') === 'quick';

  const [activeSessionId, setActiveSessionId] = useState<string | null>(sessionId);
  const [rest, setRest] = useState<RestState | null>(null);
  const [extraJokers, setExtraJokers] = useState<ExtraJoker[]>([]);
  const [showJoker, setShowJoker] = useState(false);
  const [jokerDeclined, setJokerDeclined] = useState(false);
  const [showPainFlag, setShowPainFlag] = useState(false);
  const [quickIndex, setQuickIndex] = useState(0);
  const [notes, setNotes] = useState('');

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
  const painFlag = useRecentPainFlag(movement?.id);

  const supplementalId: SupplementalTemplateId =
    supplementalParam ??
    existing?.supplementalTemplateId ??
    activeBlock?.supplementalTemplate ??
    'none';

  // Hydrate notes from existing session
  useEffect(() => {
    if (existing?.notes && !notes) setNotes(existing.notes);
  }, [existing?.notes]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Ask for notification permission once when entering the session.
  useEffect(() => {
    void ensureNotificationPermission();
  }, []);

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
    const jokers: PrescribedSet[] = extraJokers.map((j) => ({
      kind: 'joker',
      weightKg: j.weightKg,
      reps: j.reps,
    }));
    return [...warmups, ...main, ...supplemental, ...jokers];
  }, [settings, tm, finalWeek, supplementalId, extraJokers]);

  // Auto-prompt joker after AMRAP if RPE is at/below threshold.
  useEffect(() => {
    if (jokerDeclined || extraJokers.length > 0 || !loggedSets || !settings) return;
    const amrap = loggedSets
      .filter((s) => !s.deletedAt && s.isAmrap && s.kind !== 'supplemental')
      .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
    if (!amrap) return;
    const threshold = settings.jokerRpeThreshold ?? 8;
    // Prompt if RPE <= threshold OR if RPE missing AND reps >= prescribed + 3 (heuristic for "felt easy")
    const prescribedReps = prescribed.find((p) => p.isAmrap && p.kind !== 'supplemental')?.reps ?? 1;
    const tooEasy = amrap.rpe != null ? amrap.rpe <= threshold : amrap.reps >= prescribedReps + 3;
    if (tooEasy) setShowJoker(true);
  }, [loggedSets, settings, jokerDeclined, extraJokers.length, prescribed]);

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
  const warmupSets = prescribed.filter((p) => p.kind === 'warmup');
  const mainSets = prescribed.filter((p) => p.kind === 'main' || p.kind === 'amrap');
  const suppSets = prescribed.filter((p) => p.kind === 'supplemental');
  const jokerSets = prescribed.filter((p) => p.kind === 'joker');

  // After-set: start the rest timer.
  const onSetLogged = (kind: PrescribedSet['kind']) => {
    if (!settings?.autoStartRestTimer) return;
    const seconds = settings.restSecondsByKind?.[kind] ?? (kind === 'main' ? 180 : 90);
    setRest({
      seconds,
      label: `Rest · ${kind}`,
      startId: (rest?.startId ?? 0) + 1,
    });
  };

  const acceptJoker = (sets: { weightKg: number; reps: number }[]) => {
    setExtraJokers(sets);
    setShowJoker(false);
  };

  const declineJoker = () => {
    setShowJoker(false);
    setJokerDeclined(true);
  };

  const updateNotes = async (next: string) => {
    setNotes(next);
    if (activeSessionId) {
      await getDb().sessions.update(activeSessionId, { notes: next });
    }
  };

  const onFinish = async () => {
    if (activeSessionId) {
      await getDb().sessions.update(activeSessionId, {
        completedAt: new Date().toISOString(),
        notes: notes.trim() || undefined,
      });
    }
    router.push('/');
  };

  // Quick-Log Mode: show one set at a time, full-screen.
  if (quick) {
    const set = prescribed[quickIndex];
    if (!set) {
      return (
        <div className="space-y-4 text-center">
          <h1 className="text-3xl font-bold tracking-tight">All sets done 💪</h1>
          <p className="text-muted">{liftLabel(lift)} · {finalWeek === 'deload' ? 'Deload' : `Week ${finalWeek}`}</p>
          <button
            onClick={onFinish}
            className="w-full rounded-lg bg-accent py-3 font-semibold text-bg"
          >
            Finish session
          </button>
          <a
            href={`/session?id=${activeSessionId}`}
            className="block text-sm text-muted underline"
          >
            Switch to full view
          </a>
          {rest && (
            <RestTimer
              key={rest.startId}
              initialSeconds={rest.seconds}
              label={rest.label}
              onDismiss={() => setRest(null)}
            />
          )}
        </div>
      );
    }
    const existingForSet = findExisting(loggedSets, set);
    return (
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <button
            onClick={() => setQuickIndex(Math.max(0, quickIndex - 1))}
            disabled={quickIndex === 0}
            className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-xs text-muted">
            {quickIndex + 1} / {prescribed.length}
          </span>
          <button
            onClick={() => setQuickIndex(Math.min(prescribed.length, quickIndex + 1))}
            className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border"
          >
            Next →
          </button>
        </div>
        <SetCard
          index={quickIndex}
          set={set}
          settings={settings!}
          sessionId={activeSessionId}
          movementId={movement?.id ?? ''}
          tmAtTime={tm.trainingMaxKg}
          history={movementHistory ?? []}
          existing={existingForSet}
          big
          onLogged={() => {
            onSetLogged(set.kind);
            // Auto-advance after a short delay so the user sees the green confirm.
            setTimeout(() => setQuickIndex((i) => Math.min(prescribed.length, i + 1)), 350);
          }}
          onSkipped={() => {
            setTimeout(() => setQuickIndex((i) => Math.min(prescribed.length, i + 1)), 200);
          }}
        />
        <a
          href={`/session?id=${activeSessionId}`}
          className="block text-center text-sm text-muted underline"
        >
          Switch to full view
        </a>
        {rest && (
          <RestTimer
            key={rest.startId}
            initialSeconds={rest.seconds}
            label={rest.label}
            onDismiss={() => setRest(null)}
          />
        )}
      </div>
    );
  }

  // Standard view
  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-bold tracking-tight">{liftLabel(lift)}</h1>
          <div className="flex items-center gap-2">
            <a
              href={`/session?id=${activeSessionId ?? ''}&mode=quick`}
              className="rounded-lg bg-card px-2 py-1 text-xs ring-1 ring-border"
            >
              Quick-Log
            </a>
            <span className="text-sm text-muted">
              {finalWeek === 'deload' ? 'Deload' : `Week ${finalWeek}`}
            </span>
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
        {painFlag && (
          <div className="mt-2 flex items-center justify-between rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-sm">
            <span className="text-amber-300">
              ⚠ Caution: {painFlag.area} (severity {painFlag.severity}) flagged recently
            </span>
            <button
              onClick={() => setShowPainFlag(true)}
              className="rounded bg-card px-2 py-1 text-xs ring-1 ring-border"
            >
              Update
            </button>
          </div>
        )}
        {!painFlag && (
          <button
            onClick={() => setShowPainFlag(true)}
            className="mt-2 text-xs text-muted underline"
          >
            + Flag pain / injury
          </button>
        )}
      </header>

      <SectionHeader title="Warm-up" count={warmupSets.length} />
      <ol className="space-y-2">
        {warmupSets.map((set, i) => (
          <SetCard
            key={`w${i}`}
            index={i}
            set={set}
            settings={settings!}
            sessionId={activeSessionId}
            movementId={movement?.id ?? ''}
            tmAtTime={tm.trainingMaxKg}
            history={movementHistory ?? []}
            existing={findExisting(loggedSets, set)}
            onLogged={() => onSetLogged(set.kind)}
          />
        ))}
      </ol>

      <SectionHeader title="Working sets" count={mainSets.length} />
      <ol className="space-y-2">
        {mainSets.map((set, i) => (
          <SetCard
            key={`m${i}`}
            index={i}
            set={set}
            settings={settings!}
            sessionId={activeSessionId}
            movementId={movement?.id ?? ''}
            tmAtTime={tm.trainingMaxKg}
            history={movementHistory ?? []}
            existing={findExisting(loggedSets, set)}
            onLogged={() => onSetLogged(set.kind)}
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
              <SetCard
                key={`s${i}`}
                index={i}
                set={set}
                settings={settings!}
                sessionId={activeSessionId}
                movementId={movement?.id ?? ''}
                tmAtTime={tm.trainingMaxKg}
                history={movementHistory ?? []}
                existing={findExisting(loggedSets, set)}
                onLogged={() => onSetLogged(set.kind)}
              />
            ))}
          </ol>
        </>
      )}

      {jokerSets.length > 0 && (
        <>
          <SectionHeader title="Joker sets" count={jokerSets.length} />
          <ol className="space-y-2">
            {jokerSets.map((set, i) => (
              <SetCard
                key={`j${i}`}
                index={i}
                set={set}
                settings={settings!}
                sessionId={activeSessionId}
                movementId={movement?.id ?? ''}
                tmAtTime={tm.trainingMaxKg}
                history={movementHistory ?? []}
                existing={findExisting(loggedSets, set)}
                onLogged={() => onSetLogged(set.kind)}
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

      {/* Session notes */}
      <section className="rounded-xl border border-border bg-card p-3">
        <label className="block">
          <span className="text-xs uppercase tracking-wide text-muted">Session notes</span>
          <textarea
            value={notes}
            onChange={(e) => updateNotes(e.target.value)}
            rows={3}
            placeholder="How did it feel? Anything to remember next time."
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
          />
        </label>
      </section>

      <button
        onClick={onFinish}
        className="mt-6 w-full rounded-lg bg-card py-3 ring-1 ring-border"
      >
        Done
      </button>

      {rest && (
        <RestTimer
          key={rest.startId}
          initialSeconds={rest.seconds}
          label={rest.label}
          onDismiss={() => setRest(null)}
        />
      )}

      {showJoker && (
        <JokerPrompt
          topAmrapWeightKg={
            loggedSets
              ?.filter((s) => !s.deletedAt && s.isAmrap && s.kind !== 'supplemental')
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0]?.weightKg ?? tm.trainingMaxKg * 0.95
          }
          amrapReps={
            loggedSets
              ?.filter((s) => !s.deletedAt && s.isAmrap && s.kind !== 'supplemental')
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0]?.reps ?? 0
          }
          rpe={
            loggedSets
              ?.filter((s) => !s.deletedAt && s.isAmrap && s.kind !== 'supplemental')
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0]?.rpe
          }
          roundingKg={settings?.roundingKg ?? 2.5}
          onAccept={acceptJoker}
          onDecline={declineJoker}
        />
      )}

      {showPainFlag && (
        <PainFlagModal
          initial={painFlag as PainFlagValue | undefined}
          onCancel={() => setShowPainFlag(false)}
          onSave={async (val) => {
            // Tag the flag onto the most recent set for this movement (or create a marker note set).
            if (!activeSessionId || !movement?.id) {
              setShowPainFlag(false);
              return;
            }
            const recent = loggedSets
              ?.filter((s) => !s.deletedAt && s.movementId === movement.id)
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
            if (recent) {
              await getDb().sets.put({ ...recent, painFlag: val });
            } else {
              // No sets yet — create a marker.
              await getDb().sets.add({
                id: nanoid(),
                sessionId: activeSessionId,
                movementId: movement.id,
                performedAt: new Date().toISOString(),
                weightKg: 0,
                reps: 0,
                kind: 'main',
                skipped: true,
                skipReason: 'pain',
                painFlag: val,
              });
            }
            setShowPainFlag(false);
          }}
          onClear={async () => {
            // Clear by amending the most recent flagged set.
            const flagged = loggedSets
              ?.filter((s) => !s.deletedAt && s.movementId === movement?.id && s.painFlag)
              .sort((a, b) => (a.performedAt < b.performedAt ? 1 : -1))[0];
            if (flagged) {
              await getDb().sets.put({ ...flagged, painFlag: undefined });
            }
            setShowPainFlag(false);
          }}
        />
      )}
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

function findExisting(
  loggedSets: SetRecord[] | undefined,
  set: PrescribedSet,
): SetRecord | undefined {
  return loggedSets?.find(
    (s) =>
      !s.deletedAt &&
      Math.round(s.weightKg * 100) === Math.round(set.weightKg * 100) &&
      s.kind === set.kind,
  );
}

function SetCard({
  index,
  set,
  settings,
  sessionId,
  movementId,
  tmAtTime,
  history,
  existing,
  big,
  onLogged,
  onSkipped,
}: {
  index: number;
  set: PrescribedSet;
  settings: NonNullable<ReturnType<typeof useSettings>>;
  sessionId: string | null;
  movementId: string;
  tmAtTime: number;
  history: SetRecord[];
  existing: SetRecord | undefined;
  big?: boolean;
  onLogged?: () => void;
  onSkipped?: () => void;
}) {
  const plates = calculatePlates(set.weightKg, {
    barWeightKg: settings.barWeightKg,
    pairsByWeight: settings.pairsByWeight,
  });
  const [reps, setReps] = useState<string>(existing ? String(existing.reps) : String(set.reps));
  const [weight, setWeight] = useState<string>(
    existing ? String(existing.weightKg) : String(set.weightKg),
  );
  const [rpe, setRpe] = useState<number | undefined>(existing?.rpe);
  const [saving, setSaving] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const done = !!existing && !existing.skipped;
  const skipped = !!existing?.skipped;

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
      rpe,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    setSaving(false);
    onLogged?.();
  };

  const onSkip = async (reason: 'pain' | 'fatigue' | 'time' | 'equipment' | 'other') => {
    if (!sessionId || !movementId) return;
    const record: SetRecord = {
      id: existing?.id ?? nanoid(),
      sessionId,
      movementId,
      performedAt: new Date().toISOString(),
      weightKg: 0,
      reps: 0,
      kind: set.kind,
      isAmrap: set.isAmrap,
      percentOfTm: set.percentOfTm,
      trainingMaxKgAtTime: tmAtTime,
      skipped: true,
      skipReason: reason,
      ...(existing && { amendsSetId: existing.amendsSetId ?? existing.id }),
    };
    await getDb().sets.put(record);
    setShowSkip(false);
    onSkipped?.();
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
        skipped
          ? 'border-amber-500/60 bg-amber-500/5'
          : done
            ? 'border-emerald-700/60 bg-emerald-900/10'
            : 'border-border bg-card'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-xs uppercase tracking-wide text-muted">
            Set {index + 1} · {kindLabel[set.kind]}
            {set.percentOfTm && ` · ${(set.percentOfTm * 100).toFixed(0)}%`}
          </span>
          <div className={`font-semibold ${big ? 'text-4xl' : 'text-xl'}`}>
            {fmtKg(set.weightKg)} × {set.reps}
            {set.isAmrap && <span className="text-accent">+</span>}
          </div>
          <div className="mt-1">
            <PlateView breakdown={plates} />
          </div>
        </div>
        {!skipped && (
          <button
            onClick={() => setShowSkip(true)}
            className="text-xs text-muted underline"
            aria-label="Skip this set"
          >
            Skip
          </button>
        )}
      </div>

      {skipped && (
        <div className="mt-2 text-xs text-amber-300">
          Skipped ({existing?.skipReason ?? 'no reason'})
        </div>
      )}

      {!skipped && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div>
              <span className="block text-xs text-muted">Weight (kg)</span>
              <div
                className={`mt-1 flex items-stretch overflow-hidden rounded-lg border border-border bg-bg ${big ? 'text-2xl' : ''}`}
              >
                <button
                  onClick={() => adjust(-2.5)}
                  className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="decimal"
                  step={2.5}
                  value={weight}
                  onChange={(e) => setWeight(e.target.value)}
                  className={`w-full bg-transparent px-2 py-2 text-center ${big ? 'text-3xl' : 'text-lg'}`}
                />
                <button
                  onClick={() => adjust(2.5)}
                  className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
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
                  className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                >
                  −
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  value={reps}
                  onChange={(e) => setReps(e.target.value)}
                  className={`w-full bg-transparent px-2 py-2 text-center ${big ? 'text-3xl' : 'text-lg'}`}
                />
                <button
                  onClick={() => setReps(String(parseInt(reps || '0', 10) + 1))}
                  className={`px-3 font-semibold text-muted active:bg-card ${big ? 'text-3xl' : 'text-xl'}`}
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {set.kind !== 'warmup' && (
            <div className="mt-3">
              <RpeButtons value={rpe} onChange={setRpe} compact />
            </div>
          )}

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
            className={`mt-3 w-full rounded-lg font-semibold ${
              big ? 'py-4 text-lg' : 'py-2 text-sm'
            } ${done ? 'bg-emerald-600 text-white' : 'bg-accent text-bg'}`}
          >
            {done ? 'Update' : 'Log set'}
          </button>
        </>
      )}

      {showSkip && <SkipMenu onSkip={onSkip} onCancel={() => setShowSkip(false)} />}
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
    .filter((s) => !s.deletedAt && !s.skipped && s.isAmrap && s.kind !== 'supplemental')
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
      note: `From AMRAP ${amrapLogged.weightKg}×${amrapLogged.reps}${amrapLogged.rpe != null ? ` @ RPE ${amrapLogged.rpe}` : ''}`,
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
        {amrapLogged.rpe != null && (
          <span className="text-muted"> · RPE {amrapLogged.rpe}</span>
        )}
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
