'use client';

// "Bring movements from another block" — small picker that copies the
// assistance lists (per-day defaults + per-week overrides) from a sibling
// block in the same program into the current block.
//
// Days are matched by position (index). Source days beyond the current
// block's day count are ignored; current days beyond the source block's
// day count are left untouched.
//
// The trigger is hidden when there is no sibling block in the same program
// that actually has any assistance entries to copy — so it never shows up
// as a dead button.

import { useMemo, useState } from 'react';
import { nanoid } from 'nanoid';
import {
  derivePlan,
  type AssistanceEntry,
  type BlockPlan,
} from '@wendler/domain';
import type { ProgramBlock, ProgramSchedule } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useBlocks } from '@/lib/hooks';
import { kickSync } from '@/lib/sync';
import { trackLocalSave } from '@/lib/save-status';

interface Props {
  block: ProgramBlock;
  schedule: ProgramSchedule | undefined;
}

function planOf(
  block: ProgramBlock,
  schedule: ProgramSchedule | undefined,
): BlockPlan {
  if (block.plan) return block.plan;
  return schedule
    ? derivePlan(block, schedule)
    : derivePlan(block, ['press', 'deadlift', 'bench', 'squat'], 1);
}

function hasAnyAssistance(plan: BlockPlan): boolean {
  if (plan.days.some((d) => d.assistance.length > 0)) return true;
  const ov = plan.assistanceOverrides;
  if (!ov) return false;
  return Object.values(ov).some((entries) => entries.length > 0);
}

export function BringMovementsButton({ block, schedule }: Props) {
  const allBlocks = useBlocks();
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  // Candidate sources: same program, different block, has any assistance.
  const candidates = useMemo(() => {
    if (!allBlocks) return [];
    return allBlocks
      .filter(
        (b) =>
          b.id !== block.id &&
          b.programId &&
          b.programId === block.programId &&
          hasAnyAssistance(planOf(b, schedule)),
      )
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''));
  }, [allBlocks, block.id, block.programId, schedule]);

  if (!block.programId || candidates.length === 0) return null;

  const targetPlan = planOf(block, schedule);
  const targetHasContent = hasAnyAssistance(targetPlan);

  async function applyFrom(sourceBlock: ProgramBlock) {
    if (busy) return;
    if (
      targetHasContent &&
      !confirm(
        `Replace this block's existing assistance with movements copied from "${sourceBlock.name}"? Main lifts, day labels and per-day settings stay as they are.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const sourcePlan = planOf(sourceBlock, schedule);
      const sourceDays = sourcePlan.days;
      const sourceOverrides = sourcePlan.assistanceOverrides ?? {};

      // Build per-position dayId remap (source dayId -> target dayId).
      // After v21 the base `assistance` is empty so we ONLY copy the
      // per-week store; the target's base also stays empty.
      const remap = new Map<string, string>();
      const nextDays = targetPlan.days.map((d, i) => {
        const src = sourceDays[i];
        if (!src) return d;
        remap.set(src.id, d.id);
        return {
          ...d,
          assistance: [],
        };
      });

      const nextOverrides: Record<string, AssistanceEntry[]> = {};
      for (const [key, entries] of Object.entries(sourceOverrides)) {
        const sep = key.indexOf('|');
        if (sep < 0) continue;
        const week = key.slice(0, sep);
        const srcDayId = key.slice(sep + 1);
        const targetDayId = remap.get(srcDayId);
        if (!targetDayId) continue;
        nextOverrides[`${week}|${targetDayId}`] = entries.map((e) => ({
          ...e,
          id: nanoid(),
        }));
      }

      const nextPlan: BlockPlan = {
        ...targetPlan,
        days: nextDays,
        assistanceOverrides: Object.keys(nextOverrides).length
          ? nextOverrides
          : undefined,
      };

      await trackLocalSave(
        () =>
          getDb().blocks.update(block.id, {
            plan: nextPlan,
            updatedAt: new Date().toISOString(),
          }),
        () => void applyFrom(sourceBlock),
      );
      kickSync();
      setPicking(false);
    } finally {
      setBusy(false);
    }
  }

  // Single candidate — render a direct button to keep the UI minimal.
  if (candidates.length === 1) {
    const src = candidates[0]!;
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void applyFrom(src)}
          disabled={busy}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-50"
          title={`Copy assistance lists from "${src.name}" into this block, matching by day position. Main lifts and day labels stay as they are.`}
        >
          {busy ? 'Copying…' : `Bring movements from "${src.name}"`}
        </button>
      </div>
    );
  }

  // Multiple candidates — show a dropdown of source blocks.
  return (
    <div className="flex justify-end">
      <div className="relative">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          disabled={busy}
          className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted hover:border-accent hover:text-fg disabled:opacity-50"
          aria-haspopup="menu"
          aria-expanded={picking}
        >
          {busy ? 'Copying…' : 'Bring movements from another block ▾'}
        </button>
        {picking && !busy && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-64 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
          >
            {candidates.map((c) => (
              <button
                key={c.id}
                type="button"
                role="menuitem"
                onClick={() => void applyFrom(c)}
                className="block w-full px-3 py-2 text-left text-sm hover:bg-bg"
              >
                {c.name}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="block w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted hover:bg-bg"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
