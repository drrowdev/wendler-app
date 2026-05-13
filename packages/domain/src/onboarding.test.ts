import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_INITIAL,
  nextOnboardingStep,
  parseTrainingMaxInput,
  shouldOpenOnboarding,
} from './onboarding';

describe('shouldOpenOnboarding', () => {
  it('opens on a fresh install', () => {
    expect(
      shouldOpenOnboarding({ hasSchedule: false, hasBlocks: false, urlForceFlag: false }),
    ).toBe(true);
  });
  it('stays closed once the user has any blocks', () => {
    expect(
      shouldOpenOnboarding({ hasSchedule: false, hasBlocks: true, urlForceFlag: false }),
    ).toBe(false);
  });
  it('stays closed once the schedule singleton exists', () => {
    expect(
      shouldOpenOnboarding({ hasSchedule: true, hasBlocks: false, urlForceFlag: false }),
    ).toBe(false);
  });
  it('opens regardless of state when the URL flag is set', () => {
    expect(
      shouldOpenOnboarding({ hasSchedule: true, hasBlocks: true, urlForceFlag: true }),
    ).toBe(true);
  });
});

describe('nextOnboardingStep', () => {
  it('starts at 1 with no progress', () => {
    expect(nextOnboardingStep(ONBOARDING_INITIAL)).toBe(1);
  });
  it('skips past TMs once they were completed', () => {
    expect(
      nextOnboardingStep({ ...ONBOARDING_INITIAL, tmDone: true }),
    ).toBe(2);
  });
  it('also skips past TMs when explicitly skipped', () => {
    expect(
      nextOnboardingStep({ ...ONBOARDING_INITIAL, tmSkipped: true }),
    ).toBe(2);
  });
  it('lands on race step after schedule', () => {
    expect(
      nextOnboardingStep({
        ...ONBOARDING_INITIAL,
        tmDone: true,
        scheduleDone: true,
      }),
    ).toBe(3);
  });
  it('lands on done after race is handled', () => {
    expect(
      nextOnboardingStep({
        ...ONBOARDING_INITIAL,
        tmDone: true,
        scheduleDone: true,
        raceHandled: true,
      }),
    ).toBe('done');
  });
});

describe('parseTrainingMaxInput', () => {
  it('rejects empty', () => {
    const r = parseTrainingMaxInput('', 'kg');
    expect(r.ok).toBe(false);
  });
  it('rejects non-positive', () => {
    expect(parseTrainingMaxInput('0', 'kg').ok).toBe(false);
    expect(parseTrainingMaxInput('-50', 'kg').ok).toBe(false);
  });
  it('rejects nonsense', () => {
    expect(parseTrainingMaxInput('hello', 'kg').ok).toBe(false);
  });
  it('rejects implausibly high values', () => {
    const r = parseTrainingMaxInput('999', 'kg');
    expect(r.ok).toBe(false);
  });
  it('accepts kg without conversion', () => {
    const r = parseTrainingMaxInput('142.5', 'kg');
    expect(r).toEqual({ ok: true, kg: 142.5 });
  });
  it('converts lb to kg and rounds to nearest 0.5', () => {
    const r = parseTrainingMaxInput('315', 'lb');
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 315 lb ≈ 142.88 kg → rounded to 143 (nearest 0.5)
      expect(r.kg).toBe(143);
    }
  });
});
