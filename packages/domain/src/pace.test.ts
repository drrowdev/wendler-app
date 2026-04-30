import { describe, it, expect } from 'vitest';
import { pacePRs, formatPaceTime, formatDistance } from './pace';

describe('pacePRs', () => {
  it('returns empty when no efforts', () => {
    expect(pacePRs([])).toEqual([]);
    expect(pacePRs([{ id: 'a', performedAt: '2026-01-01', modality: 'run' }])).toEqual([]);
  });

  it('picks best per distance across activities', () => {
    const out = pacePRs([
      {
        id: 'a',
        performedAt: '2026-01-01',
        modality: 'run',
        bestEffortsSec: { 5000: 1320, 10000: 2820 },
      },
      {
        id: 'b',
        performedAt: '2026-02-01',
        modality: 'run',
        bestEffortsSec: { 5000: 1300, 10000: 2700 },
      },
      {
        id: 'c',
        performedAt: '2026-03-01',
        modality: 'run',
        bestEffortsSec: { 5000: 1310 },
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      distanceM: 5000,
      timeSec: 1300,
      performedAt: '2026-02-01',
      cardioId: 'b',
    });
    expect(out[1]?.timeSec).toBe(2700);
  });

  it('ignores zero / negative / non-finite times', () => {
    expect(
      pacePRs([
        {
          id: 'a',
          performedAt: '2026-01-01',
          modality: 'run',
          bestEffortsSec: { 5000: 0, 10000: -10, 1000: NaN },
        },
      ]),
    ).toEqual([]);
  });
});

describe('formatPaceTime', () => {
  it('mm:ss for sub-hour', () => {
    expect(formatPaceTime(330)).toBe('5:30');
    expect(formatPaceTime(65)).toBe('1:05');
  });
  it('h:mm:ss for hour+', () => {
    expect(formatPaceTime(3725)).toBe('1:02:05');
  });
});

describe('formatDistance', () => {
  it('labels common races', () => {
    expect(formatDistance(1000)).toBe('1 km');
    expect(formatDistance(1609)).toBe('1 mi');
    expect(formatDistance(5000)).toBe('5 km');
    expect(formatDistance(21097)).toBe('Half');
    expect(formatDistance(42195)).toBe('Marathon');
  });
});
