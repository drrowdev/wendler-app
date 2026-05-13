'use client';

import { useMemo } from 'react';
import {
  pushPullBalance,
  weeklyPushPullBalance,
  type MinimalSet,
} from '@wendler/domain';
import type { Movement } from '@wendler/db-schema';
import { fmtWeekBucket } from '@/lib/format';
import { StackedBarChart } from '@/components/charts/StackedBarChart';
import { AnalyticsCard } from './AnalyticsCard';

export function PushPullBalanceCard({
  recentSets,
  priorSets,
  movements,
  weeksToShow,
  windowDays,
}: {
  recentSets: MinimalSet[];
  priorSets: MinimalSet[];
  movements: Movement[] | undefined;
  weeksToShow: number;
  windowDays: number;
}) {
  const balance = useMemo(() => {
    if (!movements) return null;
    return pushPullBalance(recentSets, movements);
  }, [recentSets, movements]);

  const weeklyBalance = useMemo(() => {
    if (!movements) return [];
    return weeklyPushPullBalance(recentSets, movements).slice(-weeksToShow);
  }, [recentSets, movements, weeksToShow]);

  const priorBalance = useMemo(() => {
    if (!movements) return null;
    return pushPullBalance(priorSets, movements);
  }, [priorSets, movements]);

  if (!balance || weeklyBalance.length === 0) return null;

  const balanceRatioDelta =
    balance?.pushPullRatio != null && priorBalance?.pushPullRatio != null
      ? balance.pushPullRatio - priorBalance.pushPullRatio
      : null;

  return (
    <AnalyticsCard title="Push / Pull / Lower / Core balance" badge="strength">
      <p className="-mt-1 mb-3 text-xs text-muted">
        Each bar shows that week&apos;s working sets split into push, pull, lower and
        core. Counted per set so band, bodyweight, and isometric work
        (e.g. pallof press) show up alongside heavy barbell work.
      </p>
      <StackedBarChart
        data={weeklyBalance.map((w) => ({
          label: fmtWeekBucket(w.bucket),
          values: { push: w.push, pull: w.pull, lower: w.lower, core: w.core },
        }))}
        series={[
          { key: 'push', label: 'Push', color: '#3b82f6' },
          { key: 'pull', label: 'Pull', color: '#10b981' },
          { key: 'lower', label: 'Lower', color: '#f59e0b' },
          { key: 'core', label: 'Core', color: '#a855f7' },
        ]}
        formatValue={(n) => `${n} ${n === 1 ? 'set' : 'sets'}`}
      />
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#3b82f6]" /> Push
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#10b981]" /> Pull
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#f59e0b]" /> Lower
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-3 rounded-sm bg-[#a855f7]" /> Core
        </span>
      </div>
      {balance.pushPullRatio != null && (
        <p className="mt-3 text-sm text-muted">
          Current Push : Pull ={' '}
          <span className="font-mono text-fg">
            {balance.pushPullRatio.toFixed(2)}
          </span>{' '}
          {balanceRatioDelta != null && (
            <span
              className={
                Math.abs(balanceRatioDelta) < 0.05
                  ? 'text-muted'
                  : balanceRatioDelta > 0
                    ? 'text-amber-400'
                    : 'text-emerald-400'
              }
            >
              ({balanceRatioDelta > 0 ? '+' : ''}
              {balanceRatioDelta.toFixed(2)} vs prior {windowDays}d)
            </span>
          )}{' '}
          {balance.pushPullRatio < 0.8
            ? '· consider more pressing'
            : balance.pushPullRatio > 1.25
              ? '· consider more pulling'
              : '· well-balanced'}
        </p>
      )}
    </AnalyticsCard>
  );
}
