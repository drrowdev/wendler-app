'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import type { EquipmentType, MovementPattern, MuscleGroup } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { deleteWithTombstones } from '@/lib/delete';
import { kickSync } from '@/lib/sync';

const EQUIPMENTS: EquipmentType[] = ['barbell', 'trap-bar', 'dumbbell', 'kettlebell', 'sandbag', 'bodyweight', 'machine', 'cable', 'band', 'weighted-vest', 'dip-belt', 'other'];
const PATTERNS: MovementPattern[] = [
  'hinge',
  'squat',
  'push-horizontal',
  'push-vertical',
  'pull-horizontal',
  'pull-vertical',
  'carry',
  'core',
];
const MUSCLES: MuscleGroup[] = [
  'quads', 'hamstrings', 'glutes', 'calves',
  'chest', 'back', 'lats', 'traps', 'shoulders',
  'biceps', 'triceps', 'forearms',
  'core', 'obliques', 'erectors',
];

function EditMovementInner() {
  const router = useRouter();
  const search = useSearchParams();
  const id = search.get('id') ?? '';
  const movement = useLiveQuery(async () => {
    if (!id) return undefined;
    return getDb().movements.get(id);
  }, [id]);

  const [name, setName] = useState('');
  const [equipment, setEquipment] = useState<EquipmentType>('barbell');
  const [pattern, setPattern] = useState<MovementPattern>('push-horizontal');
  const [primary, setPrimary] = useState<MuscleGroup[]>([]);
  const [secondary, setSecondary] = useState<MuscleGroup[]>([]);
  const [cues, setCues] = useState('');
  const [isCompound, setIsCompound] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (movement && !hydrated) {
      setName(movement.name);
      setEquipment(movement.equipment);
      setPattern(movement.pattern);
      setPrimary(movement.primaryMuscles ?? []);
      setSecondary(movement.secondaryMuscles ?? []);
      setCues(movement.techniqueCues ?? '');
      setIsCompound(movement.isCompound ?? false);
      setHydrated(true);
    }
  }, [movement, hydrated]);

  const toggle = (set: MuscleGroup[], setSet: (m: MuscleGroup[]) => void, m: MuscleGroup) => {
    setSet(set.includes(m) ? set.filter((x) => x !== m) : [...set, m]);
  };

  if (!id) return <div className="text-sm text-muted">Missing movement id.</div>;
  if (!movement) return <div className="text-sm text-muted">Loading…</div>;

  const onSave = async () => {
    if (!name.trim() || primary.length === 0) return;
    await getDb().movements.put({
      ...movement,
      name: name.trim(),
      equipment,
      pattern,
      primaryMuscles: primary,
      secondaryMuscles: secondary,
      techniqueCues: cues.trim() || undefined,
      isCompound,
      // Mark as custom so edits to seed movements sync across devices
      // and survive future seed re-checks.
      isCustom: true,
    });
    void kickSync();
    router.push('/movements');
  };

  const onDelete = async () => {
    if (!movement.isCustom) {
      alert('Built-in movements can\u2019t be deleted. Rename it instead, or just stop using it.');
      return;
    }
    if (!confirm(`Delete "${movement.name}"? This cannot be undone.`)) return;
    await deleteWithTombstones('movement', [movement.id]);
    void kickSync();
    router.push('/movements');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Edit Movement</h1>
        <button
          type="button"
          onClick={onDelete}
          disabled={!movement.isCustom}
          title={movement.isCustom ? 'Delete this movement' : 'Built-in movements can\u2019t be deleted'}
          className="rounded-lg border border-border px-3 py-2 text-sm text-red-400 disabled:opacity-40"
        >
          Delete
        </button>
      </div>

      <label className="block">
        <span className="text-xs text-muted">Name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-muted">Equipment</span>
          <select
            value={equipment}
            onChange={(e) => setEquipment(e.target.value as EquipmentType)}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          >
            {EQUIPMENTS.map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-muted">Pattern</span>
          <select
            value={pattern}
            onChange={(e) => setPattern(e.target.value as MovementPattern)}
            className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
          >
            {PATTERNS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-xs text-muted">Primary muscles</legend>
        <div className="flex flex-wrap gap-1">
          {MUSCLES.map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => toggle(primary, setPrimary, m)}
              className={`rounded px-2 py-1 text-xs ring-1 ${
                primary.includes(m)
                  ? 'bg-accent text-bg ring-accent font-semibold'
                  : 'bg-card text-muted ring-border'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-xs text-muted">Secondary muscles</legend>
        <div className="flex flex-wrap gap-1">
          {MUSCLES.map((m) => (
            <button
              type="button"
              key={m}
              onClick={() => toggle(secondary, setSecondary, m)}
              className={`rounded px-2 py-1 text-xs ring-1 ${
                secondary.includes(m)
                  ? 'bg-accent text-bg ring-accent font-semibold'
                  : 'bg-card text-muted ring-border'
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <input
          type="checkbox"
          checked={isCompound}
          onChange={(e) => setIsCompound(e.target.checked)}
        />
        <span className="text-sm">
          Compound lift{' '}
          <span className="text-muted">
            — multi-joint movement that can carry a Training Max. Required to
            assign this movement to a 5/3/1 slot.
          </span>
        </span>
      </label>

      <label className="block">
        <span className="text-xs text-muted">Technique cues (optional)</span>
        <textarea
          value={cues}
          onChange={(e) => setCues(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={!name.trim() || primary.length === 0}
          className="rounded-lg bg-accent px-4 py-3 font-semibold text-bg disabled:opacity-50"
        >
          Save Changes
        </button>
        <button
          type="button"
          onClick={() => router.push('/movements')}
          className="rounded-lg border border-border px-4 py-3 text-sm"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function EditMovementPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted">Loading…</div>}>
      <EditMovementInner />
    </Suspense>
  );
}
