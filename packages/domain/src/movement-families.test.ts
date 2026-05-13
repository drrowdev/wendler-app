import { describe, it, expect } from 'vitest';
import {
  movementFamily,
  isHighSkill,
  isCalfMovement,
  isBicepIsolation,
  isTricepIsolation,
  isRearDeltPrehab,
  isPressMovement,
  isMetabolicConditioning,
  isFatiguingPosteriorChain,
} from './movement-families';

describe('movementFamily', () => {
  it('buckets bilateral deadlift variants under deadlift', () => {
    expect(movementFamily('Deadlift')).toBe('deadlift');
    expect(movementFamily('Sumo Deadlift')).toBe('deadlift');
    expect(movementFamily('Trap Bar Deadlift')).toBe('deadlift');
    expect(movementFamily('Trap-Bar Deadlift')).toBe('deadlift');
    expect(movementFamily('Romanian Deadlift')).toBe('deadlift');
    expect(movementFamily('RDL')).toBe('deadlift');
    expect(movementFamily('Good Morning')).toBe('deadlift');
  });

  it('keeps single-leg RDL OUT of the deadlift family (single-leg instead)', () => {
    expect(movementFamily('Single-Leg RDL')).toBe('single-leg');
    expect(movementFamily('Single Leg Romanian Deadlift')).toBe('single-leg');
    expect(movementFamily('SL-RDL')).toBe('single-leg');
    expect(movementFamily('One-Leg RDL')).toBe('single-leg');
  });

  it('buckets bilateral squat variants under squat', () => {
    expect(movementFamily('Back Squat')).toBe('squat');
    expect(movementFamily('Front Squat')).toBe('squat');
    expect(movementFamily('Zercher Squat')).toBe('squat');
    expect(movementFamily('Safety Bar Squat')).toBe('squat');
    expect(movementFamily('Box Squat')).toBe('squat');
  });

  it('keeps unilateral leg movements as single-leg, not squat', () => {
    expect(movementFamily('Bulgarian Split Squat')).toBe('single-leg');
    expect(movementFamily('BSS')).toBe('single-leg');
    expect(movementFamily('Walking Lunge')).toBe('single-leg');
    expect(movementFamily('Reverse Lunge')).toBe('single-leg');
    expect(movementFamily('Step-Up')).toBe('single-leg');
    expect(movementFamily('Pistol Squat')).toBe('single-leg');
    expect(movementFamily('Shrimp Squat')).toBe('single-leg');
  });

  it('buckets muscle-ups (any grip) together', () => {
    expect(movementFamily('Bar Muscle-up')).toBe('muscle-up');
    expect(movementFamily('Ring Muscle-up')).toBe('muscle-up');
    expect(movementFamily('Muscle Up')).toBe('muscle-up');
  });

  it('buckets olympic variants together', () => {
    expect(movementFamily('Power Clean')).toBe('olympic');
    expect(movementFamily('Hang Clean')).toBe('olympic');
    expect(movementFamily('Snatch')).toBe('olympic');
    expect(movementFamily('Clean and Jerk')).toBe('olympic');
  });

  it('returns undefined for unrelated movements', () => {
    expect(movementFamily('Bench Press')).toBeUndefined();
    expect(movementFamily('Bicep Curl')).toBeUndefined();
    expect(movementFamily('Plank')).toBeUndefined();
    expect(movementFamily('Calf Raise')).toBeUndefined();
  });
});

describe('isHighSkill', () => {
  it('flags elite gymnastics + advanced unilateral skills', () => {
    expect(isHighSkill('Bar Muscle-up')).toBe(true);
    expect(isHighSkill('Ring Muscle-up')).toBe(true);
    expect(isHighSkill('Pistol Squat')).toBe(true);
    expect(isHighSkill('Shrimp Squat')).toBe(true);
    expect(isHighSkill('Handstand Push-up')).toBe(true);
    expect(isHighSkill('HSPU')).toBe(true);
    expect(isHighSkill('One-Arm Push-up')).toBe(true);
    expect(isHighSkill('Front Lever')).toBe(true);
  });

  it('does not flag everyday lifts', () => {
    expect(isHighSkill('Bulgarian Split Squat')).toBe(false);
    expect(isHighSkill('Pull-up')).toBe(false);
    expect(isHighSkill('Push-up')).toBe(false);
    expect(isHighSkill('Dip')).toBe(false);
  });
});

