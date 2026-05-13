import { describe, expect, it } from 'vitest';
import {
  buildChatContext,
  renderChatContextAsText,
  type MinimalChatCardio,
  type MinimalChatRace,
  type MinimalChatRecovery,
  type MinimalChatSet,
  type MinimalChatTrainingMax,
} from './chat-context';

const NOW = new Date('2026-05-13T12:00:00Z');
const ISO = (d: string) => new Date(d).toISOString();

function emptyInput() {
  return {
    now: NOW,
    sets: [] as MinimalChatSet[],
    cardio: [] as MinimalChatCardio[],
    recovery: [] as MinimalChatRecovery[],
    races: [] as MinimalChatRace[],
    trainingMaxes: [] as MinimalChatTrainingMax[],
  };
}

describe('buildChatContext', () => {
  it('handles entirely empty input', () => {
    const ctx = buildChatContext(emptyInput());
    expect(ctx.currentTms).toEqual([]);
    expect(ctx.recent.cardio).toEqual([]);
    expect(ctx.recent.strengthSessions).toEqual([]);
    expect(ctx.recent.recovery).toEqual([]);
    expect(ctx.weekly).toEqual([]);
    expect(ctx.monthly).toEqual([]);
    expect(ctx.raceTimeline).toEqual([]);
    expect(ctx.prTimeline).toEqual([]);
  });

  it('emits current TMs from newest createdAt per lift', () => {
    const ctx = buildChatContext({
      ...emptyInput(),
      trainingMaxes: [
        { lift: 'squat', trainingMaxKg: 100, createdAt: ISO('2025-01-01') },
        { lift: 'squat', trainingMaxKg: 107.5, createdAt: ISO('2026-04-01') },
        { lift: 'bench', trainingMaxKg: 92.5, createdAt: ISO('2026-04-01') },
      ],
    });
    expect(ctx.currentTms).toEqual([
      { lift: 'bench', kg: 92.5 },
      { lift: 'squat', kg: 107.5 },
    ]);
  });

  it('PR timeline picks the highest TM ever per lift', () => {
    const ctx = buildChatContext({
      ...emptyInput(),
      trainingMaxes: [
        { lift: 'squat', trainingMaxKg: 110, createdAt: ISO('2025-06-01') }, // PR
        { lift: 'squat', trainingMaxKg: 100, createdAt: ISO('2025-01-01') },
        { lift: 'squat', trainingMaxKg: 107.5, createdAt: ISO('2026-04-01') },
      ],
    });
    expect(ctx.prTimeline).toEqual([{ date: '2025-06-01', lift: 'squat', kg: 110 }]);
  });

  it('classifies cardio into recent/weekly/monthly buckets by age', () => {
    const day = (offset: number) => new Date(NOW.getTime() + offset * 86400000).toISOString();
    const ctx = buildChatContext({
      ...emptyInput(),
      cardio: [
        { performedAt: day(-5), modality: 'run', durationSec: 1800, distanceKm: 5 }, // recent
        { performedAt: day(-200), modality: 'run', durationSec: 3600, distanceKm: 10 }, // weekly
        { performedAt: day(-500), modality: 'run', durationSec: 5400, distanceKm: 15 }, // monthly
      ],
    });
    expect(ctx.recent.cardio).toHaveLength(1);
    expect(ctx.weekly.length).toBeGreaterThan(0);
    expect(ctx.monthly.length).toBeGreaterThan(0);
    expect(ctx.recent.cardio[0]).toMatchObject({ distanceKm: 5, durationMin: 30 });
  });

  it('groups recent strength sets per day with tonnage + RPE avg', () => {
    const ctx = buildChatContext({
      ...emptyInput(),
      sets: [
        { performedAt: ISO('2026-05-10T10:00:00Z'), movementId: 'sq', weightKg: 100, reps: 5, rpe: 7 },
        { performedAt: ISO('2026-05-10T10:10:00Z'), movementId: 'sq', weightKg: 100, reps: 5, rpe: 8 },
        { performedAt: ISO('2026-05-10T10:20:00Z'), movementId: 'sq', weightKg: 100, reps: 5, skipped: true },
      ],
      movementName: new Map([['sq', 'Front Squat']]),
    });
    expect(ctx.recent.strengthSessions).toHaveLength(1);
    expect(ctx.recent.strengthSessions[0]).toMatchObject({
      date: '2026-05-10',
      sets: 2,
      tonnageKg: 1000,
      lifts: ['Front Squat'],
      avgRpe: 7.5,
    });
  });

  it('classifies race timeline into upcoming/completed/past', () => {
    const ctx = buildChatContext({
      ...emptyInput(),
      races: [
        { date: ISO('2025-09-01'), name: 'Old race', kind: 'half-marathon', priority: 'B' }, // past, no result
        {
          date: ISO('2025-09-01'),
          name: 'Old race w/ result',
          kind: 'marathon',
          priority: 'A',
          result: { finishTimeSec: 14400 },
        }, // completed
        { date: ISO('2026-06-05'), name: 'Helsinki HM', kind: 'half-marathon', priority: 'A' }, // upcoming
      ],
    });
    expect(ctx.raceTimeline.map((r) => r.status)).toEqual(['past', 'completed', 'upcoming']);
    expect(ctx.raceTimeline[1]?.resultTimeSec).toBe(14400);
  });

  it('renderChatContextAsText produces stable text output with expected sections', () => {
    const ctx = buildChatContext({
      ...emptyInput(),
      trainingMaxes: [{ lift: 'squat', trainingMaxKg: 100, createdAt: ISO('2026-04-01') }],
      races: [{ date: ISO('2026-06-05'), name: 'HM', kind: 'half-marathon', priority: 'A' }],
    });
    const text = renderChatContextAsText(ctx);
    expect(text).toContain('# Training data snapshot');
    expect(text).toContain('## Current training maxes');
    expect(text).toContain('squat: 100');
    expect(text).toContain('## Race timeline');
    expect(text).toContain('HM');
  });
});
