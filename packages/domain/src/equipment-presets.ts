/**
 * Equipment-availability presets.
 *
 * Lets the user say "this is what I have access to" at the program level
 * (with optional per-block override) so the assistance suggester only
 * proposes movements that match. Mirrors Movement.equipment exactly.
 *
 * Pure data + a tiny resolver. Keep this file dependency-free.
 */

import type { EquipmentType } from './types';

export interface EquipmentPreset {
  id: 'commercial' | 'home-gym' | 'minimal' | 'travel';
  label: string;
  hint: string;
  equipment: EquipmentType[];
}

/**
 * 'bodyweight' is in every preset because bodyweight movements (push-ups,
 * planks, hanging leg raise on a doorway bar, etc.) are functionally always
 * available — gating them on a "no bodyweight" toggle would be hostile.
 */
export const EQUIPMENT_PRESETS: EquipmentPreset[] = [
  {
    id: 'commercial',
    label: 'Commercial gym',
    hint: 'Full equipment — barbell, machines, cables, full DB rack.',
    equipment: ['barbell', 'trap-bar', 'dumbbell', 'kettlebell', 'machine', 'cable', 'band', 'bodyweight', 'sandbag'],
  },
  {
    id: 'home-gym',
    label: 'Home gym',
    hint: 'Barbell + rack + dumbbells + bands. No machines or cables.',
    equipment: ['barbell', 'dumbbell', 'kettlebell', 'band', 'bodyweight'],
  },
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'Barbell + rack only. Limited dumbbells.',
    equipment: ['barbell', 'bodyweight'],
  },
  {
    id: 'travel',
    label: 'Travel / hotel',
    hint: 'Bodyweight + bands only.',
    equipment: ['bodyweight', 'band'],
  },
];

/** All known equipment types — useful for "select all" / fully-permissive default. */
export const ALL_EQUIPMENT: EquipmentType[] = [
  'barbell',
  'trap-bar',
  'dumbbell',
  'kettlebell',
  'sandbag',
  'bodyweight',
  'machine',
  'cable',
  'band',
  'weighted-vest',
  'dip-belt',
  'other',
];

/**
 * Resolve effective equipment availability. Returns undefined ("no constraint")
 * when neither block nor program specifies — back-compat for any pre-existing
 * data and for users who haven't set anything yet.
 */
export function resolveAvailableEquipment(
  blockOverride: EquipmentType[] | undefined,
  programDefault: EquipmentType[] | undefined,
): EquipmentType[] | undefined {
  if (blockOverride && blockOverride.length > 0) return blockOverride;
  if (programDefault && programDefault.length > 0) return programDefault;
  return undefined;
}

/** Best-fit preset for a given equipment set, or undefined if none matches exactly. */
export function presetMatching(equipment: EquipmentType[]): EquipmentPreset | undefined {
  const sorted = [...equipment].sort().join(',');
  return EQUIPMENT_PRESETS.find((p) => [...p.equipment].sort().join(',') === sorted);
}
