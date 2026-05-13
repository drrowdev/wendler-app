import { describe, expect, it } from 'vitest';
import {
  recommendAssistanceVolume,
  type VolumeRecommenderInput,
} from './volume-recommend';

const BASE: VolumeRecommenderInput = {
  block: { kind: 'leader' },
  activeGoalFlavors: [],
};

describe('recommendAssistanceVolume', () => {
  it('uses kind default when no other signals', () => {
    const r = recommendAssistanceVolume({ ...BASE, block: { kind: 'leader' } });
    // v276: leader → standard (supplemental already provides volume)
    expect(r.preset).toBe('standard');
    expect(r.reasons[0]?.signal).toBe('kind-default');
  });

  it('anchors uses high, sevenths uses minimal', () => {
    // v276: anchor → high (room for accessory variety; light supplemental)
    expect(
      recommendAssistanceVolume({ ...BASE, block: { kind: 'anchor' } }).preset,
    ).toBe('high');
    expect(
      recommendAssistanceVolume({
        ...BASE,
        block: { kind: 'seventh-week', seventhWeekKind: 'deload' },
      }).preset,
    ).toBe('minimal');
  });

  it('history anchor wins over kind default when last 2 blocks agree', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' }, // default would be 'standard' (v276)
      prevSameKindBlocks: [
        { assistanceVolume: 'high' },
        { assistanceVolume: 'high' },
      ],
    });
    expect(r.preset).toBe('high');
    expect(r.reasons.some((x) => x.signal === 'history')).toBe(true);
  });

  it('history is ignored when only 1 prior block exists', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' },
      prevSameKindBlocks: [{ assistanceVolume: 'high' }],
    });
    expect(r.preset).toBe('standard');
  });

  it('history is ignored when prior blocks disagree', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' },
      prevSameKindBlocks: [
        { assistanceVolume: 'high' },
        { assistanceVolume: 'standard' },
      ],
    });
    expect(r.preset).toBe('standard');
  });

  it('hypertrophy-heavy goals push up by 1', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' }, // standard baseline (v276)
      activeGoalFlavors: [['hypertrophy'], ['hypertrophy', 'functional']],
    });
    expect(r.preset).toBe('high');
    expect(r.reasons.some((x) => x.signal === 'goal-mix' && x.delta === 1)).toBe(true);
  });

  it('strength-heavy goals push down by 1', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // high baseline (v276)
      activeGoalFlavors: [['strength'], ['strength', 'conditioning']],
    });
    expect(r.preset).toBe('standard');
    expect(r.reasons.some((x) => x.signal === 'goal-mix' && x.delta === -1)).toBe(true);
  });

  it('balanced goals are neutral', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' },
      activeGoalFlavors: [['strength', 'hypertrophy']],
    });
    expect(r.preset).toBe('standard');
    expect(r.reasons.find((x) => x.signal === 'goal-mix')).toBeUndefined();
  });

  it('cardio peak shrinks by 1', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // high baseline → standard with -1 (v276)
      cardioPeakActive: true,
    });
    expect(r.preset).toBe('standard');
    expect(r.reasons.some((x) => x.signal === 'cardio-peak')).toBe(true);
  });

  it('moderate injury (sev 2-3) shrinks by 1', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // high baseline → standard with -1 (v276)
      injurySeverityMax: 3,
    });
    expect(r.preset).toBe('standard');
    expect(r.reasons.some((x) => x.signal === 'injury' && x.delta === -1)).toBe(true);
  });

  it('severe injury (sev >= 4) shrinks by 2', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // high baseline -> minimal (-2, v276)
      injurySeverityMax: 5,
    });
    expect(r.preset).toBe('minimal');
    expect(r.reasons.some((x) => x.signal === 'injury' && x.delta === -2)).toBe(true);
  });

  it('AMRAP regression shrinks by 1', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // high baseline → standard with -1 (v276)
      amrapTrendingDown: true,
    });
    expect(r.preset).toBe('standard');
  });

  it('clamps at minimum: nothing goes below minimal', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'anchor' }, // standard
      cardioPeakActive: true,
      injurySeverityMax: 5, // -2
      amrapTrendingDown: true, // -1
      activeGoalFlavors: [['strength', 'strength']], // -1
    });
    expect(r.preset).toBe('minimal');
  });

  it('clamps at maximum: nothing goes above high', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' }, // high
      activeGoalFlavors: [['hypertrophy'], ['hypertrophy'], ['hypertrophy']],
    });
    expect(r.preset).toBe('high');
  });

  it('skips goal-mix signal for seventh-week blocks', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'seventh-week', seventhWeekKind: 'deload' },
      activeGoalFlavors: [['hypertrophy'], ['hypertrophy']],
    });
    expect(r.preset).toBe('minimal');
    expect(r.reasons.find((x) => x.signal === 'goal-mix')).toBeUndefined();
  });

  it('history with custom volume buckets correctly', () => {
    const r = recommendAssistanceVolume({
      ...BASE,
      block: { kind: 'leader' },
      prevSameKindBlocks: [
        { assistanceVolume: { preset: 'custom', mainDayReps: 130, accessoryReps: 280, accessoryMovements: 9 } },
        { assistanceVolume: 'standard' },
      ],
    });
    expect(r.preset).toBe('standard');
  });
});
