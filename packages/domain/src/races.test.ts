import { describe, expect, it } from 'vitest';
import {
  inferDistanceKm,
  formatRaceTime,
  raceLabel,
  seasonView,
  type RaceLike,
} from './races';

const r = (over: Partial<RaceLike>): RaceLike => ({
  id: 'r1',
  name: 'Test Race',
  date: '2026-06-01T08:00:00.000Z',
  kind: 'half-marathon',
  priority: 'B',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('inferDistanceKm', () => {
  it('returns canonical distances for standard kinds', () => {
    expect(inferDistanceKm('5k')).toBe(5);
    expect(inferDistanceKm('10k')).toBe(10);
    expect(inferDistanceKm('half-marathon')).toBeCloseTo(21.0975);
    expect(inferDistanceKm('marathon')).toBeCloseTo(42.195);
  });
  it('returns undefined for kinds without a fixed distance', () => {
    expect(inferDistanceKm('ultra')).toBeUndefined();
    expect(inferDistanceKm('trail')).toBeUndefined();
    expect(inferDistanceKm('triathlon')).toBeUndefined();
    expect(inferDistanceKm('other')).toBeUndefined();
  });
});

describe('formatRaceTime', () => {
  it('formats sub-hour as M:SS', () => {
    expect(formatRaceTime(0)).toBe('0:00');
    expect(formatRaceTime(59)).toBe('0:59');
    expect(formatRaceTime(125)).toBe('2:05');
    expect(formatRaceTime(3599)).toBe('59:59');
  });
  it('formats >= 1h as H:MM:SS', () => {
    expect(formatRaceTime(3600)).toBe('1:00:00');
    expect(formatRaceTime(3661)).toBe('1:01:01');
    expect(formatRaceTime(7245)).toBe('2:00:45');
    expect(formatRaceTime(14400)).toBe('4:00:00');
  });
  it('handles invalid input', () => {
    expect(formatRaceTime(-1)).toBe('');
    expect(formatRaceTime(NaN)).toBe('');
  });
});

describe('raceLabel', () => {
  it('produces a short pill label', () => {
    expect(raceLabel({ priority: 'A', kind: 'marathon' })).toBe('A · marathon');
    expect(raceLabel({ priority: 'B', kind: 'half-marathon' })).toBe('B · half');
    expect(raceLabel({ priority: 'C', kind: '5k' })).toBe('C · 5k');
  });
});

describe('seasonView', () => {
  const now = new Date('2026-05-01T12:00:00.000Z');

  it('splits upcoming and past, sorted', () => {
    const races = [
      r({ id: 'past1', date: '2026-04-01T08:00:00.000Z' }),
      r({ id: 'fut1', date: '2026-06-01T08:00:00.000Z' }),
      r({ id: 'fut2', date: '2026-08-15T08:00:00.000Z' }),
      r({ id: 'past2', date: '2026-03-15T08:00:00.000Z' }),
    ];
    const v = seasonView(races, now);
    expect(v.upcoming.map((x) => x.race.id)).toEqual(['fut1', 'fut2']);
    expect(v.past.map((x) => x.race.id)).toEqual(['past1', 'past2']);
  });

  it('keeps race day in upcoming', () => {
    const races = [r({ id: 'today', date: '2026-05-01T08:00:00.000Z' })];
    const v = seasonView(races, now);
    expect(v.upcoming).toHaveLength(1);
    expect(v.past).toHaveLength(0);
  });

  it('moves completed races to past regardless of date', () => {
    const races = [
      r({
        id: 'r1',
        date: '2026-06-01T08:00:00.000Z',
        completedAt: '2026-05-01T10:00:00.000Z',
      }),
    ];
    const v = seasonView(races, now);
    expect(v.upcoming).toHaveLength(0);
    expect(v.past).toHaveLength(1);
  });

  it('skips races with invalid dates', () => {
    const races = [r({ id: 'bad', date: 'not-a-date' })];
    const v = seasonView(races, now);
    expect(v.upcoming).toHaveLength(0);
    expect(v.past).toHaveLength(0);
  });
});
