'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MainLift } from '@wendler/db-schema';
import type { WendlerWeek } from '@wendler/domain';
import { useActiveBlock, useSchedule, useSession } from '@/lib/hooks';

/**
 * Compatibility redirect: /session is now a thin shim that resolves the
 * canonical /day URL for the requested workout and replaces the history
 * entry. All logging — single-lift, multi-lift, accessory, 7th week — runs
 * through /day so the start/log/save flow is identical regardless of
 * workout type.
 *
 * Supported inputs:
 *   /session?id=<sessionId>                 — resume an existing session row
 *   /session?lift=<MainLift>&week=<W>       — start the active block's day
 *   /session?supplemental=<id>              — preserved as ?supplemental on /day
 */
export default function SessionRedirectPage() {
  return (
    <Suspense fallback={<p className="text-muted">Redirecting…</p>}>
      <SessionRedirect />
    </Suspense>
  );
}

function SessionRedirect() {
  const router = useRouter();
  const params = useSearchParams();

  const sessionId = params.get('id');
  const liftParam = params.get('lift') as MainLift | null;
  const weekRaw = params.get('week');
  const supplementalParam = params.get('supplemental');

  const week: WendlerWeek | null =
    weekRaw === 'deload'
      ? 'deload'
      : weekRaw === '7w'
        ? '7w'
        : weekRaw === '1' || weekRaw === '2' || weekRaw === '3'
          ? (Number(weekRaw) as 1 | 2 | 3)
          : null;

  const existing = useSession(sessionId ?? undefined);
  const activeBlock = useActiveBlock();
  const schedule = useSchedule();

  useEffect(() => {
    // Resume-by-id path: wait for the session row to load, then redirect to
    // its (blockId, week, dayIndex). If the row is missing required metadata
    // (legacy stand-alone session), fall back to the home page.
    if (sessionId) {
      if (existing === undefined) return; // still loading
      if (!existing) {
        router.replace('/');
        return;
      }
      if (existing.blockId && existing.week != null && existing.dayIndex != null) {
        const sp = new URLSearchParams();
        sp.set('blockId', existing.blockId);
        sp.set('week', String(existing.week));
        sp.set('day', String(existing.dayIndex));
        if (existing.supplementalTemplateId) {
          sp.set('supplemental', existing.supplementalTemplateId);
        }
        router.replace(`/day?${sp.toString()}`);
        return;
      }
      // Legacy stand-alone session without block metadata: nothing for /day to
      // render; bounce home so the user picks a current workout.
      router.replace('/');
      return;
    }

    // Start-by-lift path: need active block + schedule to compute the day.
    if (!liftParam || !week) {
      router.replace('/');
      return;
    }
    if (activeBlock === undefined || schedule === undefined) return; // loading
    if (!activeBlock || !schedule) {
      router.replace('/');
      return;
    }
    const dayIdx = Math.max(0, schedule.dayOrder.indexOf(liftParam));
    const sp = new URLSearchParams();
    sp.set('blockId', activeBlock.id);
    sp.set('week', String(week));
    sp.set('day', String(dayIdx));
    if (supplementalParam) sp.set('supplemental', supplementalParam);
    router.replace(`/day?${sp.toString()}`);
  }, [sessionId, existing, liftParam, week, supplementalParam, activeBlock, schedule, router]);

  return <p className="text-sm text-muted">Redirecting to workout…</p>;
}
