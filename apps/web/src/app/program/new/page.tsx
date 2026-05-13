'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { nanoid } from 'nanoid';
import {
  DEFAULT_DAY_ORDER,
  EQUIPMENT_PRESETS,
  MAIN_SCHEMES,
  SUPPLEMENTAL_TEMPLATES,
  defaultSupplementalSets,
  initialCursorWeek,
  type BlockKind,
  type EquipmentType,
  type MainScheme,
  type SupplementalTemplateId,
} from '@wendler/domain';
import { getDb } from '@/lib/db';
import { fmtDate } from '@/lib/format';
import { EquipmentPicker } from '@/components/EquipmentPicker';

type DraftBlock = {
  kind: BlockKind;
  scheme: MainScheme;
  supplemental: SupplementalTemplateId;
  /** Override on supplemental set count. Undefined = use template default. */
  supplementalSets?: number;
  includesDeload: boolean;
};

type Preset = {
  id: string;
  name: string;
  description: string;
  defaultProgramName: string;
  blocks: DraftBlock[];
};

const PRESETS: Preset[] = [
  {
    id: 'spinal-tap-hs',
    name: 'Spinal Tap (High School Years)',
    description:
      '2 Leaders with 5s PRO + FSL, then an Anchor of Original 5/3/1 + FSL AMRAP. The app will prompt for a 7th-week block (deload) after the Leader pair and a TM/PR test after the Anchor.',
    defaultProgramName: 'Spinal Tap HS',
    blocks: [
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'fsl-amrap', includesDeload: false },
    ],
  },
  {
    id: 'forever-bbb',
    name: 'Forever default (BBB Leaders + Anchor)',
    description:
      '2 Leaders of 5s PRO + Boring But Big (volume), then an Anchor of Original 5/3/1 + FSL AMRAP. The app will prompt for a 7th-week block (deload) after the Leader pair and a TM/PR test after the Anchor.',
    defaultProgramName: 'Forever BBB',
    blocks: [
      { kind: 'leader', scheme: '5s-pro', supplemental: 'bbb', includesDeload: false },
      { kind: 'leader', scheme: '5s-pro', supplemental: 'bbb', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'fsl-amrap', includesDeload: false },
    ],
  },
  {
    id: '351-fsl',
    name: '3/5/1 + FSL (Forever Leaders + Anchor)',
    description:
      '2 Leaders of 3/5/1 + FSL — heavier-day-first ordering Wendler recommends in Forever — then an Anchor of Original 5/3/1 + FSL AMRAP. Lower volume than BBB; good when running cardio alongside.',
    defaultProgramName: '3/5/1 + FSL',
    blocks: [
      { kind: 'leader', scheme: '351', supplemental: 'fsl', includesDeload: false },
      { kind: 'leader', scheme: '351', supplemental: 'fsl', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'fsl-amrap', includesDeload: false },
    ],
  },
  {
    id: 'fsl-leaders',
    name: '5s PRO + FSL (low-volume Leaders)',
    description:
      '2 Leaders of 5s PRO + FSL, Anchor of Original 5/3/1 + FSL AMRAP. The lightest Forever template — pair with running, BJJ, or any conditioning-heavy phase.',
    defaultProgramName: '5s PRO + FSL',
    blocks: [
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'fsl-amrap', includesDeload: false },
    ],
  },
  {
    id: 'ssl-leaders',
    name: 'SSL Leaders + Anchor (advanced)',
    description:
      '2 Leaders of 5s PRO + Second Set Last (heavier supplemental than FSL), Anchor of Original 5/3/1 + FSL AMRAP. Strong-lifter template — only run when recovery is solid.',
    defaultProgramName: 'SSL + Anchor',
    blocks: [
      { kind: 'leader', scheme: '5s-pro', supplemental: 'ssl', includesDeload: false },
      { kind: 'leader', scheme: '5s-pro', supplemental: 'ssl', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'fsl-amrap', includesDeload: false },
    ],
  },
  {
    id: 'widowmaker-anchor',
    name: 'Widowmaker Anchor (squat / DL only)',
    description:
      '2 Leaders of 5s PRO + FSL, then an Anchor of Original 5/3/1 + Widowmaker (1×20 at FSL%). The 20-rep set is squat or DL only — keep press/bench on FSL AMRAP. Brutal Anchor.',
    defaultProgramName: 'Widowmaker',
    blocks: [
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false },
      { kind: 'anchor', scheme: 'classic-531', supplemental: 'widowmaker', includesDeload: false },
    ],
  },
  {
    id: 'original-531',
    name: 'Original 5/3/1 (single block)',
    description:
      'Just the original program: 3 weeks of 5/3/1+ AMRAP top sets. The app will prompt for a 7th-Week deload/TM-test/PR-test at the right point in the cycle. No fixed supplemental — pick what you like.',
    defaultProgramName: 'Original 5/3/1',
    blocks: [
      { kind: 'standalone', scheme: 'classic-531', supplemental: 'fsl', includesDeload: false },
    ],
  },
  {
    id: 'custom',
    name: 'Custom (start blank)',
    description: 'Build from scratch.',
    defaultProgramName: '',
    blocks: [{ kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false }],
  },
];

