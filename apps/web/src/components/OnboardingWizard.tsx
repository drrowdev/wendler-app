'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import type { MainLift, Race, RaceKind, RacePriority } from '@wendler/db-schema';
import { useBlocks, useSchedule } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { kickSync } from '@/lib/sync';
import {
  inferDistanceKm,
  ONBOARDING_INITIAL,
  nextOnboardingStep,
  parseTrainingMaxInput,
  shouldOpenOnboarding,
  type OnboardingPersisted,
} from '@wendler/domain';

type Units = 'kg' | 'lb';

interface TmInputs {
  squat: string;
  bench: string;
  deadlift: string;
  press: string;
}

interface RaceInputs {
  name: string;
  date: string;
  kind: RaceKind;
  priority: RacePriority;
}

type Step = OnboardingPersisted['step'];

type PersistedState = OnboardingPersisted;

const LS_KEY = 'wendler-onboarding-v1';

function loadState(): PersistedState {
  if (typeof window === 'undefined') {
    return { ...ONBOARDING_INITIAL };
  }
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) {
      return { ...ONBOARDING_INITIAL };
    }
    return JSON.parse(raw) as PersistedState;
  } catch {
    return { ...ONBOARDING_INITIAL };
  }
}

function saveState(s: PersistedState) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {}
}

const PRESS_DAY_4: MainLift[] = ['press', 'deadlift', 'bench', 'squat'];
const PAIRED_3DAY: MainLift[][] = [
  ['squat', 'bench'],
  ['deadlift', 'press'],
  ['squat', 'press'],
];

