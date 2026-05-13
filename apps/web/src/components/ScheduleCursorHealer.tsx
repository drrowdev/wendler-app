'use client';

import { useScheduleCursorSelfHeal } from '@/lib/hooks';

/**
 * Mounts the cursor self-heal hook once at the root layout. Rewinds the
 * persisted schedule cursor when the active block has zero sessions but
 * the cursor is past the start - typically after the user deletes an
 * in-progress workout that had already advanced the cursor.
 */
export function ScheduleCursorHealer() {
  useScheduleCursorSelfHeal();
  return null;
}
