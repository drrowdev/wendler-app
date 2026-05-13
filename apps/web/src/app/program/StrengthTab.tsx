'use client';

import Link from 'next/link';
import { fmtDate } from '@/lib/format';
import {
  useActiveBlock,
  useAllTrainingMaxes,
  useBlocks,
  usePrograms,
} from '@/lib/hooks';
import { MAIN_SCHEMES, SUPPLEMENTAL_TEMPLATES, type ProgramBlock } from '@wendler/domain';

const SUPPL_NAME: Record<string, string> = Object.fromEntries(
  SUPPLEMENTAL_TEMPLATES.map((s) => [s.id, s.name]),
);
const SCHEME_SHORT: Record<string, string> = Object.fromEntries(
  MAIN_SCHEMES.map((s) => [s.id, s.shortName]),
);

function blockStatus(b: ProgramBlock, activeId?: string) {
  if (b.completedAt && b.id !== activeId) return 'done' as const;
  if (b.id === activeId) return 'active' as const;
  if (b.startedAt) return 'in-progress' as const;
  return 'upcoming' as const;
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  active: { label: 'ACTIVE', cls: 'bg-accent text-bg' },
  done: { label: 'done', cls: 'bg-emerald-600/15 text-emerald-300 ring-1 ring-emerald-600/60' },
  'in-progress': { label: 'in progress', cls: 'bg-emerald-600/20 text-emerald-300' },
  upcoming: { label: 'upcoming', cls: 'bg-card text-muted ring-1 ring-border' },
};

export default function StrengthTab() {
  const blocks = useBlocks();
  const programs = usePrograms();
  const active = useActiveBlock();
  const tms = useAllTrainingMaxes();
  const hasTms = tms && tms.size > 0;

  const blocksByProgram = new Map<string, ProgramBlock[]>();
  const standalone: ProgramBlock[] = [];
  for (const b of blocks ?? []) {
    if (b.programId) {
      const arr = blocksByProgram.get(b.programId) ?? [];
      arr.push(b);
      blocksByProgram.set(b.programId, arr);
    } else {
      standalone.push(b);
    }
  }
  for (const arr of blocksByProgram.values()) {
    arr.sort((a, b) => (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Link
          href="/program/setup"
          className="rounded-lg bg-card px-3 py-2 text-sm ring-1 ring-border hover:ring-accent"
        >
          {hasTms ? 'Edit TMs' : 'Set up TMs'}
        </Link>
      </div>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Programs</h2>
          <Link
            href="/program/new"
            className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
          >
            + New program
          </Link>
        </div>
        {programs && programs.length > 0 ? (
          <ul className="space-y-2">
            {programs.map((p) => {
              const items = blocksByProgram.get(p.id) ?? [];
              const isActive = !!active && items.some((b) => b.id === active.id);
              const doneCount = items.filter((b) => b.completedAt).length;
              return (
                <li key={p.id}>
                  <Link
                    href={`/program/detail?id=${p.id}`}
                    className={`flex items-center justify-between gap-3 rounded-xl border p-3 hover:border-accent ${
                      isActive ? 'border-accent bg-accent/5' : 'border-border bg-card'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-semibold">{p.name}</span>
                        {isActive && (
                          <span className="shrink-0 rounded bg-accent px-1.5 py-0.5 text-[10px] font-semibold text-bg">
                            ACTIVE
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted">
                        {items.length} block{items.length === 1 ? '' : 's'}
                        {doneCount > 0 && ` · ${doneCount} done`} · created {fmtDate(p.createdAt)}
                      </div>
                    </div>
                    <span className="shrink-0 text-muted">›</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">No programs yet. Create one to plan a sequence of blocks.</p>
        )}
      </section>

      {standalone.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Standalone blocks</h2>
          <ul className="space-y-2">
            {standalone.map((b) => {
              const status = blockStatus(b, active?.id);
              const badge = STATUS_BADGE[status]!;
              return (
                <li key={b.id} className="rounded-xl border border-border bg-card p-3">
                  <Link
                    href={`/program/block?id=${b.id}`}
                    className="flex items-center justify-between hover:text-accent"
                  >
                    <div>
                      <div className="font-medium">{b.name}</div>
                      <div className="text-xs text-muted">
                        {b.kind} · {SCHEME_SHORT[b.mainScheme ?? 'classic-531']} +{' '}
                        {SUPPL_NAME[b.supplementalTemplate]} · created {fmtDate(b.createdAt)}
                      </div>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