export function OnboardingWizard({
  forceOpen,
  onClose,
}: {
  forceOpen?: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [persisted, setPersisted] = useState<PersistedState>(loadState);
  const [units, setUnits] = useState<Units>('kg');
  const [tms, setTms] = useState<TmInputs>({ squat: '', bench: '', deadlift: '', press: '' });
  const [scheduleKind, setScheduleKind] = useState<'4day' | '3day-paired'>('4day');
  const [race, setRace] = useState<RaceInputs>({
    name: '',
    date: '',
    kind: 'half-marathon',
    priority: 'B',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const setStep = (step: Step) => {
    const next = { ...persisted, step };
    setPersisted(next);
    saveState(next);
  };

  // ESC defers (re-fires next visit). Focus first input on mount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    // Focus the dialog so screen readers announce it.
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-advance past steps the user already completed (resumability).
  useEffect(() => {
    if (forceOpen) return;
    const target = nextOnboardingStep(persisted);
    if (target !== persisted.step) {
      setStep(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveTms = async (skip: boolean) => {
    setError(undefined);
    setBusy(true);
    try {
      if (!skip) {
        const parsed: Record<MainLift, number> = { squat: 0, bench: 0, deadlift: 0, press: 0 };
        for (const lift of Object.keys(parsed) as MainLift[]) {
          const r = parseTrainingMaxInput(tms[lift], units);
          if (!r.ok) {
            setError(`${lift}: ${r.error}`);
            setBusy(false);
            return;
          }
          parsed[lift] = r.kg;
        }
        const db = getDb();
        const now = new Date().toISOString();
        await db.transaction('rw', db.trainingMaxes, async () => {
          for (const [lift, kg] of Object.entries(parsed) as [MainLift, number][]) {
            await db.trainingMaxes.add({
              id: nanoid(),
              lift,
              trainingMaxKg: kg,
              tmPercent: 0.9,
              createdAt: now,
              source: 'manual',
              note: 'Set during onboarding',
            });
          }
        });
        kickSync();
      }
      const next: PersistedState = {
        ...persisted,
        tmDone: !skip,
        tmSkipped: skip,
        step: 2,
      };
      setPersisted(next);
      saveState(next);
    } finally {
      setBusy(false);
    }
  };

  const saveSchedule = async () => {
    setError(undefined);
    setBusy(true);
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const dayOrder: MainLift[] = scheduleKind === '4day'
        ? PRESS_DAY_4
        : PAIRED_3DAY.flat();
      const liftsPerDay = scheduleKind === '4day' ? 1 : 2;
      const dayGroups = scheduleKind === '4day' ? undefined : PAIRED_3DAY;
      const existing = await db.schedule.get('singleton');
      await db.schedule.put({
        ...(existing ?? {}),
        id: 'singleton',
        dayOrder,
        liftsPerDay,
        dayGroups,
        updatedAt: now,
      });
      kickSync();
      const next: PersistedState = { ...persisted, scheduleDone: true, step: 3 };
      setPersisted(next);
      saveState(next);
    } finally {
      setBusy(false);
    }
  };

  const saveRace = async (skip: boolean) => {
    setError(undefined);
    setBusy(true);
    try {
      if (!skip) {
        if (!race.name.trim() || !race.date) {
          setError('Name and date are required, or tap “Skip”.');
          setBusy(false);
          return;
        }
        const db = getDb();
        const now = new Date().toISOString();
        const r: Race = {
          id: nanoid(),
          name: race.name.trim(),
          date: new Date(race.date).toISOString(),
          kind: race.kind,
          priority: race.priority,
          distanceKm: inferDistanceKm(race.kind),
          createdAt: now,
          updatedAt: now,
        };
        await db.races.add(r);
        kickSync();
      }
      const next: PersistedState = { ...persisted, raceHandled: true, step: 'done' };
      setPersisted(next);
      saveState(next);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    onClose();
    router.push('/program/new');
  };

  const close = () => {
    onClose();
  };

  const stepNum = persisted.step === 'done' ? 4 : persisted.step;
  const titleId = 'onboarding-title';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-md space-y-4 rounded-xl border border-border bg-card p-5 outline-none"
      >
        <div className="flex items-baseline justify-between">
          <h2 id={titleId} className="text-lg font-semibold">
            Welcome to Wendler 5/3/1
          </h2>
          <span className="text-xs text-muted">Step {stepNum} of 4</span>
        </div>

        {persisted.step === 1 && (
          <StepTms
            units={units}
            setUnits={setUnits}
            tms={tms}
            setTms={setTms}
            error={error}
            busy={busy}
            onSkip={() => saveTms(true)}
            onNext={() => saveTms(false)}
            onClose={close}
          />
        )}
        {persisted.step === 2 && (
          <StepSchedule
            scheduleKind={scheduleKind}
            setScheduleKind={setScheduleKind}
            busy={busy}
            onBack={() => setStep(1)}
            onNext={saveSchedule}
            onClose={close}
          />
        )}
        {persisted.step === 3 && (
          <StepRace
            race={race}
            setRace={setRace}
            error={error}
            busy={busy}
            onBack={() => setStep(2)}
            onSkip={() => saveRace(true)}
            onNext={() => saveRace(false)}
            onClose={close}
          />
        )}
        {persisted.step === 'done' && (
          <StepDone
            tmsSkipped={persisted.tmSkipped}
            onClose={close}
            onFinish={finish}
            onBackToRace={() => setStep(3)}
          />
        )}
      </div>
    </div>
  );
}

function StepTms(props: {
  units: Units;
  setUnits: (u: Units) => void;
  tms: TmInputs;
  setTms: (s: TmInputs) => void;
  error?: string;
  busy: boolean;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { units, setUnits, tms, setTms, error, busy, onSkip, onNext, onClose } = props;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Set your <strong>training maxes</strong> — 90% of your true 1RM. Don’t
        know yet? Tap <em>Skip</em> and update later in Settings.
      </p>
      <div className="flex items-center gap-2 text-sm">
        <span className="text-muted">Units</span>
        <UnitToggle value={units} onChange={setUnits} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TmField label="Squat" value={tms.squat} onChange={(v) => setTms({ ...tms, squat: v })} units={units} />
        <TmField label="Bench" value={tms.bench} onChange={(v) => setTms({ ...tms, bench: v })} units={units} />
        <TmField label="Deadlift" value={tms.deadlift} onChange={(v) => setTms({ ...tms, deadlift: v })} units={units} />
        <TmField label="Press" value={tms.press} onChange={(v) => setTms({ ...tms, press: v })} units={units} />
      </div>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <button onClick={onClose} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
          Later
        </button>
        <button onClick={onSkip} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
          Skip TMs
        </button>
        <button
          onClick={onNext}
          disabled={busy}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
        >
          Save &amp; continue
        </button>
      </div>
    </div>
  );
}

function StepSchedule(props: {
  scheduleKind: '4day' | '3day-paired';
  setScheduleKind: (k: '4day' | '3day-paired') => void;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { scheduleKind, setScheduleKind, busy, onBack, onNext, onClose } = props;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        How often will you lift? You can fine-tune this later in <em>Settings →
        Training schedule</em>.
      </p>
      <fieldset className="space-y-2 text-sm">
        <label className="flex cursor-pointer items-start gap-2 rounded border border-border p-3 hover:bg-bg/40">
          <input
            type="radio"
            name="onb-sched"
            checked={scheduleKind === '4day'}
            onChange={() => setScheduleKind('4day')}
            className="mt-1 accent-accent"
          />
          <span>
            <strong>4-day</strong> — one main lift per day. Press → Deadlift →
            Bench → Squat. Recommended.
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-2 rounded border border-border p-3 hover:bg-bg/40">
          <input
            type="radio"
            name="onb-sched"
            checked={scheduleKind === '3day-paired'}
            onChange={() => setScheduleKind('3day-paired')}
            className="mt-1 accent-accent"
          />
          <span>
            <strong>3-day rolling</strong> — two lifts per day, alternating
            cycles. Useful if you only have 3 days/week to lift.
          </span>
        </label>
      </fieldset>
      <div className="flex justify-between gap-2 pt-1">
        <button onClick={onClose} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
          Later
        </button>
        <div className="flex gap-2">
          <button onClick={onBack} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
            Back
          </button>
          <button
            onClick={onNext}
            disabled={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            Save &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}

function StepRace(props: {
  race: RaceInputs;
  setRace: (r: RaceInputs) => void;
  error?: string;
  busy: boolean;
  onBack: () => void;
  onSkip: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { race, setRace, error, busy, onBack, onSkip, onNext, onClose } = props;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Got a race coming up? Add it now and the app will taper your strength
        block around it. <em>Optional — most people skip this and add it later
        from the Races page.</em>
      </p>
      <label className="block text-sm">
        <span className="text-muted">Name</span>
        <input
          type="text"
          value={race.name}
          onChange={(e) => setRace({ ...race, name: e.target.value })}
          placeholder="Helsinki Half"
          className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-sm">
          <span className="text-muted">Date</span>
          <input
            type="date"
            value={race.date}
            onChange={(e) => setRace({ ...race, date: e.target.value })}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
          />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Kind</span>
          <select
            value={race.kind}
            onChange={(e) => setRace({ ...race, kind: e.target.value as RaceKind })}
            className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
          >
            <option value="5k">5K</option>
            <option value="10k">10K</option>
            <option value="half-marathon">Half marathon</option>
            <option value="marathon">Marathon</option>
            <option value="ultra">Ultra</option>
            <option value="trail">Trail</option>
            <option value="other">Other</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-muted">Priority</span>
        <select
          value={race.priority}
          onChange={(e) => setRace({ ...race, priority: e.target.value as RacePriority })}
          className="mt-1 w-full rounded border border-border bg-bg px-2 py-1.5"
        >
          <option value="A">A · full taper</option>
          <option value="B">B · half-style taper</option>
          <option value="C">C · calendar only</option>
        </select>
      </label>
      {error && <p className="text-sm text-red-300">{error}</p>}
      <div className="flex justify-between gap-2 pt-1">
        <button onClick={onClose} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
          Later
        </button>
        <div className="flex gap-2">
          <button onClick={onBack} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
            Back
          </button>
          <button onClick={onSkip} disabled={busy} className="rounded border border-border px-3 py-1.5 text-sm">
            Skip
          </button>
          <button
            onClick={onNext}
            disabled={busy}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            Save &amp; continue
          </button>
        </div>
      </div>
    </div>
  );
}

function StepDone(props: {
  tmsSkipped: boolean;
  onClose: () => void;
  onFinish: () => void;
  onBackToRace: () => void;
}) {
  const { tmsSkipped, onClose, onFinish, onBackToRace } = props;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        You’re ready. Generate your first program — pick a Wendler preset (BBB
        or Spinal Tap) on the next screen and the app will fill in the rest.
      </p>
      {tmsSkipped && (
        <p className="rounded border border-yellow-500/40 bg-yellow-500/10 p-2 text-xs text-yellow-200">
          You skipped training maxes. Set them in <em>Settings</em> before
          starting your program — without TMs the app can’t calculate working
          sets.
        </p>
      )}
      <div className="flex justify-between gap-2 pt-1">
        <button onClick={onClose} className="rounded border border-border px-3 py-1.5 text-sm">
          Maybe later
        </button>
        <div className="flex gap-2">
          <button onClick={onBackToRace} className="rounded border border-border px-3 py-1.5 text-sm">
            Back
          </button>
          <button
            onClick={onFinish}
            disabled={tmsSkipped}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg disabled:opacity-50"
          >
            Generate program
          </button>
        </div>
      </div>
    </div>
  );
}

function TmField({
  label,
  value,
  onChange,
  units,
}: {
  label: string;
  value: string;
  onChange: (s: string) => void;
  units: Units;
}) {
  return (
    <label className="block text-sm">
      <span className="text-muted">{label}</span>
      <div className="mt-1 flex items-center gap-1">
        <input
          type="number"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded border border-border bg-bg px-2 py-1.5"
          placeholder="—"
        />
        <span className="text-xs text-muted">{units}</span>
      </div>
    </label>
  );
}

function UnitToggle({ value, onChange }: { value: Units; onChange: (u: Units) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-border text-xs">
      {(['kg', 'lb'] as Units[]).map((u) => (
        <button
          key={u}
          type="button"
          onClick={() => onChange(u)}
          className={`px-2 py-1 ${value === u ? 'bg-accent text-bg' : 'text-muted'}`}
        >
          {u}
        </button>
      ))}
    </div>
  );
}

/**
 * Decides whether the wizard should be visible. Renders nothing until the
 * underlying live queries have resolved. The trigger conditions are:
 *
 * - URL has `?onboarding=1` → always show (debug / re-test path)
 * - Both `schedule.singleton` is missing AND no blocks exist → fresh install
 *
 * Once the user closes the wizard mid-flow, it re-fires next visit (matching
 * the "ESC defers" behaviour) — by design, since we want the data filled in.
 */
export function OnboardingMount() {
  const schedule = useSchedule();
  const blocks = useBlocks();
  const [open, setOpen] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [forced, setForced] = useState(false);

  useEffect(() => {
    if (schedule === undefined || blocks === undefined) return;
    setResolved(true);
    const force =
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('onboarding') === '1';
    if (force) {
      setForced(true);
    }
    if (
      shouldOpenOnboarding({
        hasSchedule: !!schedule,
        hasBlocks: !!blocks && blocks.length > 0,
        urlForceFlag: force,
      })
    ) {
      setOpen(true);
    }
  }, [schedule, blocks]);

  if (!resolved || !open) return null;
  return (
    <OnboardingWizard
      forceOpen={forced}
      onClose={() => setOpen(false)}
    />
  );
}