function defaultBlockName(kind: BlockKind, indexInKind: number): string {
  if (kind === 'seventh-week') return `7th Week ${indexInKind}`;
  const base = kind === 'leader' ? 'Leader' : kind === 'anchor' ? 'Anchor' : 'Block';
  return `${base} ${indexInKind}`;
}

/**
 * Templates whose set count the user can dial up/down on /program/new.
 * BBB is included because Forever supports 3×10 / 5×10 variants — even
 * though 5×10 is the canonical "Boring But Big" volume.
 */
const EDITABLE_SETS_TEMPLATES: ReadonlySet<SupplementalTemplateId> = new Set([
  'fsl',
  'ssl',
  'bbb',
]);

/**
 * Compact "sets × reps" label for a supplemental template, given the
 * effective set count. Used for the inline preview next to each block's
 * supplemental dropdown.
 */
function volumeLabel(t: SupplementalTemplateId, sets: number): string {
  switch (t) {
    case 'fsl':
    case 'ssl':
      return `${sets}×5`;
    case 'bbb':
      return `${sets}×10`;
    case 'fsl-amrap':
      return '1×AMRAP';
    case 'spinal-tap':
      return '3×3 ramp';
    case 'widowmaker':
      return '1×20';
    case 'none':
      return '—';
    case 'custom':
      return 'per session';
    default:
      return '';
  }
}

