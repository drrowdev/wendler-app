'use client';

import Link from 'next/link';
import { useMovements } from '@/lib/hooks';

export default function MovementsPage() {
  const movements = useMovements();
  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Movements</h1>
          <p className="text-sm text-muted">{movements?.length ?? 0} in your library</p>
        </div>
        <Link
          href="/movements/new"
          className="rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg"
        >
          + New
        </Link>
      </header>
      <ul className="space-y-2">
        {movements?.map((m) => (
          <li
            key={m.id}
            className="flex items-center gap-2 rounded-xl border border-border bg-card p-3"
          >
            <Link
              href={`/movements/history?id=${encodeURIComponent(m.id)}`}
              className="flex min-w-0 flex-1 items-center gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">
                  {m.name}
                  {m.isMainLift && (
                    <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-xs font-semibold text-bg">
                      MAIN
                    </span>
                  )}
                  {m.isCustom && (
                    <span className="ml-2 rounded bg-card px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
                      custom
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  {m.equipment} · {m.pattern} · {m.primaryMuscles.join(', ')}
                </div>
              </div>
              <span className="shrink-0 text-xs text-muted">History ›</span>
            </Link>
            <Link
              href={`/movements/edit?id=${encodeURIComponent(m.id)}`}
              className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:border-accent hover:text-fg"
              aria-label={`Edit ${m.name}`}
            >
              Edit
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
