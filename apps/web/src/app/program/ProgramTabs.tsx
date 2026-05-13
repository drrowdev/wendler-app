'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import StrengthTab from './StrengthTab';
import CardioTab from './CardioTab';

type TabId = 'strength' | 'cardio';

export default function ProgramTabs() {
  const params = useSearchParams();
  const raw = params.get('tab');
  const tab: TabId = raw === 'cardio' ? 'cardio' : 'strength';

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Program</h1>
        <p className="text-sm text-muted">
          {tab === 'cardio'
            ? 'Weekly run plan and this week’s adherence.'
            : 'Programs, blocks, and Training Maxes.'}
        </p>
      </header>

      <div
        role="tablist"
        aria-label="Program section"
        className="inline-flex rounded-lg border border-border bg-card p-1 text-sm"
      >
        <TabLink id="strength" current={tab} label="Strength" />
        <TabLink id="cardio" current={tab} label="Cardio" />
      </div>

      <div role="tabpanel">
        {tab === 'cardio' ? <CardioTab /> : <StrengthTab />}
      </div>
    </div>
  );
}

function TabLink({
  id,
  current,
  label,
}: {
  id: TabId;
  current: TabId;
  label: string;
}) {
  const active = id === current;
  const href = id === 'strength' ? '/program' : `/program?tab=${id}`;
  return (
    <Link
      href={href}
      role="tab"
      aria-selected={active}
      scroll={false}
      className={`rounded-md px-3 py-1.5 font-medium transition-colors ${
        active ? 'bg-accent text-bg' : 'text-muted hover:text-fg'
      }`}
    >
      {label}
    </Link>
  );
}
