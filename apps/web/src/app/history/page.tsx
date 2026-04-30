'use client';

import Link from 'next/link';
import { fmtDate, liftLabel } from '@/lib/format';
import { useSessionsRecent } from '@/lib/hooks';

export default function HistoryPage() {
  const sessions = useSessionsRecent(50);
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">History</h1>
      {sessions && sessions.length === 0 && (
        <p className="text-sm text-muted">No sessions logged yet.</p>
      )}
      <ul className="space-y-2">
        {sessions?.map((s) => (
          <li key={s.id}>
            <Link
              href={`/session?id=${s.id}`}
              className="flex items-center justify-between rounded-xl border border-border bg-card p-3 hover:border-accent"
            >
              <span>
                <span className="font-medium">
                  {s.mainLift ? liftLabel(s.mainLift) : 'Session'}
                </span>
                {s.week && (
                  <span className="ml-2 text-xs text-muted">
                    {s.week === 'deload' ? 'Deload' : `Week ${s.week}`}
                  </span>
                )}
              </span>
              <span className="text-xs text-muted">{fmtDate(s.performedAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