describe('isCalfMovement', () => {
  it('matches calf variants', () => {
    expect(isCalfMovement('Standing Calf Raise')).toBe(true);
    expect(isCalfMovement('Seated Calf Raise')).toBe(true);
    expect(isCalfMovement('Single-Leg Calf Raise')).toBe(true);
    expect(isCalfMovement('Tibialis Raise')).toBe(true);
  });
  it('does not match unrelated isolation', () => {
    expect(isCalfMovement('Lateral Raise')).toBe(false);
    expect(isCalfMovement('Bicep Curl')).toBe(false);
  });
});

describe('isBicepIsolation', () => {
  it('matches direct biceps work', () => {
    expect(isBicepIsolation('Bicep Curl')).toBe(true);
    expect(isBicepIsolation('Hammer Curl')).toBe(true);
    expect(isBicepIsolation('Preacher Curl')).toBe(true);
    expect(isBicepIsolation('Concentration Curl')).toBe(true);
  });
  it('does not match compound pulling', () => {
    expect(isBicepIsolation('Chin-up')).toBe(false);
    expect(isBicepIsolation('Pull-up')).toBe(false);
    expect(isBicepIsolation('Barbell Row')).toBe(false);
  });
});

describe('isTricepIsolation', () => {
  it('matches direct triceps work', () => {
    expect(isTricepIsolation('Tricep Push-down')).toBe(true);
    expect(isTricepIsolation('Skull Crusher')).toBe(true);
    expect(isTricepIsolation('Overhead Tricep Extension')).toBe(true);
    expect(isTricepIsolation('Kickback')).toBe(true);
    expect(isTricepIsolation('JM Press')).toBe(true);
  });
  it('does not match compound pressing', () => {
    expect(isTricepIsolation('Bench Press')).toBe(false);
    expect(isTricepIsolation('Dip')).toBe(false);
    expect(isTricepIsolation('Close-Grip Bench Press')).toBe(false);
  });
});

describe('isRearDeltPrehab', () => {
  it('matches rear-delt / shoulder-health prehab', () => {
    expect(isRearDeltPrehab('Face Pull')).toBe(true);
    expect(isRearDeltPrehab('Band Pull-Apart')).toBe(true);
    expect(isRearDeltPrehab('Reverse Fly')).toBe(true);
    expect(isRearDeltPrehab('Rear Delt Fly')).toBe(true);
    expect(isRearDeltPrehab('Prone Y')).toBe(true);
    expect(isRearDeltPrehab('External Rotation')).toBe(true);
  });
});

describe('isPressMovement', () => {
  it('matches pressing variants', () => {
    expect(isPressMovement('Bench Press')).toBe(true);
    expect(isPressMovement('Overhead Press')).toBe(true);
    expect(isPressMovement('Push Press')).toBe(true);
    expect(isPressMovement('Close-Grip Bench Press')).toBe(true);
    expect(isPressMovement('Dip')).toBe(true);
    expect(isPressMovement('Push-up')).toBe(true);
    expect(isPressMovement('Incline Press')).toBe(true);
  });
});

describe('isMetabolicConditioning', () => {
  it('flags CNS-taxing conditioning hybrids', () => {
    expect(isMetabolicConditioning('Devil Press')).toBe(true);
    expect(isMetabolicConditioning('Burpee')).toBe(true);
    expect(isMetabolicConditioning('Thruster')).toBe(true);
    expect(isMetabolicConditioning('Kettlebell Swing')).toBe(true);
    expect(isMetabolicConditioning('Wall Ball')).toBe(true);
    expect(isMetabolicConditioning('Man-maker')).toBe(true);
  });
});

describe('isFatiguingPosteriorChain', () => {
  it('flags any rep range for bilateral deadlift variants', () => {
    expect(isFatiguingPosteriorChain('Deadlift', 5)).toBe(true);
    expect(isFatiguingPosteriorChain('Romanian Deadlift', 8)).toBe(true);
    expect(isFatiguingPosteriorChain('Trap Bar Deadlift', 12)).toBe(true);
  });
  it('flags single-leg RDL only at high reps (≥10)', () => {
    expect(isFatiguingPosteriorChain('Single-Leg RDL', 6)).toBe(false);
    expect(isFatiguingPosteriorChain('Single-Leg RDL', 12)).toBe(true);
  });
  it('does not flag unrelated movements', () => {
    expect(isFatiguingPosteriorChain('Bench Press', 12)).toBe(false);
    expect(isFatiguingPosteriorChain('Bulgarian Split Squat', 12)).toBe(false);
  });
});
