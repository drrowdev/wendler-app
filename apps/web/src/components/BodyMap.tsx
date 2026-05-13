'use client';

import type { MuscleGroup } from '@wendler/db-schema';

// Anatomical body map. Two figures (front + back) drawn at different X offsets
// inside one SVG. Each figure is composed of separate body parts (head, torso,
// arms, legs) so muscle overlays sit cleanly inside each part instead of
// floating in space.
//
// ViewBox: 0 0 420 470. Front figure centered at x=110, back figure at x=310.

const FRONT_CX = 110;
const BACK_CX = 310;

interface FigureShapes {
  head: string;
  neck: string;
  torso: string;
  leftArm: string;
  rightArm: string;
  leftLeg: string;
  rightLeg: string;
}

function buildFigure(cx: number): FigureShapes {
  // All Y coords are absolute; X coords offset from cx.
  // Reference proportions (≈7.5 heads tall):
  //  head:    y 18..68
  //  neck:    y 68..86
  //  shoulder y 86 (peak ~90)
  //  pec/chest line y 100..150
  //  navel    y 200
  //  hip      y 240
  //  crotch   y 252
  //  knee     y 350
  //  ankle    y 440
  const x = (dx: number) => cx + dx;

  return {
    head:
      `M ${x(0)},18 ` +
      `C ${x(-20)},18 ${x(-22)},34 ${x(-22)},44 ` +
      `C ${x(-22)},58 ${x(-14)},68 ${x(0)},68 ` +
      `C ${x(14)},68 ${x(22)},58 ${x(22)},44 ` +
      `C ${x(22)},34 ${x(20)},18 ${x(0)},18 Z`,

    neck:
      `M ${x(-9)},66 L ${x(-10)},86 L ${x(10)},86 L ${x(9)},66 Z`,

    // Torso: neck base → broad shoulders → narrow waist → hips → crotch.
    // V-taper: shoulders ±54, waist ±18, hips ±28.
    torso:
      `M ${x(-10)},86 ` +
      `C ${x(-26)},86 ${x(-44)},90 ${x(-54)},104 ` + // wide shoulder cap
      `C ${x(-56)},116 ${x(-50)},128 ${x(-42)},140 ` + // deltoid down to armpit
      `L ${x(-36)},156 ` + // armpit
      `L ${x(-26)},190 ` + // ribcage taper
      `L ${x(-18)},220 ` + // waist (narrowest)
      `L ${x(-28)},244 ` + // flare to hip
      `L ${x(-28)},256 ` + // upper outer thigh start
      `L ${x(0)},260 ` + // crotch midline
      `L ${x(28)},256 ` +
      `L ${x(28)},244 ` +
      `L ${x(18)},220 ` +
      `L ${x(26)},190 ` +
      `L ${x(36)},156 ` +
      `L ${x(42)},140 ` +
      `C ${x(50)},128 ${x(56)},116 ${x(54)},104 ` +
      `C ${x(44)},90 ${x(26)},86 ${x(10)},86 Z`,

    // Left arm: meaty deltoid + thick biceps → tapered forearm → hand.
    leftArm:
      `M ${x(-54)},104 ` +
      `C ${x(-62)},118 ${x(-64)},138 ${x(-60)},158 ` + // outer deltoid swell
      `L ${x(-58)},192 ` + // elbow outer (slight taper)
      `L ${x(-56)},240 ` + // forearm outer
      `L ${x(-58)},272 ` + // wrist outer
      `C ${x(-60)},286 ${x(-56)},298 ${x(-50)},298 ` + // hand outer
      `C ${x(-44)},298 ${x(-42)},290 ${x(-44)},280 ` + // fingertips inner
      `L ${x(-42)},258 ` +
      `L ${x(-38)},230 ` +
      `L ${x(-36)},192 ` + // inner forearm
      `L ${x(-36)},158 ` + // inner biceps
      `L ${x(-36)},156 Z`, // armpit close

    rightArm:
      `M ${x(54)},104 ` +
      `C ${x(62)},118 ${x(64)},138 ${x(60)},158 ` +
      `L ${x(58)},192 ` +
      `L ${x(56)},240 ` +
      `L ${x(58)},272 ` +
      `C ${x(60)},286 ${x(56)},298 ${x(50)},298 ` +
      `C ${x(44)},298 ${x(42)},290 ${x(44)},280 ` +
      `L ${x(42)},258 ` +
      `L ${x(38)},230 ` +
      `L ${x(36)},192 ` +
      `L ${x(36)},158 ` +
      `L ${x(36)},156 Z`,

    leftLeg:
      `M ${x(-28)},256 ` +
      `C ${x(-34)},290 ${x(-32)},330 ${x(-28)},354 ` + // thick outer thigh
      `L ${x(-26)},380 ` + // outer calf swell
      `C ${x(-24)},410 ${x(-22)},435 ${x(-22)},448 ` + // outer ankle
      `L ${x(-12)},452 ` + // foot bottom
      `L ${x(-2)},452 ` +
      `L ${x(-2)},444 ` + // inner ankle
      `C ${x(-4)},420 ${x(-6)},395 ${x(-6)},370 ` + // inner calf
      `L ${x(-4)},340 ` + // inner knee
      `C ${x(-2)},300 ${x(-2)},270 ${x(0)},260 Z`,

    rightLeg:
      `M ${x(28)},256 ` +
      `C ${x(34)},290 ${x(32)},330 ${x(28)},354 ` +
      `L ${x(26)},380 ` +
      `C ${x(24)},410 ${x(22)},435 ${x(22)},448 ` +
      `L ${x(12)},452 ` +
      `L ${x(2)},452 ` +
      `L ${x(2)},444 ` +
      `C ${x(4)},420 ${x(6)},395 ${x(6)},370 ` +
      `L ${x(4)},340 ` +
      `C ${x(2)},300 ${x(2)},270 ${x(0)},260 Z`,
  };
}

