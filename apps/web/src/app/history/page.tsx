'use client';

import { useMemo } from 'react';
import { RecentSessionsList } from '@/components/RecentSessionsList';
import {
  useAllCardio,
  useAllStrengthHr,
  useRecentWorkoutDays,
} from '@/lib/hooks';

export default function HistoryPage() {
  const days = useRecentWorkoutDays(200);
  const cardio = useAllCardio();
  const importedStrength = useAllStrengthHr();
  const sortedCardio = useMemo(
    () =>
      [...(cardio ?? [])].sort((a, b) =>
        a.performedAt < b.performedAt ? 1 : -1,
      ),
    [cardio],
  );
  const sortedImported = useMemo(
    () =>
      [...(importedStrength ?? [])].sort((a, b) =>
        a.performedAt < b.performedAt ? 1 : -1,
      ),
    [importedStrength],
  );
  const empty =
    (days?.length ?? 0) === 0 &&
    sortedCardio.length === 0 &&
    sortedImported.length === 0;
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold tracking-tight">History</h1>
      {days && empty && (
        <p className="text-sm text-muted">No sessions logged yet.</p>
      )}
      <RecentSessionsList
        days={days ?? []}
        cardio={sortedCardio}
        importedStrength={sortedImported}
      />
    </div>
  );
}
