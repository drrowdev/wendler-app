import type { Movement } from './types';

/**
 * Built-in movement library. Stable IDs use the prefix `seed:` so they never collide with
 * user-created movements.
 */
export const SEED_MOVEMENTS: Movement[] = [
  // The Big Four (5/3/1 main lifts)
  {
    id: 'seed:back-squat',
    name: 'Back Squat',
    equipment: 'barbell',
    pattern: 'squat',
    primaryMuscles: ['quads', 'glutes'],
    secondaryMuscles: ['hamstrings', 'core', 'erectors'],
    isMainLift: 'squat',
  },
  {
    id: 'seed:bench-press',
    name: 'Bench Press',
    equipment: 'barbell',
    pattern: 'push-horizontal',
    primaryMuscles: ['chest'],
    secondaryMuscles: ['triceps', 'shoulders'],
    isMainLift: 'bench',
  },
  {
    id: 'seed:deadlift',
    name: 'Deadlift',
    equipment: 'barbell',
    pattern: 'hinge',
    primaryMuscles: ['hamstrings', 'glutes', 'erectors'],
    secondaryMuscles: ['back', 'lats', 'traps', 'forearms'],
    isMainLift: 'deadlift',
  },
  {
    id: 'seed:overhead-press',
    name: 'Overhead Press',
    equipment: 'barbell',
    pattern: 'push-vertical',
    primaryMuscles: ['shoulders'],
    secondaryMuscles: ['triceps', 'core'],
    isMainLift: 'press',
  },

  // Common supplemental / assistance
  {
    id: 'seed:front-squat',
    name: 'Front Squat',
    equipment: 'barbell',
    pattern: 'squat',
    primaryMuscles: ['quads'],
    secondaryMuscles: ['core', 'glutes', 'erectors'],
  },
  {
    id: 'seed:romanian-deadlift',
    name: 'Romanian Deadlift',
    equipment: 'barbell',
    pattern: 'hinge',
    primaryMuscles: ['hamstrings', 'glutes'],
    secondaryMuscles: ['erectors', 'forearms'],
  },
  {
    id: 'seed:incline-bench',
    name: 'Incline Bench Press',
    equipment: 'barbell',
    pattern: 'push-horizontal',
    primaryMuscles: ['chest', 'shoulders'],
    secondaryMuscles: ['triceps'],
  },
  {
    id: 'seed:close-grip-bench',
    name: 'Close-Grip Bench Press',
    equipment: 'barbell',
    pattern: 'push-horizontal',
    primaryMuscles: ['triceps'],
    secondaryMuscles: ['chest', 'shoulders'],
  },

  // Pulling
  {
    id: 'seed:pullup',
    name: 'Pull-up',
    equipment: 'bodyweight',
    pattern: 'pull-vertical',
    primaryMuscles: ['lats', 'back'],
    secondaryMuscles: ['biceps', 'forearms'],
  },
  {
    id: 'seed:chinup',
    name: 'Chin-up',
    equipment: 'bodyweight',
    pattern: 'pull-vertical',
    primaryMuscles: ['lats', 'biceps'],
    secondaryMuscles: ['back', 'forearms'],
  },
  {
    id: 'seed:barbell-row',
    name: 'Barbell Row',
    equipment: 'barbell',
    pattern: 'pull-horizontal',
    primaryMuscles: ['back', 'lats'],
    secondaryMuscles: ['biceps', 'forearms', 'erectors'],
  },
  {
    id: 'seed:db-row',
    name: 'Dumbbell Row',
    equipment: 'dumbbell',
    pattern: 'pull-horizontal',
    primaryMuscles: ['back', 'lats'],
    secondaryMuscles: ['biceps', 'forearms'],
  },

  // Accessories
  {
    id: 'seed:db-bench',
    name: 'Dumbbell Bench Press',
    equipment: 'dumbbell',
    pattern: 'push-horizontal',
    primaryMuscles: ['chest'],
    secondaryMuscles: ['triceps', 'shoulders'],
  },
  {
    id: 'seed:db-shoulder-press',
    name: 'Dumbbell Shoulder Press',
    equipment: 'dumbbell',
    pattern: 'push-vertical',
    primaryMuscles: ['shoulders'],
    secondaryMuscles: ['triceps'],
  },
  {
    id: 'seed:lunge',
    name: 'Walking Lunge',
    equipment: 'dumbbell',
    pattern: 'squat',
    primaryMuscles: ['quads', 'glutes'],
    secondaryMuscles: ['hamstrings', 'core'],
  },
  {
    id: 'seed:dip',
    name: 'Dip',
    equipment: 'bodyweight',
    pattern: 'push-horizontal',
    primaryMuscles: ['chest', 'triceps'],
    secondaryMuscles: ['shoulders'],
  },
  {
    id: 'seed:hanging-leg-raise',
    name: 'Hanging Leg Raise',
    equipment: 'bodyweight',
    pattern: 'core',
    primaryMuscles: ['core'],
    secondaryMuscles: ['obliques', 'forearms'],
  },
  {
    id: 'seed:plank',
    name: 'Plank',
    equipment: 'bodyweight',
    pattern: 'core',
    primaryMuscles: ['core'],
    secondaryMuscles: ['obliques', 'shoulders'],
  },
  {
    id: 'seed:farmer-carry',
    name: 'Farmer Carry',
    equipment: 'dumbbell',
    pattern: 'carry',
    primaryMuscles: ['forearms', 'traps'],
    secondaryMuscles: ['core', 'shoulders'],
  },
  {
    id: 'seed:db-curl',
    name: 'Dumbbell Curl',
    equipment: 'dumbbell',
    pattern: 'pull-horizontal',
    primaryMuscles: ['biceps'],
    secondaryMuscles: ['forearms'],
  },
];
