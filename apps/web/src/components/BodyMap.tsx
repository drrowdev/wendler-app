'use client';

import type { MuscleGroup } from '@wendler/db-schema';

interface Region {
  id: MuscleGroup;
  label: string;
  /** SVG path "d" attribute relative to viewBox 0 0 200 400 */
  d: string;
  side: 'front' | 'back';
}

const REGIONS: Region[] = [
  // ---- FRONT (x: 0..200) ----
  { id: 'shoulders', label: 'Shoulders', side: 'front', d: 'M 60 90 Q 70 80 85 88 L 80 110 Q 70 105 62 100 Z M 140 90 Q 130 80 115 88 L 120 110 Q 130 105 138 100 Z' },
  { id: 'chest', label: 'Chest', side: 'front', d: 'M 80 100 Q 100 95 120 100 L 122 130 Q 100 138 78 130 Z' },
  { id: 'biceps', label: 'Biceps', side: 'front', d: 'M 58 110 Q 65 108 72 112 L 70 145 Q 60 145 55 140 Z M 142 110 Q 135 108 128 112 L 130 145 Q 140 145 145 140 Z' },
  { id: 'forearms', label: 'Forearms', side: 'front', d: 'M 55 148 Q 62 148 70 150 L 68 185 Q 58 185 52 180 Z M 145 148 Q 138 148 130 150 L 132 185 Q 142 185 148 180 Z' },
  { id: 'core', label: 'Core', side: 'front', d: 'M 85 140 Q 100 142 115 140 L 116 200 Q 100 205 84 200 Z' },
  { id: 'obliques', label: 'Obliques', side: 'front', d: 'M 75 150 L 84 152 L 84 195 L 76 192 Z M 125 150 L 116 152 L 116 195 L 124 192 Z' },
  { id: 'quads', label: 'Quads', side: 'front', d: 'M 80 215 Q 100 218 120 215 L 118 290 Q 100 295 82 290 Z' },
  { id: 'calves', label: 'Calves', side: 'front', d: 'M 84 305 L 96 305 L 95 360 L 85 360 Z M 116 305 L 104 305 L 105 360 L 115 360 Z' },

  // ---- BACK (x: 220..420) ----
  { id: 'traps', label: 'Traps', side: 'back', d: 'M 295 80 Q 320 78 345 80 L 340 110 Q 320 108 300 110 Z' },
  { id: 'lats', label: 'Lats', side: 'back', d: 'M 282 110 Q 300 115 320 115 L 320 165 Q 295 162 282 155 Z M 358 110 Q 340 115 320 115 L 320 165 Q 345 162 358 155 Z' },
  { id: 'back', label: 'Upper back', side: 'back', d: 'M 298 112 Q 320 115 342 112 L 340 150 Q 320 152 300 150 Z' },
  { id: 'erectors', label: 'Erectors', side: 'back', d: 'M 312 152 L 328 152 L 326 210 L 314 210 Z' },
  { id: 'glutes', label: 'Glutes', side: 'back', d: 'M 290 215 Q 320 220 350 215 L 348 250 Q 320 258 292 250 Z' },
  { id: 'hamstrings', label: 'Hamstrings', side: 'back', d: 'M 295 258 Q 320 262 345 258 L 340 320 Q 320 325 300 320 Z' },
  { id: 'triceps', label: 'Triceps', side: 'back', d: 'M 270 110 Q 278 108 285 112 L 282 145 Q 273 145 268 140 Z M 370 110 Q 362 108 355 112 L 358 145 Q 367 145 372 140 Z' },
];

const OUTLINE_FRONT =
  'M 100 50 Q 115 50 115 65 Q 115 78 105 82 L 130 88 Q 150 90 150 110 L 145 165 Q 142 195 130 210 L 130 295 L 122 360 L 110 365 L 108 305 L 100 305 L 92 305 L 90 365 L 78 360 L 70 295 L 70 210 Q 58 195 55 165 L 50 110 Q 50 90 70 88 L 95 82 Q 85 78 85 65 Q 85 50 100 50 Z';
const OUTLINE_BACK =
  'M 320 50 Q 335 50 335 65 Q 335 78 325 82 L 350 88 Q 370 90 370 110 L 365 165 Q 362 195 350 210 L 350 295 L 342 360 L 330 365 L 328 305 L 320 305 L 312 305 L 310 365 L 298 360 L 290 295 L 290 210 Q 278 195 275 165 L 270 110 Q 270 90 290 88 L 315 82 Q 305 78 305 65 Q 305 50 320 50 Z';

interface Props {
  /** Volume per muscle group; relative scale used for color intensity. */
  volumes: Partial<Record<MuscleGroup, number>>;
}

export function BodyMap({ volumes }: Props) {
  const max = Math.max(...Object.values(volumes), 1);
  const colorFor = (mg: MuscleGroup) => {
    const v = volumes[mg] ?? 0;
    if (v === 0) return 'rgba(255,255,255,0.04)';
    const t = v / max; // 0..1
    // green → yellow → orange → red
    const r = Math.round(60 + t * 195);
    const g = Math.round(180 - t * 120);
    const b = Math.round(80 - t * 60);
    return `rgba(${r}, ${g}, ${b}, ${0.35 + t * 0.5})`;
  };

  return (
    <div className="space-y-3">
      <svg viewBox="0 0 420 400" className="w-full" role="img" aria-label="Muscle volume heatmap">
        {/* outlines */}
        <path d={OUTLINE_FRONT} fill="none" stroke="currentColor" strokeOpacity="0.4" />
        <path d={OUTLINE_BACK} fill="none" stroke="currentColor" strokeOpacity="0.4" />
        {REGIONS.map((r) => (
          <path key={r.side + r.id + r.d.slice(0, 8)} d={r.d} fill={colorFor(r.id)} stroke="currentColor" strokeOpacity="0.2">
            <title>
              {r.label}: {(volumes[r.id] ?? 0).toFixed(0)} kg·reps
            </title>
          </path>
        ))}
        <text x="100" y="395" fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.6">Front</text>
        <text x="320" y="395" fontSize="11" textAnchor="middle" fill="currentColor" fillOpacity="0.6">Back</text>
      </svg>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Low</span>
        <div className="h-2 flex-1 rounded bg-gradient-to-r from-emerald-700/40 via-amber-500/60 to-red-600/80" />
        <span>High</span>
      </div>
    </div>
  );
}
