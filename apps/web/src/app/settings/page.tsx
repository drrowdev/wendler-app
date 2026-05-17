'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAllSessions, useAllStrengthHr, useSchedule, useSettings } from '@/lib/hooks';
import { getDb } from '@/lib/db';
import { ensureNotificationPermission } from '@/components/RestTimer';
import { StravaPanel } from '@/components/StravaPanel';
import {
  computeTrainingMax,
  effectiveScheduleDays,
  orphanStrengthHr,
  type MainLift,
} from '@wendler/domain';
import type { WarmupBlockDef } from '@wendler/db-schema';
import { DEFAULT_PRE_LIFTING_WARMUP_BLOCKS, liftSetKey, liftSetLabel } from '@wendler/db-schema';
import { WarmupEditor } from '@/components/WarmupEditor';
import { useKeepScreenOnStatus } from '@/components/KeepScreenOn';
import { nanoid } from 'nanoid';
import { kickSync } from '@/lib/sync';
import { BackupSection } from '@/components/BackupSection';

const REST_KINDS: { id: 'warmup' | 'main' | 'amrap' | 'supplemental' | 'assistance'; label: string; default: number }[] = [
  { id: 'warmup', label: 'Warm-up', default: 60 },
  { id: 'main', label: 'Working sets', default: 180 },
  { id: 'amrap', label: 'AMRAP', default: 240 },
  { id: 'supplemental', label: 'Supplemental', default: 90 },
  { id: 'assistance', label: 'Assistance', default: 60 },
];

/**
 * Walk the latest TM per main lift and append a corrected history entry
 * for any whose `trainingMaxKg` doesn't match what `computeTrainingMax`
 * would produce from the stored unrounded `oneRmKg` at the given rounding
 * increment. Skips lifts whose TM is already correct, so this is safe to
 * call defensively (e.g. on settings page mount). Returns the number of
 * lifts that were re-rounded. Triggers a sync on append.
 */
async function reconcileTrainingMaxesToRounding(
  newRoundingKg: number,
  prevRoundingKg?: number,
): Promise<number> {
  if (!isFinite(newRoundingKg) || newRoundingKg <= 0) return 0;
  const all = await getDb().trainingMaxes.toArray();
  const latestByLift = new Map<MainLift, (typeof all)[number]>();
  for (const tm of all) {
    const cur = latestByLift.get(tm.lift);
    if (!cur || cur.createdAt < tm.createdAt) latestByLift.set(tm.lift, tm);
  }
  const now = new Date().toISOString();
  let appended = 0;
  for (const [lift, cur] of latestByLift) {
    if (cur.oneRmKg == null || !isFinite(cur.oneRmKg) || cur.oneRmKg <= 0) continue;
    const nextTm = computeTrainingMax(cur.oneRmKg, {
      tmPercent: cur.tmPercent,
      roundingKg: newRoundingKg,
    });
    if (Math.abs(nextTm - cur.trainingMaxKg) < 1e-9) continue;
    const note =
      prevRoundingKg != null && Math.abs(prevRoundingKg - newRoundingKg) > 1e-9
        ? `Re-rounded to ${newRoundingKg} kg increment (was ${prevRoundingKg} kg)`
        : `Re-rounded to ${newRoundingKg} kg increment`;
    await getDb().trainingMaxes.add({
      id: nanoid(),
      lift,
      oneRmKg: cur.oneRmKg,
      tmPercent: cur.tmPercent,
      trainingMaxKg: nextTm,
      createdAt: now,
      source: 'manual',
      note,
    });
    appended += 1;
  }
  if (appended > 0) kickSync();
  return appended;
}

