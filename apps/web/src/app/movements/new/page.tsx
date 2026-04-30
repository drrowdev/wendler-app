'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import type { EquipmentType, MovementPattern, MuscleGroup } from '@wendler/db-schema';
import { getDb } from '@/lib/db';

const EQUIPMENTS: EquipmentType[] = ['barbell', 'dumbbell', 'bodyweight', 'machine', 'cable', 'other'];
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

export default function NewMovementPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [equipment, setEquipment] = useState<EquipmentType>('barbell');
  const [pattern, setPattern] = useState<MovementPattern>('push-horizontal');
  const [primary, setPrimary] = useState<MuscleGroup[]>([]);
  const [secondary, setSecondary] = useState<MuscleGroup[]>([]);
  const [cues, setCues] = useState('');

  const toggle = (set: MuscleGroup[], setSet: (m: MuscleGroup[]) => void, m: MuscleGroup) => {
    setSet(set.includes(m) ? set.filter((x) => x !== m) : [...set, m]);
  };

  const onSave = async () => {
    if (!name.trim() || primary.length === 0) return;
    await getDb().movements.add({
      id: `custom:${nanoid(8)}`,
      name: name.trim(),
      equipment,
      pattern,
      primaryMuscles: primary,
      secondaryMuscles: secondary,
      isCustom: true,
      techniqueCues: cues.trim() || undefined,
    });
    router.push('/movements');
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">New Movement</h1>

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
              <option key={e} value={e}>
                {e}
              </option>
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
              <option key={p} value={p}>
                {p}
              </option>
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

      <label className="block">
        <span className="text-xs text-muted">Technique cues (optional)</span>
        <textarea
          value={cues}
          onChange={(e) => setCues(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
      </label>

      <button
        onClick={onSave}
        disabled={!name.trim() || primary.length === 0}
        className="rounded-lg bg-accent px-4 py-3 font-semibold text-bg disabled:opacity-50"
      >
        Save Movement
      </button>
    </div>
  );
}
