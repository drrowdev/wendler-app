'use client';

// Load & Recovery — merged into one route in v311. Previously /load (Banister
// CTL/ATL/TSB, weekly stress, tonnage, deload recommendation, cardio chart)
// and /recovery (muscle freshness, Banister TSB callout, RPE 7d, recovery
// log) were sibling destinations with no cross-link, even though they
// answer the same question — "how recovered am I and how hard am I
// training?". One route, two tabs. Query param `?tab=recovery` opens the
// Recovery panel directly so the old /recovery deep-link and the SWA
// redirect both land in the right place.

import { useState, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { LoadView } from '@/components/load/LoadView';
import { RecoveryView } from '@/components/load/RecoveryView';

type Tab = 'load' | 'recovery';

export default function LoadPage() {
  const router = useRouter();
  const params = useSearchParams();
  const initial: Tab = params.get('tab') === 'recovery' ? 'recovery' : 'load';
  const [tab, setTab] = useState<Tab>(initial);

  // Keep the URL in sync when the user clicks a tab — preserves shareable
  // deep-links and the browser back-button stack.
  useEffect(() => {
    const current = params.get('tab') === 'recovery' ? 'recovery' : 'load';
    if (current === tab) return;
    const next = new URLSearchParams(params.toString());
    if (tab === 'recovery') next.set('tab', 'recovery');
    else next.delete('tab');
    const qs = next.toString();
    router.replace(qs ? `/load?${qs}` : '/load', { scroll: false });
  }, [tab, params, router]);

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Load &amp; recovery</h1>
        <p className="text-xs text-muted">
          {tab === 'load'
            ? 'Banister fitness/fatigue, weekly stress, and deload urgency.'
            : 'Muscle freshness, recent RPE, and recovery log.'}
        </p>
      </header>

      <div role="tablist" aria-label="Load and recovery view" className="flex w-fit gap-1 rounded-lg border border-border bg-card p-0.5 text-sm">
        {(['load', 'recovery'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 font-medium transition ${
              tab === t ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'
            }`}
          >
            {t === 'load' ? 'Training load' : 'Recovery'}
          </button>
        ))}
      </div>

      {tab === 'load' ? <LoadView /> : <RecoveryView />}
    </div>
  );
}
