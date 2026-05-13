'use client';

// Coarse 4-zone RPE picker rendered as a 2×2 grid of large tap targets.
// Replaces the 9-button RpeButtons row, which had ~30px wide buttons that
// failed accessibility minimums on phones. We persist the zone midpoint as
// the numeric RPE so existing analytics and PR detection keep working.

import { RPE_ZONES, type RpeZoneId, rpeFromZone, zoneFromRpe } from '@wendler/domain';

interface Props {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  disabled?: boolean;
}

const ZONE_STYLES: Record<RpeZoneId, { idle: string; active: string }> = {
  easy: {
    idle: 'border-emerald-700/50 bg-emerald-900/10 hover:bg-emerald-900/20',
    active: 'border-emerald-400 bg-emerald-500/30 ring-2 ring-emerald-400',
  },
  moderate: {
    idle: 'border-amber-700/50 bg-amber-900/10 hover:bg-amber-900/20',
    active: 'border-amber-400 bg-amber-500/30 ring-2 ring-amber-400',
  },
  hard: {
    idle: 'border-orange-700/50 bg-orange-900/10 hover:bg-orange-900/20',
    active: 'border-orange-400 bg-orange-500/30 ring-2 ring-orange-400',
  },
  max: {
    idle: 'border-rose-700/50 bg-rose-900/10 hover:bg-rose-900/20',
    active: 'border-rose-400 bg-rose-500/30 ring-2 ring-rose-400',
  },
};

export function RpeZonePicker({ value, onChange, disabled = false }: Props) {
  const selected = zoneFromRpe(value);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-sm font-medium text-fg">How did it feel?</span>
        {selected && !disabled && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="text-xs text-muted underline"
            aria-label="Clear RPE"
          >
            clear
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {RPE_ZONES.map((z) => {
          const isSelected = selected === z.id;
          const style = ZONE_STYLES[z.id];
          const range =
            z.min === z.max ? String(z.min) : `${z.min} – ${z.max}`;
          return (
            <button
              key={z.id}
              type="button"
              onClick={() => onChange(isSelected ? undefined : rpeFromZone(z.id))}
              aria-pressed={isSelected}
              disabled={disabled}
              className={`min-h-[60px] rounded-xl border px-3 py-3 text-left transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${
                isSelected ? style.active : style.idle
              }`}
            >
              <div className="text-base font-semibold text-fg">{z.label}</div>
              <div className="text-xs text-muted">RPE {range}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
