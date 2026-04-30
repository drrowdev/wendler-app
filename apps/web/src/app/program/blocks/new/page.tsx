'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { nanoid } from 'nanoid';
import {
  DEFAULT_DAY_ORDER,
  SUPPLEMENTAL_TEMPLATES,
  type BlockKind,
  type MainLift,
  type SupplementalTemplateId,
} from '@wendler/domain';
import { getDb } from '@/lib/db';
import { MAIN_LIFTS } from '@/lib/format';

export default function NewBlockPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BlockKind>('leader');
  const [supplemental, setSupplemental] = useState<SupplementalTemplateId>('fsl');
  const [includesDeload, setIncludesDeload] = useState(true);
  const [activate, setActivate] = useState(true);
  const [tmOverrides, setTmOverrides] = useState<Record<MainLift, string>>({
    press: '',
    deadlift: '',
    bench: '',
    squat: '',
  });

  const onCreate = async () => {
    const db = getDb();
    const id = nanoid();
    const now = new Date().toISOString();
    const tmPercentByLift: Partial<Record<MainLift, number>> = {};
    for (const l of MAIN_LIFTS) {
      const v = parseFloat(tmOverrides[l.key]);
      if (isFinite(v) && v > 50 && v < 100) tmPercentByLift[l.key] = v / 100;
    }
    await db.blocks.add({
      id,
      name:
        name.trim() ||
        `${kind === 'leader' ? 'Leader' : kind === 'anchor' ? 'Anchor' : 'Block'} — ${new Date().toLocaleDateString('fi-FI')}`,
      kind,
      weeksBeforeDeload: 3,
      includesDeload,
      supplementalTemplate: supplemental,
      tmPercentByLift: Object.keys(tmPercentByLift).length ? tmPercentByLift : undefined,
      createdAt: now,
      ...(activate && { startedAt: now }),
    });
    if (activate) {
      const sched = (await db.schedule.get('singleton')) ?? {
        id: 'singleton' as const,
        dayOrder: [...DEFAULT_DAY_ORDER],
        updatedAt: now,
      };
      await db.schedule.put({
        ...sched,
        activeBlockId: id,
        cursor: { blockId: id, week: 1, dayIndex: 0 },
        updatedAt: now,
      });
    }
    router.push('/program');
  };

  const kindHint: Record<BlockKind, string> = {
    leader: 'Volume-heavy (BBB/SSL/FSL). Builds work capacity. Usually 2 in a row.',
    anchor: 'Strength-focused. FSL or FSL AMRAP. Usually 1 after the leaders.',
    standalone: 'One-off block — pick any template.',
  };

  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">New block</h1>

      <label className="block">
        <span className="text-xs text-muted">Name (optional)</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={kind === 'leader' ? 'Leader 1' : kind === 'anchor' ? 'Anchor' : 'Block'}
          className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
      </label>

      <div>
        <span className="block text-xs text-muted">Kind</span>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {(['leader', 'anchor', 'standalone'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-lg px-3 py-2 text-sm capitalize ring-1 ${
                kind === k
                  ? 'bg-accent text-bg ring-accent font-semibold'
                  : 'bg-card text-fg ring-border'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">{kindHint[kind]}</p>
      </div>

      <div>
        <span className="block text-xs text-muted">Supplemental template</span>
        <div className="mt-1 grid gap-2">
          {SUPPLEMENTAL_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSupplemental(t.id)}
              className={`rounded-lg border p-3 text-left ${
                supplemental === t.id
                  ? 'border-accent bg-accent/10'
                  : 'border-border bg-card hover:border-accent/50'
              }`}
            >
              <div className="font-medium">{t.name}</div>
              <div className="text-xs text-muted">{t.description}</div>
            </button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={includesDeload}
          onChange={(e) => setIncludesDeload(e.target.checked)}
          className="h-4 w-4 accent-orange-500"
        />
        <span className="text-sm">Include deload week</span>
      </label>

      <details className="rounded-lg border border-border bg-card p-3">
        <summary className="cursor-pointer text-sm font-medium">
          TM% per lift (optional override)
        </summary>
        <p className="mt-2 text-xs text-muted">
          Wendler convention: Leader 85%, Anchor 85–90%. Leave blank to use the default from
          settings.
        </p>
        <div className="mt-2 grid grid-cols-2 gap-2">
          {MAIN_LIFTS.map((l) => (
            <label key={l.key} className="block">
              <span className="text-xs text-muted">{l.label}</span>
              <input
                type="number"
                inputMode="numeric"
                placeholder="85"
                value={tmOverrides[l.key]}
                onChange={(e) =>
                  setTmOverrides((s) => ({ ...s, [l.key]: e.target.value }))
                }
                className="mt-1 w-full rounded-lg border border-border bg-bg px-3 py-2"
              />
            </label>
          ))}
        </div>
      </details>

      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={activate}
          onChange={(e) => setActivate(e.target.checked)}
          className="h-4 w-4 accent-orange-500"
        />
        <span className="text-sm">Make this the active block (start now)</span>
      </label>

      <button
        onClick={onCreate}
        className="w-full rounded-lg bg-accent py-3 font-semibold text-bg"
      >
        Create block
      </button>
    </div>
  );
}
