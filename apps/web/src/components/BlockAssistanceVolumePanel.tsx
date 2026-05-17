'use client';

// Block-level assistance-volume picker. Mirrors the visual style of the
// deload-scaling auto-scaled banner (sky-toned strip) but is an inline
// editable preset chip group. Custom mode reveals three numeric inputs
// pre-filled from the current preset so it's easy to tweak.
//
// Phase 2 of the assistance suggester: pure data capture. The recommender
// (Phase 4) and suggester (Phase 5) will read `block.assistanceVolume`.

import { useMemo, useState } from 'react';
import {
  ASSISTANCE_VOLUME_PRESETS,
  defaultAssistanceVolumeForKind,
  deriveGoalFlags,
  effectiveAssistanceVolumeForPhase,
  resolveAssistanceVolume,
  weekStartDate,
  type AssistanceVolume,
  type AssistanceVolumeCustom,
  type AssistanceVolumePreset,
  type WendlerWeek,
} from '@wendler/domain';
import type { ProgramBlock } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useAllSessions, useSettings, useUpcomingRaces } from '@/lib/hooks';
import { useVolumeRecommendation } from '@/lib/useVolumeRecommendation';
import type { VolumeRecommendation } from '@wendler/domain';

const PRESET_OPTIONS: {
  id: AssistanceVolumePreset;
  label: string;
  hint: string;
}[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    hint: 'Light assistance — cardio peaks, recovery, deload-style.',
  },
  {
    id: 'standard',
    label: 'Standard',
    hint: 'Forever-canonical volume. Safe default for Anchors.',
  },
  {
    id: 'high',
    label: 'High',
    hint: 'Generous accessory work. Typical for Leader blocks with an accessory day.',
  },
];

type Mode = AssistanceVolumePreset | 'custom';

function modeOf(volume: AssistanceVolume | undefined, fallback: AssistanceVolumePreset): Mode {
  if (!volume) return fallback;
  if (typeof volume === 'string') return volume;
  return 'custom';
}

function presetSummary(p: AssistanceVolumeCustom): string {
  return `~${p.mainDayReps} reps/main · ~${p.accessoryReps} reps/accessory · ${p.accessoryMovements} movements`;
}

interface Props {
  block: ProgramBlock;
  /**
   * Currently-viewed week in the editor. Used to auto-shift the visible
   * preset for taper / peak / deload weeks (e.g. standard → minimal in
   * taper). The stored block-level preset is never mutated by this — the
   * shift is purely visual + read by the suggester at generation time.
   */
  weekScope: WendlerWeek;
}

