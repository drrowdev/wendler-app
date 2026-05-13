'use client';

import type { ReactNode } from 'react';

/**
 * Card chrome shared by every Analytics card. The page is a flat grid of
 * these so individual cards can be reordered, hidden, or moved to other
 * pages without rewriting their wrapper.
 */
export function AnalyticsCard({
  title,
  badge,
  subtitle,
  children,
}: {
  title: string;
  badge?: 'strength' | 'cardio' | 'combined';
  subtitle?: string;
  children: ReactNode;
}) {
  const badgeStyles: Record<NonNullable<typeof badge>, string> = {
    strength: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
    cardio: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    combined: 'bg-pink-500/15 text-pink-300 border-pink-500/30',
  };
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            {title}
          </h2>
          {badge && (
            <span
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${badgeStyles[badge]}`}
            >
              {badge}
            </span>
          )}
        </div>
        {subtitle && <span className="text-[11px] text-muted">{subtitle}</span>}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}
