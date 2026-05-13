'use client';

// Reusable equipment-availability picker.
//
// Combines preset chips ("Commercial gym" / "Home gym" / "Minimal" / "Travel")
// with per-EquipmentType checkboxes underneath. Picking a preset overwrites
// the checkboxes; toggling individual checkboxes shifts the preset chip to
// "Custom" if it no longer matches.
//
// Storage: emits `EquipmentType[]` via onChange. `undefined` means "no
// constraint" (the suggester applies no filter), which we treat as "all".

import {
  ALL_EQUIPMENT,
  EQUIPMENT_PRESETS,
  presetMatching,
  type EquipmentType,
  type EquipmentPreset,
} from '@wendler/domain';

const EQUIPMENT_LABEL: Record<EquipmentType, string> = {
  barbell: 'Barbell',
  'trap-bar': 'Trap bar',
  dumbbell: 'Dumbbell',
  kettlebell: 'Kettlebell',
  sandbag: 'Sandbag',
  bodyweight: 'Bodyweight',
  machine: 'Machine',
  cable: 'Cable',
  band: 'Band',
  'weighted-vest': 'Weighted vest',
  'dip-belt': 'Dip belt',
  other: 'Other',
};

export function EquipmentPicker({
  value,
  onChange,
  showHelp = true,
}: {
  /** Current selection. `undefined` is treated as "all equipment" for display purposes. */
  value: EquipmentType[] | undefined;
  onChange: (next: EquipmentType[]) => void;
  showHelp?: boolean;
}) {
  const effective = value ?? ALL_EQUIPMENT;
  const matched: EquipmentPreset | undefined = presetMatching(effective);

  function pickPreset(p: EquipmentPreset) {
    onChange([...p.equipment]);
  }

  function toggle(eq: EquipmentType) {
    const has = effective.includes(eq);
    const next = has ? effective.filter((x) => x !== eq) : [...effective, eq];
    onChange(next);
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {EQUIPMENT_PRESETS.map((p) => {
          const on = matched?.id === p.id;
          return (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() => pickPreset(p)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                on
                  ? 'border-accent bg-accent/20 text-fg'
                  : 'border-border text-muted hover:text-fg'
              }`}
            >
              {p.label}
            </button>
          );
        })}
        {!matched && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-200">
            Custom
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
        {ALL_EQUIPMENT.map((eq) => {
          const on = effective.includes(eq);
          return (
            <label
              key={eq}
              className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs ${
                on ? 'text-fg' : 'text-muted'
              } ${eq === 'bodyweight' ? 'opacity-90' : ''}`}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => toggle(eq)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <span>{EQUIPMENT_LABEL[eq]}</span>
            </label>
          );
        })}
      </div>

      {showHelp && (
        <p className="text-[11px] leading-snug text-muted">
          The assistance suggester only proposes movements that match. Bodyweight
          movements are always allowed regardless of selection.
        </p>
      )}
    </div>
  );
}