export function BlockAssistanceVolumePanel({ block, weekScope }: Props) {
  const fallback = useMemo(
    () => defaultAssistanceVolumeForKind(block.kind, block.seventhWeekKind),
    [block.kind, block.seventhWeekKind],
  );
  const recommendation = useVolumeRecommendation(block);
  const settings = useSettings();
  const upcomingRaces = useUpcomingRaces();
  const allSessions = useAllSessions();
  const stored = block.assistanceVolume;
  // When unset, prefer the live recommendation; fall back to kind default
  // while signals are still loading.
  const baseVolume: AssistanceVolume =
    stored ?? recommendation?.preset ?? fallback;
  const baseMode = modeOf(stored, recommendation?.preset ?? fallback);

  // Per-week phase auto-derivation for the visible week. Anchors to the
  // first session actually performed in this block (see SuggestAssistanceForBlock
  // for the same logic) so activating a block in advance doesn't skew the
  // calendar windows.
  const phase = useMemo<'normal' | 'deload' | 'taper' | 'peak'>(() => {
    const profile = settings?.trainingProfile;
    if (!profile) return 'normal';
    let earliest: string | undefined;
    for (const s of allSessions ?? []) {
      if (s.blockId !== block.id) continue;
      if (!s.performedAt) continue;
      if (!earliest || s.performedAt < earliest) earliest = s.performedAt;
    }
    const anchor = earliest ?? new Date();
    const targetDate =
      weekStartDate(anchor, block.weeksBeforeDeload, weekScope) ?? new Date();
    return deriveGoalFlags(profile, upcomingRaces ?? [], targetDate, {
      kind: block.kind,
      ...(block.seventhWeekKind ? { seventhWeekKind: block.seventhWeekKind } : {}),
      // When the user is REVIEWING the deload week of this block in the
      // volume panel, the phase derivation should account for that —
      // otherwise the panel keeps saying `phase: 'normal'` for a deload
      // week and the effectiveAssistanceVolumeForPhase shift never kicks
      // in. weekScope is the visible scope (1/2/3/deload/7w) the panel
      // is computing for.
      cursorWeek: weekScope,
    }).phase;
  }, [
    settings?.trainingProfile,
    upcomingRaces,
    allSessions,
    block.id,
    block.kind,
    block.seventhWeekKind,
    block.weeksBeforeDeload,
    weekScope,
  ]);

  // Effective volume after phase-aware shift. When `phase === 'normal'` or
  // the stored volume is custom, this equals `baseVolume`.
  const effectiveVolume: AssistanceVolume = useMemo(
    () => effectiveAssistanceVolumeForPhase(baseVolume, phase),
    [baseVolume, phase],
  );
  const effectiveMode: Mode = modeOf(
    typeof effectiveVolume === 'string' ? effectiveVolume : undefined,
    typeof effectiveVolume === 'string' ? effectiveVolume : 'standard',
  );
  const isAutoShifted =
    phase !== 'normal' &&
    typeof baseVolume === 'string' &&
    typeof effectiveVolume === 'string' &&
    baseVolume !== effectiveVolume;

  // Highlighted chip = effective preset when auto-shifted, otherwise the
  // user's stored choice.
  const mode = isAutoShifted ? effectiveMode : baseMode;
  const resolved = useMemo(() => resolveAssistanceVolume(effectiveVolume), [effectiveVolume]);

  const [expanded, setExpanded] = useState(mode === 'custom');
  const [showWhy, setShowWhy] = useState(false);

  // Local draft for the three custom inputs. Initialised from resolved so a
  // fresh "Custom" pick doesn't zero everything out.
  const [draft, setDraft] = useState<AssistanceVolumeCustom>(resolved);

  async function persist(next: AssistanceVolume | undefined) {
    const now = new Date().toISOString();
    await getDb().blocks.update(block.id, {
      assistanceVolume: next,
      updatedAt: now,
    });
  }

  async function pick(m: Mode) {
    if (m === 'custom') {
      setExpanded(true);
      // Seed the custom draft from current resolved values so the inputs
      // start at something meaningful.
      const seed = resolved;
      setDraft(seed);
      await persist({ ...seed });
      return;
    }
    setExpanded(false);
    await persist(m);
  }

  async function commitDraft(next: AssistanceVolumeCustom) {
    setDraft(next);
    await persist({ ...next });
  }

  function num(v: string, fallbackVal: number): number {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return fallbackVal;
    // Sane upper bounds; matches the cap noted in plan.md so a typo can't
    // produce 1M-rep weeks that break the suggester.
    return Math.min(n, 9999);
  }

  return (
    <section className="space-y-2 rounded-lg border border-sky-400/40 bg-sky-500/5 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-sky-300">
            Assistance volume
          </span>
          {recommendation && (
            <button
              type="button"
              onClick={() => setShowWhy((v) => !v)}
              className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 ring-1 ring-sky-400/40 hover:bg-sky-500/25"
              title="Click for why this was recommended"
            >
              ★ {recommendation.preset} recommended · {showWhy ? 'hide why' : 'why?'}
            </button>
          )}
          {!stored && !recommendation && (
            <span
              className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 ring-1 ring-sky-400/40"
              title={`Default for ${block.kind} blocks`}
            >
              default
            </span>
          )}
          {isAutoShifted && typeof baseVolume === 'string' && typeof effectiveVolume === 'string' && (
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-200 ring-1 ring-amber-400/40"
              title={`This week is in ${phase} phase, so the suggester will use ${effectiveVolume} (~${ASSISTANCE_VOLUME_PRESETS[effectiveVolume].mainDayReps} reps/main, ~${ASSISTANCE_VOLUME_PRESETS[effectiveVolume].accessoryReps} reps/accessory) instead of your block-level ${baseVolume}. Click another chip to override the auto-shift for the whole block.`}
            >
              auto · {phase} → {effectiveVolume}
            </span>
          )}
        </div>
        <span className="text-[11px] text-muted">{presetSummary(resolved)}</span>
      </div>

      {showWhy && recommendation && recommendation.reasons.length > 0 && (
        <div className="space-y-1.5 rounded-md border border-sky-400/30 bg-sky-500/5 px-2.5 py-1.5 text-[11px] text-sky-100">
          {(() => {
            const startingReason = recommendation.reasons.find(
              (r) => r.signal === 'kind-default' || r.signal === 'history',
            );
            const startingPreset = (() => {
              const m = startingReason?.detail.match(/"(minimal|standard|high)"/);
              return m?.[1] as AssistanceVolumePreset | undefined;
            })();
            const adjusted = startingPreset && startingPreset !== recommendation.preset;
            return (
              <p className="font-medium text-sky-200">
                Recommended: <span className="text-fg">{recommendation.preset}</span>
                {adjusted && (
                  <span className="text-sky-300/80"> (adjusted from {startingPreset})</span>
                )}
              </p>
            );
          })()}
          <ul className="space-y-0.5">
            {recommendation.reasons.map((r: VolumeRecommendation['reasons'][number], i: number) => (
              <li key={i} className="flex items-baseline gap-1.5">
                <span className="text-sky-300/80">·</span>
                <span>{r.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {PRESET_OPTIONS.map((opt) => {
          const on = mode === opt.id;
          const isRecommended = recommendation?.preset === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              title={`${opt.hint}\n${presetSummary(ASSISTANCE_VOLUME_PRESETS[opt.id])}${
                isRecommended ? '\n★ Recommended for this block' : ''
              }`}
              onClick={() => void pick(opt.id)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                on
                  ? isRecommended
                    ? 'border-accent bg-accent/20 text-fg ring-1 ring-sky-400/40'
                    : 'border-accent bg-accent/20 text-fg'
                  : isRecommended
                    ? 'border-sky-400/70 text-fg ring-1 ring-sky-400/40'
                    : 'border-border text-muted hover:text-fg'
              }`}
            >
              {isRecommended && <span aria-hidden className="mr-1 text-sky-300">★</span>}
              {opt.label}
            </button>
          );
        })}
        <button
          type="button"
          title="Set raw weekly numbers."
          onClick={() => void pick('custom')}
          className={`rounded-md border px-2.5 py-1 text-xs ${
            mode === 'custom'
              ? 'border-accent bg-accent/20 text-fg'
              : 'border-border text-muted hover:text-fg'
          }`}
        >
          Custom
        </button>
        {stored && (
          <button
            type="button"
            onClick={() => {
              setExpanded(false);
              void persist(undefined);
            }}
            className="ml-auto rounded bg-bg px-2 py-0.5 text-[11px] text-muted ring-1 ring-border hover:text-fg"
            title={`Clear and use the default for ${block.kind} blocks`}
          >
            Reset to default
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-2 pt-1">
          <div className="grid grid-cols-3 gap-2">
            <label className="space-y-0.5">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-muted">
                Reps / main day
              </span>
              <input
                type="number"
                min={0}
                value={draft.mainDayReps}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    mainDayReps: num(e.target.value, d.mainDayReps),
                  }))
                }
                onBlur={() => void commitDraft(draft)}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm tabular-nums"
              />
            </label>
            <label className="space-y-0.5">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-muted">
                Reps / accessory day
              </span>
              <input
                type="number"
                min={0}
                value={draft.accessoryReps}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    accessoryReps: num(e.target.value, d.accessoryReps),
                  }))
                }
                onBlur={() => void commitDraft(draft)}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm tabular-nums"
              />
            </label>
            <label className="space-y-0.5">
              <span className="block text-[10px] font-medium uppercase tracking-wide text-muted">
                Accessory movements
              </span>
              <input
                type="number"
                min={0}
                value={draft.accessoryMovements}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    accessoryMovements: num(e.target.value, d.accessoryMovements),
                  }))
                }
                onBlur={() => void commitDraft(draft)}
                className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm tabular-nums"
              />
            </label>
          </div>
          <p className="text-[11px] text-muted">
            Weekly totals. Leave 0 for accessory fields if this block has no
            dedicated accessory day.
          </p>
        </div>
      )}
    </section>
  );
}
