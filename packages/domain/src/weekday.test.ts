import { describe, expect, it } from 'vitest';
import {
  describeNextWorkout,
  jsDayToWeekday,
  parseWeekdayFromLabel,
  resolveDayWeekday,
} from './blocks';

describe('parseWeekdayFromLabel', () => {
  it('parses long weekday names', () => {
    expect(parseWeekdayFromLabel('Monday')).toBe(0);
    expect(parseWeekdayFromLabel('Thursday')).toBe(3);
    expect(parseWeekdayFromLabel('sunday')).toBe(6);
  });
  it('parses short weekday prefixes', () => {
    expect(parseWeekdayFromLabel('Mon')).toBe(0);
    expect(parseWeekdayFromLabel('Thu')).toBe(3);
    expect(parseWeekdayFromLabel('Sat')).toBe(5);
  });
  it('tolerates trailing text', () => {
    expect(parseWeekdayFromLabel('Monday — Heavy day')).toBe(0);
    expect(parseWeekdayFromLabel('Thu, leg day')).toBe(3);
  });
  it('returns null for non-matches', () => {
    expect(parseWeekdayFromLabel('')).toBeNull();
    expect(parseWeekdayFromLabel(undefined)).toBeNull();
    expect(parseWeekdayFromLabel('Heavy day')).toBeNull();
  });
});

describe('resolveDayWeekday', () => {
  it('prefers explicit weekday over label', () => {
    expect(resolveDayWeekday({ weekday: 2, label: 'Friday' })).toBe(2);
  });
  it('falls back to label when no weekday', () => {
    expect(resolveDayWeekday({ label: 'Friday' })).toBe(4);
  });
  it('returns null when neither resolves', () => {
    expect(resolveDayWeekday({ label: 'Heavy day' })).toBeNull();
    expect(resolveDayWeekday({})).toBeNull();
  });
});

describe('jsDayToWeekday', () => {
  it('maps JS Sun=0 to internal Sun=6', () => {
    expect(jsDayToWeekday(0)).toBe(6);
    expect(jsDayToWeekday(1)).toBe(0); // Mon
    expect(jsDayToWeekday(4)).toBe(3); // Thu
    expect(jsDayToWeekday(6)).toBe(5); // Sat
  });
});

describe('describeNextWorkout', () => {
  // Reference: Wed 2026-05-06.
  const wed = new Date(2026, 4, 6); // month is 0-indexed

  it('reports today when target weekday matches', () => {
    expect(describeNextWorkout({ targetWeekday: 2, today: wed })).toEqual({
      kind: 'today',
      days: 0,
    });
  });
  it('reports tomorrow', () => {
    expect(describeNextWorkout({ targetWeekday: 3, today: wed })).toEqual({
      kind: 'tomorrow',
      days: 1,
    });
  });
  it('reports in-days for further-out weekdays', () => {
    expect(describeNextWorkout({ targetWeekday: 5, today: wed })).toEqual({
      kind: 'in-days',
      days: 3,
    });
  });
  it('reports overdue when last session was a full week ago and target was earlier this week', () => {
    // Last completed = Mon 2026-04-27 (target weekday). Today = Wed 2026-05-06.
    // Next expected after Mon = Mon 2026-05-04 → 2 days overdue.
    const res = describeNextWorkout({
      targetWeekday: 0,
      today: wed,
      lastCompletedAt: new Date(2026, 3, 27),
    });
    expect(res).toEqual({ kind: 'overdue', days: 2 });
  });
  it('uses next occurrence after lastCompletedAt when in the future', () => {
    // Last completed = Mon 2026-05-04, target = Thursday → next is Thu
    // 2026-05-07 → tomorrow relative to Wed 2026-05-06.
    const res = describeNextWorkout({
      targetWeekday: 3,
      today: wed,
      lastCompletedAt: new Date(2026, 4, 4),
    });
    expect(res).toEqual({ kind: 'tomorrow', days: 1 });
  });
});