const FRONT = buildFigure(FRONT_CX);
const BACK = buildFigure(BACK_CX);

interface MuscleShape {
  id: MuscleGroup;
  label: string;
  side: 'front' | 'back';
  d: string;
}

// Muscle overlays, sized to sit inside the body parts above.
const MUSCLES: MuscleShape[] = [
  // ============ FRONT ============
  // Deltoids (shoulders) — broad caps either side of neck.
  {
    id: 'shoulders',
    side: 'front',
    label: 'Shoulders',
    d:
      // left
      `M ${FRONT_CX - 48},100 C ${FRONT_CX - 58},116 ${FRONT_CX - 58},134 ${FRONT_CX - 52},148 ` +
      `L ${FRONT_CX - 28},142 C ${FRONT_CX - 28},126 ${FRONT_CX - 22},108 ${FRONT_CX - 12},96 Z ` +
      // right
      `M ${FRONT_CX + 48},100 C ${FRONT_CX + 58},116 ${FRONT_CX + 58},134 ${FRONT_CX + 52},148 ` +
      `L ${FRONT_CX + 28},142 C ${FRONT_CX + 28},126 ${FRONT_CX + 22},108 ${FRONT_CX + 12},96 Z`,
  },

  // Pecs — two beefier halves filling the wider chest.
  {
    id: 'chest',
    side: 'front',
    label: 'Chest',
    d:
      // left pec
      `M ${FRONT_CX - 2},96 ` +
      `C ${FRONT_CX - 16},96 ${FRONT_CX - 32},104 ${FRONT_CX - 38},120 ` +
      `C ${FRONT_CX - 42},138 ${FRONT_CX - 36},156 ${FRONT_CX - 22},160 ` +
      `C ${FRONT_CX - 10},160 ${FRONT_CX - 4},152 ${FRONT_CX - 2},144 Z ` +
      // right pec
      `M ${FRONT_CX + 2},96 ` +
      `C ${FRONT_CX + 16},96 ${FRONT_CX + 32},104 ${FRONT_CX + 38},120 ` +
      `C ${FRONT_CX + 42},138 ${FRONT_CX + 36},156 ${FRONT_CX + 22},160 ` +
      `C ${FRONT_CX + 10},160 ${FRONT_CX + 4},152 ${FRONT_CX + 2},144 Z`,
  },

  // Biceps — thick upper-arm peak.
  {
    id: 'biceps',
    side: 'front',
    label: 'Biceps',
    d:
      `M ${FRONT_CX - 56},150 C ${FRONT_CX - 60},168 ${FRONT_CX - 60},186 ${FRONT_CX - 56},194 ` +
      `L ${FRONT_CX - 40},194 C ${FRONT_CX - 40},178 ${FRONT_CX - 38},162 ${FRONT_CX - 38},148 Z ` +
      `M ${FRONT_CX + 56},150 C ${FRONT_CX + 60},168 ${FRONT_CX + 60},186 ${FRONT_CX + 56},194 ` +
      `L ${FRONT_CX + 40},194 C ${FRONT_CX + 40},178 ${FRONT_CX + 38},162 ${FRONT_CX + 38},148 Z`,
  },

  // Forearms — wrist to elbow.
  {
    id: 'forearms',
    side: 'front',
    label: 'Forearms',
    d:
      `M ${FRONT_CX - 54},202 C ${FRONT_CX - 56},224 ${FRONT_CX - 56},250 ${FRONT_CX - 56},268 ` +
      `L ${FRONT_CX - 42},262 C ${FRONT_CX - 40},240 ${FRONT_CX - 40},220 ${FRONT_CX - 40},204 Z ` +
      `M ${FRONT_CX + 54},202 C ${FRONT_CX + 56},224 ${FRONT_CX + 56},250 ${FRONT_CX + 56},268 ` +
      `L ${FRONT_CX + 42},262 C ${FRONT_CX + 40},240 ${FRONT_CX + 40},220 ${FRONT_CX + 40},204 Z`,
  },

  // Rectus abdominis — narrow central panel down to pubis.
  {
    id: 'core',
    side: 'front',
    label: 'Core',
    d:
      `M ${FRONT_CX - 14},162 ` +
      `C ${FRONT_CX - 16},186 ${FRONT_CX - 16},212 ${FRONT_CX - 12},234 ` +
      `L ${FRONT_CX - 4},256 L ${FRONT_CX + 4},256 ` +
      `L ${FRONT_CX + 12},234 ` +
      `C ${FRONT_CX + 16},212 ${FRONT_CX + 16},186 ${FRONT_CX + 14},162 ` +
      `C ${FRONT_CX + 7},168 ${FRONT_CX - 7},168 ${FRONT_CX - 14},162 Z`,
  },

  // Obliques — flanking the abs along the V-taper.
  {
    id: 'obliques',
    side: 'front',
    label: 'Obliques',
    d:
      `M ${FRONT_CX - 28},170 C ${FRONT_CX - 26},196 ${FRONT_CX - 22},222 ${FRONT_CX - 18},236 ` +
      `L ${FRONT_CX - 14},232 C ${FRONT_CX - 16},208 ${FRONT_CX - 16},184 ${FRONT_CX - 16},166 Z ` +
      `M ${FRONT_CX + 28},170 C ${FRONT_CX + 26},196 ${FRONT_CX + 22},222 ${FRONT_CX + 18},236 ` +
      `L ${FRONT_CX + 14},232 C ${FRONT_CX + 16},208 ${FRONT_CX + 16},184 ${FRONT_CX + 16},166 Z`,
  },

  // Quads — fuller thigh fronts.
  {
    id: 'quads',
    side: 'front',
    label: 'Quads',
    d:
      `M ${FRONT_CX - 26},270 C ${FRONT_CX - 28},302 ${FRONT_CX - 26},332 ${FRONT_CX - 22},348 ` +
      `L ${FRONT_CX - 6},348 L ${FRONT_CX - 4},270 Z ` +
      `M ${FRONT_CX + 26},270 C ${FRONT_CX + 28},302 ${FRONT_CX + 26},332 ${FRONT_CX + 22},348 ` +
      `L ${FRONT_CX + 6},348 L ${FRONT_CX + 4},270 Z`,
  },

  // Calves on front view — tibialis anterior strip (subtle).
  {
    id: 'calves',
    side: 'front',
    label: 'Calves',
    d:
      `M ${FRONT_CX - 22},370 C ${FRONT_CX - 22},395 ${FRONT_CX - 20},420 ${FRONT_CX - 18},438 ` +
      `L ${FRONT_CX - 10},438 L ${FRONT_CX - 8},370 Z ` +
      `M ${FRONT_CX + 22},370 C ${FRONT_CX + 22},395 ${FRONT_CX + 20},420 ${FRONT_CX + 18},438 ` +
      `L ${FRONT_CX + 10},438 L ${FRONT_CX + 8},370 Z`,
  },

  // ============ BACK ============
  // Trapezius — diamond from neck base across upper shoulders to mid-back.
  {
    id: 'traps',
    side: 'back',
    label: 'Traps',
    d:
      `M ${BACK_CX},88 ` +
      `C ${BACK_CX - 22},92 ${BACK_CX - 40},100 ${BACK_CX - 48},112 ` +
      `L ${BACK_CX - 22},128 L ${BACK_CX},156 L ${BACK_CX + 22},128 ` +
      `L ${BACK_CX + 48},112 ` +
      `C ${BACK_CX + 40},100 ${BACK_CX + 22},92 ${BACK_CX},88 Z`,
  },

  // Rear delts / upper back (rhomboid area on either side of spine).
  {
    id: 'back',
    side: 'back',
    label: 'Upper back',
    d:
      `M ${BACK_CX - 50},120 C ${BACK_CX - 56},134 ${BACK_CX - 54},152 ${BACK_CX - 48},162 ` +
      `L ${BACK_CX - 26},156 L ${BACK_CX - 16},130 Z ` +
      `M ${BACK_CX + 50},120 C ${BACK_CX + 56},134 ${BACK_CX + 54},152 ${BACK_CX + 48},162 ` +
      `L ${BACK_CX + 26},156 L ${BACK_CX + 16},130 Z`,
  },

  // Lats — wide wing shapes flaring from armpits down to narrow waist.
  {
    id: 'lats',
    side: 'back',
    label: 'Lats',
    d:
      // left lat
      `M ${BACK_CX - 36},156 ` +
      `C ${BACK_CX - 38},180 ${BACK_CX - 32},206 ${BACK_CX - 22},226 ` +
      `L ${BACK_CX - 4},236 L ${BACK_CX - 4},182 ` +
      `C ${BACK_CX - 14},176 ${BACK_CX - 26},168 ${BACK_CX - 36},156 Z ` +
      // right lat
      `M ${BACK_CX + 36},156 ` +
      `C ${BACK_CX + 38},180 ${BACK_CX + 32},206 ${BACK_CX + 22},226 ` +
      `L ${BACK_CX + 4},236 L ${BACK_CX + 4},182 ` +
      `C ${BACK_CX + 14},176 ${BACK_CX + 26},168 ${BACK_CX + 36},156 Z`,
  },

  // Erectors — paraspinal columns flanking spine in lumbar region.
  {
    id: 'erectors',
    side: 'back',
    label: 'Erectors',
    d:
      `M ${BACK_CX - 8},204 L ${BACK_CX - 2},204 L ${BACK_CX - 4},250 L ${BACK_CX - 10},250 Z ` +
      `M ${BACK_CX + 2},204 L ${BACK_CX + 8},204 L ${BACK_CX + 10},250 L ${BACK_CX + 4},250 Z`,
  },

  // Triceps — back of upper arm.
  {
    id: 'triceps',
    side: 'back',
    label: 'Triceps',
    d:
      `M ${BACK_CX - 56},150 C ${BACK_CX - 60},168 ${BACK_CX - 60},186 ${BACK_CX - 56},194 ` +
      `L ${BACK_CX - 40},194 C ${BACK_CX - 40},178 ${BACK_CX - 38},162 ${BACK_CX - 38},148 Z ` +
      `M ${BACK_CX + 56},150 C ${BACK_CX + 60},168 ${BACK_CX + 60},186 ${BACK_CX + 56},194 ` +
      `L ${BACK_CX + 40},194 C ${BACK_CX + 40},178 ${BACK_CX + 38},162 ${BACK_CX + 38},148 Z`,
  },

  // Glutes — two rounded cheeks.
  {
    id: 'glutes',
    side: 'back',
    label: 'Glutes',
    d:
      `M ${BACK_CX - 2},250 ` +
      `C ${BACK_CX - 18},250 ${BACK_CX - 30},262 ${BACK_CX - 30},280 ` +
      `C ${BACK_CX - 30},296 ${BACK_CX - 18},306 ${BACK_CX - 4},304 ` +
      `L ${BACK_CX - 2},250 Z ` +
      `M ${BACK_CX + 2},250 ` +
      `C ${BACK_CX + 18},250 ${BACK_CX + 30},262 ${BACK_CX + 30},280 ` +
      `C ${BACK_CX + 30},296 ${BACK_CX + 18},306 ${BACK_CX + 4},304 ` +
      `L ${BACK_CX + 2},250 Z`,
  },

  // Hamstrings — back of thigh.
  {
    id: 'hamstrings',
    side: 'back',
    label: 'Hamstrings',
    d:
      `M ${BACK_CX - 26},310 C ${BACK_CX - 28},332 ${BACK_CX - 26},352 ${BACK_CX - 22},348 ` +
      `L ${BACK_CX - 6},348 L ${BACK_CX - 4},310 Z ` +
      `M ${BACK_CX + 26},310 C ${BACK_CX + 28},332 ${BACK_CX + 26},352 ${BACK_CX + 22},348 ` +
      `L ${BACK_CX + 6},348 L ${BACK_CX + 4},310 Z`,
  },

  // Calves — proper gastrocnemius shape on back view.
  {
    id: 'calves',
    side: 'back',
    label: 'Calves',
    d:
      `M ${BACK_CX - 24},368 ` +
      `C ${BACK_CX - 28},388 ${BACK_CX - 26},410 ${BACK_CX - 22},428 ` +
      `L ${BACK_CX - 10},428 ` +
      `C ${BACK_CX - 8},410 ${BACK_CX - 8},388 ${BACK_CX - 8},368 Z ` +
      `M ${BACK_CX + 24},368 ` +
      `C ${BACK_CX + 28},388 ${BACK_CX + 26},410 ${BACK_CX + 22},428 ` +
      `L ${BACK_CX + 10},428 ` +
      `C ${BACK_CX + 8},410 ${BACK_CX + 8},388 ${BACK_CX + 8},368 Z`,
  },
];