export default function SettingsPage() {
  const settings = useSettings();
  const schedule = useSchedule();
  const [editing, setEditing] = useState(false);
  const [bar, setBar] = useState('20');
  const [trapBar, setTrapBar] = useState('25');
  const [keepScreenOn, setKeepScreenOn] = useState(false);
  const [strengthHrEnrichment, setStrengthHrEnrichment] = useState(true);
  const [dailyBriefEnabled, setDailyBriefEnabled] = useState(true);
  const [preferredMaxPlate, setPreferredMaxPlate] = useState<string>('auto');
  const [rounding, setRounding] = useState('2.5');
  const [defaultTm, setDefaultTm] = useState('85');
  const [warmupP, setWarmupP] = useState('40,60,80');
  const [warmupR, setWarmupR] = useState('5,5,3');
  const [availablePlates, setAvailablePlates] = useState<Set<number>>(
    new Set([25, 20, 15, 10, 5, 2.5, 1.25]),
  );
  const [autoStartRest, setAutoStartRest] = useState(true);
  const [warmupEnabled, setWarmupEnabled] = useState(true);
  const [warmupBlocks, setWarmupBlocks] = useState<WarmupBlockDef[]>(() =>
    DEFAULT_PRE_LIFTING_WARMUP_BLOCKS.map((b) => ({
      ...b,
      movements: b.movements.map((m) => ({ ...m })),
    })),
  );
  // User's "my default" snapshot of the warm-up. undefined = no snapshot saved.
  const [userDefaultBlocks, setUserDefaultBlocks] = useState<WarmupBlockDef[] | undefined>(
    undefined,
  );
  const [restByKind, setRestByKind] = useState<Record<string, string>>({});
  const [notifStatus, setNotifStatus] = useState<string | null>(null);
  const reconciledRef = useRef(false);

  // Day combos derived from the active schedule. Drives the per-block
  // "Applies to" dropdown so the user picks from real training days
  // (e.g. "Bench + Deadlift") instead of a fixed press/lower split.
  const dayCombos = useMemo(() => {
    if (!schedule) return [] as { key: string; label: string }[];
    const days = effectiveScheduleDays(schedule);
    const seen = new Set<string>();
    const out: { key: string; label: string }[] = [];
    for (const d of days) {
      const key = liftSetKey(d.mainLifts);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ key, label: liftSetLabel(d.mainLifts) });
    }
    return out;
  }, [schedule]);

  // Defensive auto-reconciliation: if any stored TM doesn't match what
  // computeTrainingMax would produce with the *current* rounding increment,
  // append a corrected history entry. Covers the case where the user changed
  // roundingKg in a previous app version that didn't reconcile on save, so
  // existing TMs are stale until they re-edit each lift. Runs once per mount
  // after settings load; the inner same-value check makes it a no-op when
  // everything is already consistent.
  useEffect(() => {
    if (!settings || reconciledRef.current) return;
    reconciledRef.current = true;
    void reconcileTrainingMaxesToRounding(settings.roundingKg);
  }, [settings]);

  if (!settings) return <p className="text-muted">Loading…</p>;

  const togglePlate = (w: number) => {
    setAvailablePlates((prev) => {
      const next = new Set(prev);
      if (next.has(w)) next.delete(w);
      else next.add(w);
      return next;
    });
  };

  const startEdit = () => {
    setBar(String(settings.barWeightKg));
    setTrapBar(String(settings.trapBarWeightKg ?? 25));
    setKeepScreenOn(settings.keepScreenOn ?? false);
    setStrengthHrEnrichment(settings.strengthHrEnrichment ?? true);
    setDailyBriefEnabled(settings.dailyBriefEnabled ?? true);
    setPreferredMaxPlate(
      typeof settings.preferredMaxPlateKg === 'number'
        ? String(settings.preferredMaxPlateKg)
        : 'auto',
    );
    setRounding(String(settings.roundingKg));
    setDefaultTm(String((settings.defaultTmPercent * 100).toFixed(0)));
    setWarmupP(settings.warmupPercents.map((p) => Math.round(p * 100)).join(','));
    setWarmupR(settings.warmupReps.join(','));
    setAvailablePlates(
      new Set(
        Object.entries(settings.pairsByWeight)
          .filter(([, c]) => Number(c) > 0)
          .map(([w]) => Number(w)),
      ),
    );
    const rest: Record<string, string> = {};
    for (const k of REST_KINDS) {
      rest[k.id] = String(settings.restSecondsByKind?.[k.id] ?? k.default);
    }
    setRestByKind(rest);
    setAutoStartRest(settings.autoStartRestTimer ?? true);
    setWarmupEnabled(settings.preLiftingWarmupEnabled ?? true);
    const persistedBlocks =
      settings.preLiftingWarmup?.blocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS;
    setWarmupBlocks(
      persistedBlocks.map((b) => ({
        ...b,
        movements: b.movements.map((m) => ({ ...m })),
      })),
    );
    const persistedDefault = settings.preLiftingWarmupUserDefault?.blocks;
    setUserDefaultBlocks(
      persistedDefault
        ? persistedDefault.map((b) => ({
            ...b,
            movements: b.movements.map((m) => ({ ...m })),
          }))
        : undefined,
    );
    setEditing(true);
  };

  const onSave = async () => {
    // Plates are stored as pairs-per-weight to keep the existing schema and
    // plate calculator API intact. Since the user has effectively unlimited
    // plates available in their gym, every selected weight gets a high pair
    // count so the greedy loader is never inventory-bound.
    const pairs: Record<number, number> = {};
    for (const w of availablePlates) {
      if (isFinite(w) && w > 0) pairs[w] = 99;
    }
    const rest: Record<string, number> = {};
    for (const k of REST_KINDS) {
      const n = Number(restByKind[k.id]);
      rest[k.id] = isFinite(n) && n > 0 ? n : k.default;
    }
    await getDb().settings.put({
      ...settings,
      id: 'singleton',
      barWeightKg: Number(bar),
      trapBarWeightKg: Number(trapBar),
      keepScreenOn,
      strengthHrEnrichment,
      dailyBriefEnabled,
      preferredMaxPlateKg:
        preferredMaxPlate === 'auto' ? undefined : Number(preferredMaxPlate),
      roundingKg: Number(rounding),
      defaultTmPercent: Number(defaultTm) / 100,
      warmupPercents: warmupP.split(',').map((s) => Number(s.trim()) / 100),
      warmupReps: warmupR.split(',').map((s) => Number(s.trim())),
      pairsByWeight: pairs,
      units: 'kg',
      restSecondsByKind: rest as never,
      autoStartRestTimer: autoStartRest,
      preLiftingWarmupEnabled: warmupEnabled,
      preLiftingWarmup: { blocks: warmupBlocks },
      preLiftingWarmupUserDefault:
        userDefaultBlocks && userDefaultBlocks.length > 0
          ? { blocks: userDefaultBlocks }
          : undefined,
      updatedAt: new Date().toISOString(),
    });

    // Reconcile each lift's TM against the (now-saved) rounding increment.
    // Always run — not only when the increment changed in this save —
    // because earlier app versions may have left stale TMs behind.
    await reconcileTrainingMaxesToRounding(Number(rounding), settings.roundingKg);

    setEditing(false);
  };

  const onEnableNotifs = async () => {
    const ok = await ensureNotificationPermission();
    setNotifStatus(ok ? 'Enabled ✓' : 'Permission denied or unsupported');
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">Settings</h1>

      {!editing ? (
        <>
          <Section title="Equipment">
            <Row label="Bar weight">{settings.barWeightKg} kg</Row>
            <Row label="Trap bar weight">{settings.trapBarWeightKg ?? 25} kg</Row>
            <Row label="Rounding increment">{settings.roundingKg} kg</Row>
            <Row label="Plates available">
              {Object.entries(settings.pairsByWeight)
                .filter(([, c]) => Number(c) > 0)
                .sort((a, b) => Number(b[0]) - Number(a[0]))
                .map(([w]) => `${w}kg`)
                .join(', ') || '—'}
            </Row>
            <Row label="Prefer max plate">
              {typeof settings.preferredMaxPlateKg === 'number'
                ? `${settings.preferredMaxPlateKg} kg`
                : 'Auto (use heaviest available)'}
            </Row>
          </Section>
          <Section title="Programming defaults">
            <Row label="Default TM %">{(settings.defaultTmPercent * 100).toFixed(0)}%</Row>
            <Row label="Warm-up %">
              {settings.warmupPercents.map((p) => `${Math.round(p * 100)}%`).join(' / ')}
            </Row>
            <Row label="Warm-up reps">{settings.warmupReps.join(' / ')}</Row>
          </Section>
          <Section title="Rest timer">
            <Row label="Auto-start after each set">
              {settings.autoStartRestTimer ?? true ? 'On' : 'Off'}
            </Row>
            {REST_KINDS.map((k) => (
              <Row key={k.id} label={k.label}>
                {settings.restSecondsByKind?.[k.id] ?? k.default} s
              </Row>
            ))}
          </Section>
          <Section title="Pre-lifting warm-up">
            <Row label="Show warm-up card on /day">
              {settings.preLiftingWarmupEnabled ?? true ? 'On' : 'Off'}
            </Row>
            <Row label="Blocks">
              {(settings.preLiftingWarmup?.blocks ?? DEFAULT_PRE_LIFTING_WARMUP_BLOCKS).length}{' '}
              {settings.preLiftingWarmup ? '(custom)' : '(default)'}
            </Row>
          </Section>
          <Section title="Display">
            <Row label="Keep screen on while training">
              {settings.keepScreenOn ? 'On' : 'Off'}
            </Row>
            {settings.keepScreenOn && <KeepScreenOnDiagnostic />}
          </Section>
          <Section title="Notifications">
            <button
              onClick={onEnableNotifs}
              className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border"
            >
              Enable rest notifications
            </button>
            {notifStatus && <p className="mt-2 text-xs text-muted">{notifStatus}</p>}
          </Section>
          <Section title="Strava">
            <Row label="Strength HR enrichment">
              {settings.strengthHrEnrichment ?? true ? 'On' : 'Off'}
            </Row>
            <UnmatchedStrengthHr />
            <StravaPanel />
          </Section>
          <BackupSection />
          <button
            onClick={startEdit}
            className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
          >
            Edit
          </button>
        </>
      ) : (
        <>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <Field label="Bar weight (kg)" value={bar} onChange={setBar} />
            <Field label="Trap bar weight (kg)" value={trapBar} onChange={setTrapBar} />
            <Field label="Rounding increment (kg)" value={rounding} onChange={setRounding} />
            <div>
              <label className="mb-2 block text-xs uppercase tracking-wide text-muted">
                Plates available (per side, kg)
              </label>
              <div className="flex flex-wrap gap-2">
                {[25, 20, 15, 10, 5, 2.5, 1.25, 0.5, 0.25].map((w) => {
                  const on = availablePlates.has(w);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => togglePlate(w)}
                      aria-pressed={on}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                        on
                          ? 'border-accent bg-accent/15 text-accent'
                          : 'border-border bg-bg text-muted hover:text-fg'
                      }`}
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-xs text-muted">
                Tap to toggle. Used by the plate calculator to pick a loadout
                for each working set.
              </p>
            </div>
            <div>
              <label className="mb-2 block text-xs uppercase tracking-wide text-muted">
                Prefer max plate
              </label>
              <select
                value={preferredMaxPlate}
                onChange={(e) => setPreferredMaxPlate(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg"
              >
                <option value="auto">Auto (use heaviest available)</option>
                <option value="20">20 kg max</option>
                <option value="15">15 kg max</option>
                <option value="10">10 kg max</option>
              </select>
              <p className="mt-2 text-xs text-muted">
                When set, the calculator avoids heavier plates (e.g. rare 25 kg)
                and falls back to them only if a target weight isn&apos;t
                otherwise achievable.
              </p>
            </div>
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <Field label="Default TM %" value={defaultTm} onChange={setDefaultTm} />
            <Field
              label="Warm-up % (comma-separated)"
              value={warmupP}
              onChange={setWarmupP}
            />
            <Field
              label="Warm-up reps (comma-separated)"
              value={warmupR}
              onChange={setWarmupR}
            />
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Rest timer
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoStartRest}
                onChange={(e) => setAutoStartRest(e.target.checked)}
              />
              Auto-start timer after each logged set
            </label>
            {REST_KINDS.map((k) => (
              <Field
                key={k.id}
                label={`${k.label} (seconds)`}
                value={restByKind[k.id] ?? String(k.default)}
                onChange={(v) => setRestByKind({ ...restByKind, [k.id]: v })}
              />
            ))}
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Pre-lifting warm-up
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={warmupEnabled}
                onChange={(e) => setWarmupEnabled(e.target.checked)}
              />
              Show warm-up card at the top of /day
            </label>
            <WarmupEditor
              initialBlocks={warmupBlocks}
              dayCombos={dayCombos}
              userDefaultBlocks={userDefaultBlocks}
              onChange={setWarmupBlocks}
              onAutoSave={async (blocks) => {
                // Persist every edit straight to local DB + push to Cosmos
                // so the warm-up protocol behaves like the program block
                // editor: no outer Save button needed.
                const current = await getDb().settings.get('singleton');
                if (current) {
                  await getDb().settings.put({
                    ...current,
                    preLiftingWarmup: { blocks },
                    updatedAt: new Date().toISOString(),
                  });
                  kickSync();
                }
              }}
              onSaveAsUserDefault={async () => {
                const snapshot = warmupBlocks.map((b) => ({
                  ...b,
                  movements: b.movements.map((m) => ({ ...m })),
                }));
                setUserDefaultBlocks(snapshot);
                // Persist immediately to local DB + push to Cosmos so the
                // snapshot survives a refresh even if the user never clicks
                // the outer Settings "Save" button.
                const current = await getDb().settings.get('singleton');
                if (current) {
                  await getDb().settings.put({
                    ...current,
                    preLiftingWarmupUserDefault: { blocks: snapshot },
                    updatedAt: new Date().toISOString(),
                  });
                  kickSync();
                }
              }}
            />
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Display
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={keepScreenOn}
                onChange={(e) => setKeepScreenOn(e.target.checked)}
              />
              Keep screen on while the app is open
            </label>
            <p className="text-xs leading-snug text-muted">
              Uses the browser&apos;s Screen Wake Lock API. Keeps the display from
              sleeping between sets when the app is the active tab or installed
              as a PWA. Released automatically when you switch away.
            </p>
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Strava
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={strengthHrEnrichment}
                onChange={(e) => setStrengthHrEnrichment(e.target.checked)}
              />
              Enrich strength sessions with HR data from Strava
            </label>
            <p className="text-xs leading-snug text-muted">
              Pulls heart-rate streams from Garmin / Strava strength workouts
              (WeightTraining, Crossfit, Workout, HIIT) and folds them into the
              weekly load score so heavy lifting weeks register their true
              cardiovascular cost. The strength activities are NOT imported as
              cardio; only the HR signal is captured. Excluded from the
              polarized 80/10/10 distribution (cardio-only).
            </p>
          </div>
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              AI Coach
            </h3>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={dailyBriefEnabled}
                onChange={(e) => setDailyBriefEnabled(e.target.checked)}
              />
              Daily training brief
            </label>
            <p className="text-xs leading-snug text-muted">
              On first app open each day, the AI composes a short
              brief — today&apos;s session, recent load, what to
              focus on, anything to adjust — delivered as a
              notification. Tap to open the chat and continue the
              conversation. Off = no daily notification.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onSave}
              className="rounded-lg bg-accent px-4 py-2 font-semibold text-bg"
            >
              Save
            </button>
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg bg-card px-4 py-2 ring-1 ring-border"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="font-mono text-fg">{children}</span>
    </div>
  );
}

/**
 * Lists Strava strength activities (Garmin-pushed lifting / gymnastics /
 * crossfit / HIIT) whose HR was imported as enrichment but couldn't be
 * matched to a Wendler workout on the same day.
 *
 * Transient by design: only shows orphans imported in the last 24 hours so
 * the section appears once after a sync and quietly disappears the next day
 * — it's a heads-up, not a permanent log.
 */
function UnmatchedStrengthHr() {
  const strengthHr = useAllStrengthHr();
  const sessions = useAllSessions();
  const orphans = useMemo(() => {
    if (!strengthHr || !sessions) return [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return orphanStrengthHr(strengthHr, sessions)
      .filter((o) => {
        const ts = o.updatedAt ? Date.parse(o.updatedAt) : NaN;
        return Number.isFinite(ts) && ts >= cutoff;
      })
      .slice(0, 5);
  }, [strengthHr, sessions]);

  if (!strengthHr || !sessions) return null;
  if (orphans.length === 0) return null;

  return (
    <div className="mt-2 rounded-lg border border-border bg-bg/40 p-3">
      <p className="text-xs text-muted">
        Just imported (no matching Wendler workout):
      </p>
      <ul className="mt-2 space-y-1 text-xs">
        {orphans.map((o) => {
          const date = new Date(o.performedAt);
          const min = Math.round(o.durationSec / 60);
          const dateLabel = date.toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
          const hr = o.avgHrBpm ? ` · avg ${o.avgHrBpm} bpm` : '';
          const sport = o.sport ? ` · ${o.sport}` : '';
          return (
            <li key={o.id} className="flex justify-between gap-2 font-mono text-fg">
              <span>{dateLabel}</span>
              <span className="text-muted">
                {min} min{hr}
                {sport}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
      />
    </label>
  );
}

function ScheduleSection() {
  return null;
}
// Removed in v304: the "Defaults for new blocks" section duplicated the
// liftsPerDay / dayOrder controls already on /program/detail via
// ProgramDefaultsPanel. The block-creation flow reads from the schedule
// singleton either way, so the live source is unchanged — only the
// duplicate UI surface was removed.
ScheduleSection;

// ---------------------------------------------------------------------------
// KeepScreenOnDiagnostic — surfaces what Wake Lock / video-fallback is
// actually doing, so the user can tell at a glance whether "keep screen on"
// is currently engaged on their device. iOS PWAs sometimes silently fail
// or release the lock; the previous version had no way to see this.
// ---------------------------------------------------------------------------
function KeepScreenOnDiagnostic() {
  const status = useKeepScreenOnStatus();
  let label = '—';
  let detail = '';
  let tone = 'text-muted';
  switch (status.kind) {
    case 'off':
      label = 'Off';
      break;
    case 'pending':
      label = 'Acquiring…';
      tone = 'text-amber-300';
      break;
    case 'unsupported':
      label = 'Not supported';
      detail = status.reason;
      tone = 'text-rose-300';
      break;
    case 'active':
      label =
        status.method === 'wake-lock'
          ? 'Active (Wake Lock)'
          : 'Active (video fallback)';
      tone = 'text-emerald-300';
      break;
    case 'failed':
      label = 'Failed';
      detail = status.reason + (status.willRetryOnGesture ? ' · will retry on tap' : '');
      tone = 'text-rose-300';
      break;
  }
  return (
    <div className="mt-2 rounded-md border border-border/60 bg-bg/40 px-2 py-1.5 text-[11px]">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-muted">Current state</span>
        <span className={`font-medium ${tone}`}>{label}</span>
      </div>
      {detail && (
        <p className="mt-0.5 break-words text-muted">{detail}</p>
      )}
      <p className="mt-1 text-muted">
        Wake Lock first; if iOS rejects it, a silent hidden video keeps the
        display on. Tap anywhere if the state is &ldquo;Failed&rdquo;.
      </p>
    </div>
  );
}