export default function NewProgramPage() {
  const router = useRouter();
  const [presetId, setPresetId] = useState<string>(PRESETS[0]!.id);
  const [name, setName] = useState(PRESETS[0]!.defaultProgramName);
  const [draft, setDraft] = useState<DraftBlock[]>(PRESETS[0]!.blocks);
  const [startIndex, setStartIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  // Default to Commercial gym — most common case. Users on home gyms or
  // travel can switch with one chip click.
  const [availableEquipment, setAvailableEquipment] = useState<EquipmentType[]>(
    [...EQUIPMENT_PRESETS[0]!.equipment],
  );

  function applyPreset(id: string) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setPresetId(id);
    setDraft(p.blocks.map((b) => ({ ...b })));
    setStartIndex(0);
    if (!name || PRESETS.some((x) => x.defaultProgramName === name)) {
      setName(p.defaultProgramName);
    }
  }
  function update(i: number, patch: Partial<DraftBlock>) {
    setDraft((d) =>
      d.map((b, idx) => {
        if (idx !== i) return b;
        // When the supplemental template changes, drop any stale set-count
        // override — it doesn't apply to the new template (e.g. carrying
        // "5" from FSL into Widowmaker would be nonsense).
        const next: DraftBlock = { ...b, ...patch };
        if (patch.supplemental !== undefined && patch.supplemental !== b.supplemental) {
          next.supplementalSets = undefined;
        }
        return next;
      }),
    );
  }
  function remove(i: number) {
    setDraft((d) => {
      const next = d.filter((_, idx) => idx !== i);
      return next.length > 0
        ? next
        : [{ kind: 'leader', scheme: '5s-pro', supplemental: 'fsl', includesDeload: false }];
    });
    setStartIndex((s) => Math.max(0, Math.min(s, draft.length - 2)));
  }
  function add(kind: BlockKind) {
    setDraft((d) => [
      ...d,
      {
        kind,
        scheme: kind === 'anchor' ? 'classic-531' : '5s-pro',
        supplemental: kind === 'anchor' ? 'fsl-amrap' : 'fsl',
        includesDeload: false,
      },
    ]);
  }

  async function onCreate() {
    setBusy(true);
    try {
      const db = getDb();
      const now = new Date().toISOString();
      const programId = nanoid();
      const programName = name.trim() || `Cycle - ${fmtDate(new Date().toISOString())}`;

      const counters: Record<BlockKind, number> = {
        leader: 0,
        anchor: 0,
        standalone: 0,
        'seventh-week': 0,
      };
      const blocks = draft.map((b, idx) => {
        counters[b.kind] += 1;
        return {
          id: nanoid(),
          name: defaultBlockName(b.kind, counters[b.kind]),
          kind: b.kind,
          weeksBeforeDeload: 3,
          includesDeload: b.includesDeload,
          supplementalTemplate: b.supplemental,
          mainScheme: b.scheme,
          ...(b.supplementalSets !== undefined && {
            supplementalSetsOverride: b.supplementalSets,
          }),
          createdAt: now,
          programId,
          sequenceIndex: idx,
          ...(idx < startIndex && { startedAt: now, completedAt: now }),
          ...(idx === startIndex && { startedAt: now }),
        };
      });

      await db.transaction('rw', db.programs, db.blocks, db.schedule, async () => {
        await db.programs.add({
          id: programId,
          name: programName,
          createdAt: now,
          availableEquipment: [...availableEquipment],
        });
        await db.blocks.bulkAdd(blocks);
        const sched = (await db.schedule.get('singleton')) ?? {
          id: 'singleton' as const,
          dayOrder: [...DEFAULT_DAY_ORDER],
          updatedAt: now,
        };
        const startBlock = blocks[startIndex]!;
        await db.schedule.put({
          ...sched,
          activeBlockId: startBlock.id,
          cursor: { blockId: startBlock.id, week: initialCursorWeek(startBlock), groupIndex: 0 },
          updatedAt: now,
        });
      });
      router.push('/program');
    } finally {
      setBusy(false);
    }
  }

  const preset = PRESETS.find((p) => p.id === presetId)!;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/program" className="text-xs text-muted underline">
          &larr; Program
        </Link>
        <h1 className="mt-1 text-3xl font-bold tracking-tight">New program</h1>
        <p className="text-sm text-muted">
          Pick a preset or build a custom sequence. You can edit any block after applying a preset.
        </p>
      </div>

      <section className="space-y-2 rounded-2xl border border-border bg-card p-3">
        <label className="block text-xs font-semibold uppercase tracking-wide text-muted">
          Template
        </label>
        <select
          value={presetId}
          onChange={(e) => applyPreset(e.target.value)}
          className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
        >
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted">{preset.description}</p>
        <p className="text-[11px] text-muted/80">
          Templates pre-fill main work + supplemental for each block in the sequence. You can still
          edit any block individually below — the template is just a starting point.
        </p>
      </section>

      <label className="block">
        <span className="text-xs text-muted">Program name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My cycle"
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
      </label>

      <section className="space-y-2 rounded-2xl border border-border bg-card p-3">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Available equipment
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            Pick a preset or customize. The assistance suggester only proposes
            movements that match what you have.
          </p>
        </div>
        <EquipmentPicker
          value={availableEquipment}
          onChange={setAvailableEquipment}
          showHelp={false}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Blocks</h2>
        <ol className="space-y-3">
          {draft.map((b, i) => (
            <li
              key={i}
              className={`rounded-xl border p-3 ${
                i === startIndex
                  ? 'border-accent bg-accent/5'
                  : i < startIndex
                    ? 'border-border/50 bg-card/50 opacity-70'
                    : 'border-border bg-card'
              }`}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted">#{i + 1}</span>
                  <select
                    value={b.kind}
                    onChange={(e) => update(i, { kind: e.target.value as BlockKind })}
                    className="rounded-md border border-border bg-bg px-2 py-1 text-sm capitalize"
                  >
                    <option value="leader">Leader</option>
                    <option value="anchor">Anchor</option>
                    <option value="standalone">Standalone</option>
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  disabled={draft.length <= 1}
                  className="rounded-md px-2 py-1 text-xs text-muted hover:bg-red-600/10 hover:text-red-300 disabled:opacity-30"
                >
                  Remove
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">Main work</span>
                  <select
                    value={b.scheme}
                    onChange={(e) => update(i, { scheme: e.target.value as MainScheme })}
                    className="mt-0.5 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                  >
                    {MAIN_SCHEMES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide text-muted">
                    Supplemental
                  </span>
                  <select
                    value={b.supplemental}
                    onChange={(e) =>
                      update(i, { supplemental: e.target.value as SupplementalTemplateId })
                    }
                    className="mt-0.5 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                  >
                    {SUPPLEMENTAL_TEMPLATES.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(() => {
                  const isEditable = EDITABLE_SETS_TEMPLATES.has(b.supplemental);
                  const effectiveSets =
                    b.supplementalSets ?? defaultSupplementalSets(b.supplemental);
                  return (
                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wide text-muted">Sets</span>
                      {isEditable ? (
                        <input
                          type="number"
                          min={1}
                          max={10}
                          step={1}
                          value={effectiveSets}
                          onChange={(e) => {
                            const n = Math.max(1, Math.min(10, Math.round(Number(e.target.value))));
                            update(i, { supplementalSets: Number.isFinite(n) ? n : undefined });
                          }}
                          className="mt-0.5 w-16 rounded-md border border-border bg-bg px-2 py-1.5 text-sm"
                          aria-label="Supplemental set count"
                        />
                      ) : (
                        <span className="mt-0.5 inline-flex h-9 w-16 items-center justify-center rounded-md border border-border/50 bg-card/50 px-2 py-1.5 text-sm text-muted">
                          {b.supplemental === 'none' || b.supplemental === 'custom'
                            ? '—'
                            : effectiveSets}
                        </span>
                      )}
                    </label>
                  );
                })()}
              </div>

              <p className="mt-1.5 text-[11px] text-muted">
                Volume:{' '}
                <span className="font-mono text-foreground/80">
                  {volumeLabel(
                    b.supplemental,
                    b.supplementalSets ?? defaultSupplementalSets(b.supplemental),
                  )}
                </span>
                {EDITABLE_SETS_TEMPLATES.has(b.supplemental) && (
                  <>
                    {' · '}
                    <span className="text-muted/70">
                      Forever default {defaultSupplementalSets(b.supplemental)}
                      {b.supplemental === 'bbb' ? '×10' : '×5'}; drop to 3 sets when running cardio
                    </span>
                  </>
                )}
              </p>

              <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="startIndex"
                    checked={i === startIndex}
                    onChange={() => setStartIndex(i)}
                    className="h-3.5 w-3.5 accent-orange-500"
                  />
                  <span className={i === startIndex ? 'text-accent font-semibold' : 'text-muted'}>
                    {i === startIndex ? 'Start here' : 'Start at this block'}
                  </span>
                </label>
              </div>
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => add('leader')}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:border-accent"
          >
            + Leader
          </button>
          <button
            type="button"
            onClick={() => add('anchor')}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:border-accent"
          >
            + Anchor
          </button>
          <button
            type="button"
            onClick={() => add('standalone')}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:border-accent"
          >
            + Standalone
          </button>
        </div>
        {startIndex > 0 && (
          <p className="text-xs text-muted">
            Block{startIndex > 1 ? 's' : ''} 1&ndash;{startIndex} will be recorded as already
            completed (skipped).
          </p>
        )}
      </section>

      <button
        onClick={onCreate}
        disabled={busy || draft.length === 0}
        className="w-full rounded-lg bg-accent py-3 font-semibold text-bg disabled:opacity-50"
      >
        {busy ? 'Creating...' : `Create program (${draft.length} block${draft.length === 1 ? '' : 's'})`}
      </button>
    </div>
  );
}