interface Props {
  /** Volume per muscle group; relative scale used for color intensity. */
  volumes: Partial<Record<MuscleGroup, number>>;
}

export function BodyMap({ volumes }: Props) {
  const max = Math.max(...Object.values(volumes), 1);

  const colorFor = (mg: MuscleGroup) => {
    const v = volumes[mg] ?? 0;
    if (v === 0) return 'rgba(239,68,68,0.10)'; // baseline tint so muscle is faintly visible
    const t = Math.min(1, v / max);
    // pale rose → vivid red (matches the reference image's red highlights)
    const r = 239;
    const g = Math.round(140 - t * 72);
    const b = Math.round(140 - t * 72);
    const a = 0.35 + t * 0.55;
    return `rgba(${r},${g},${b},${a})`;
  };

  const renderFigure = (
    fig: FigureShapes,
    labelX: number,
    labelText: string,
    side: 'front' | 'back',
  ) => (
    <g>
      {/* Body silhouette (slate-blue, like the reference). */}
      <g
        fill="rgba(148,163,184,0.22)"
        stroke="rgba(71,85,105,0.85)"
        strokeWidth="1.1"
        strokeLinejoin="round"
      >
        <path d={fig.head} />
        <path d={fig.neck} />
        <path d={fig.torso} />
        <path d={fig.leftArm} />
        <path d={fig.rightArm} />
        <path d={fig.leftLeg} />
        <path d={fig.rightLeg} />
      </g>

      {/* Muscle overlays for this side */}
      <g stroke="rgba(127,29,29,0.55)" strokeWidth="0.8" strokeLinejoin="round">
        {MUSCLES.filter((m) => m.side === side).map((m) => (
          <path key={m.side + m.id} d={m.d} fill={colorFor(m.id)}>
            <title>
              {m.label}: {(volumes[m.id] ?? 0).toFixed(0)} kg·reps
            </title>
          </path>
        ))}
      </g>

      <text
        x={labelX}
        y="466"
        fontSize="11"
        textAnchor="middle"
        fill="currentColor"
        fillOpacity="0.6"
      >
        {labelText}
      </text>
    </g>
  );

  return (
    <div className="space-y-3">
      <svg
        viewBox="0 0 420 472"
        className="w-full"
        role="img"
        aria-label="Muscle volume heatmap"
      >
        {renderFigure(FRONT, FRONT_CX, 'Front', 'front')}
        {renderFigure(BACK, BACK_CX, 'Back', 'back')}
      </svg>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>Low</span>
        <div className="h-2 flex-1 rounded bg-gradient-to-r from-rose-200 via-red-400 to-red-700" />
        <span>High</span>
      </div>
    </div>
  );
}
