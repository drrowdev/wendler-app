import { describe, it, expect } from 'vitest';
import { suggestedPromptsForPath } from './chat-prompt-hints';

describe('suggestedPromptsForPath', () => {
  it('returns block-specific prompts for /program/block', () => {
    const prompts = suggestedPromptsForPath('/program/block?id=abc');
    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts.map((p) => p.title)).toContain('Why these accessories?');
  });

  it('returns calendar-specific prompts for /calendar', () => {
    const prompts = suggestedPromptsForPath('/calendar');
    expect(prompts.map((p) => p.title).join('|')).toContain('races');
  });

  it('returns cardio-specific prompts for /cardio', () => {
    const prompts = suggestedPromptsForPath('/cardio');
    expect(prompts.length).toBeGreaterThan(0);
  });

  it('returns recovery-specific prompts for /recovery/injuries', () => {
    const prompts = suggestedPromptsForPath('/recovery/injuries');
    expect(prompts.map((p) => p.title)).toContain('Active limitations');
  });

  it('falls back to global prompts for an unknown path', () => {
    const prompts = suggestedPromptsForPath('/some/unknown/route');
    expect(prompts.map((p) => p.title)).toContain('Half-marathon readiness');
  });

  it('falls back to global prompts for undefined path', () => {
    const prompts = suggestedPromptsForPath(undefined);
    expect(prompts.length).toBeGreaterThanOrEqual(3);
  });

  it('caps at 4 prompts per page', () => {
    const prompts = suggestedPromptsForPath('/program/block');
    expect(prompts.length).toBeLessThanOrEqual(4);
  });

  it('home / dashboard gets dashboard prompts', () => {
    expect(suggestedPromptsForPath('/').map((p) => p.title)).toContain("Today's plan");
    expect(suggestedPromptsForPath('/home').map((p) => p.title)).toContain('How am I doing?');
  });
});
