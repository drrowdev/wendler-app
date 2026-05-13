'use client';

// AI generation log — persistent record of every assistance-suggester
// invocation, plus an "AI-paste-friendly" export for after-the-fact
// pattern analysis.
//
// The flow:
//   1. SuggestAssistanceForBlock calls `recordAiGeneration(input)` after
//      every apply (AI or fallback) — gets back an id.
//   2. If the user undoes, calls `markAiGenerationUndone(id)`.
//   3. If everything errors and nothing is applied, calls `recordAiError`.
//   4. The /ai-history page queries the table and renders the log.
//   5. "Copy as AI prompt" concatenates N entries into a single text blob
//      that can be fed to any LLM for diagnostic review.
//
// Synced across devices via the existing LWW pipeline — same shape as
// `Notification` / `Race` / etc.

import { nanoid } from 'nanoid';
import type {
  AiGeneration,
  AiGenerationModelInfo,
  AiGenerationOutcome,
  AiGenerationSource,
} from '@wendler/db-schema';
import { getDb } from './db';

export interface RecordAiGenerationInput {
  blockId: string;
  blockName?: string;
  blockKind?: AiGeneration['blockKind'];
  weekScope: number | string;
  phase?: AiGeneration['phase'];
  source: AiGenerationSource;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  modelInfo?: AiGenerationModelInfo;
  cardioFatigueShift?: number;
  cardioFatigueSummary?: AiGeneration['cardioFatigueSummary'];
  pickCount?: number;
  dayCount?: number;
  /** Defaults to 'applied' since that's the most common case at write time. */
  outcome?: AiGenerationOutcome;
}

export async function recordAiGeneration(
  input: RecordAiGenerationInput,
): Promise<string> {
  if (typeof window === 'undefined') return '';
  const now = new Date().toISOString();
  const record: AiGeneration = {
    id: nanoid(),
    createdAt: now,
    outcomeAt: now,
    updatedAt: now,
    blockId: input.blockId,
    ...(input.blockName ? { blockName: input.blockName } : {}),
    ...(input.blockKind ? { blockKind: input.blockKind } : {}),
    weekScope: input.weekScope,
    ...(input.phase ? { phase: input.phase } : {}),
    source: input.source,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    rawResponse: input.rawResponse,
    ...(input.modelInfo ? { modelInfo: input.modelInfo } : {}),
    ...(input.cardioFatigueShift != null
      ? { cardioFatigueShift: input.cardioFatigueShift }
      : {}),
    ...(input.cardioFatigueSummary
      ? { cardioFatigueSummary: input.cardioFatigueSummary }
      : {}),
    ...(input.pickCount != null ? { pickCount: input.pickCount } : {}),
    ...(input.dayCount != null ? { dayCount: input.dayCount } : {}),
    outcome: input.outcome ?? 'applied',
  };
  await getDb().aiGenerations.add(record);
  return record.id;
}

export async function markAiGenerationUndone(id: string): Promise<void> {
  if (typeof window === 'undefined' || !id) return;
  const now = new Date().toISOString();
  const row = await getDb().aiGenerations.get(id);
  if (!row || row.outcome === 'undone') return;
  await getDb().aiGenerations.update(id, {
    outcome: 'undone',
    outcomeAt: now,
    updatedAt: now,
  });
}

export async function annotateAiGeneration(
  id: string,
  annotation: string,
): Promise<void> {
  if (typeof window === 'undefined' || !id) return;
  const now = new Date().toISOString();
  await getDb().aiGenerations.update(id, {
    userAnnotation: annotation,
    updatedAt: now,
  });
}

/**
 * Build a single text blob containing N recent generations, formatted for
 * pasting into any LLM as diagnostic input. Each entry includes the full
 * input/output context plus the outcome and any user annotation.
 *
 * Default: last 10 generations, newest first. Pass `limit` to adjust.
 */
export async function exportAiGenerationsForReview(
  limit = 10,
): Promise<string> {
  if (typeof window === 'undefined') return '';
  const rows = await getDb()
    .aiGenerations.orderBy('createdAt')
    .reverse()
    .limit(limit)
    .toArray();
  if (rows.length === 0) {
    return '(No AI generations recorded yet.)';
  }
  const header = [
    '# Wendler 5/3/1 — AI suggester history (for review)',
    '',
    `Exported: ${new Date().toISOString()}`,
    `Generations included: ${rows.length} (newest first)`,
    `Date range: ${rows[rows.length - 1]!.createdAt} → ${rows[0]!.createdAt}`,
    '',
    'Each entry includes the system prompt, user prompt, raw LLM response, model info, and the user\'s outcome (applied / undone / error). Look for patterns: are certain movement types over- or under-picked? Do trims happen at the wrong layer? Is the volume budget consistently mis-targeted? Suggest changes the user should consider.',
    '',
    '---',
    '',
  ];

  const blocks = rows.map((g, i) => formatGenerationForExport(g, i + 1));
  return [...header, ...blocks].join('\n');
}

function formatGenerationForExport(g: AiGeneration, index: number): string {
  const lines: string[] = [];
  lines.push(`## Generation ${index} — ${g.createdAt}`);
  lines.push('');
  lines.push('**Context:**');
  lines.push(`- Block: ${g.blockName ?? g.blockId}${g.blockKind ? ` (${g.blockKind})` : ''}`);
  lines.push(`- Week scope: ${g.weekScope}`);
  if (g.phase) lines.push(`- Phase: ${g.phase}`);
  lines.push(`- Source: ${g.source}`);
  if (g.modelInfo) {
    lines.push(
      `- Model: ${g.modelInfo.model} · ${g.modelInfo.elapsedMs}ms · tokens in=${g.modelInfo.inputTokens ?? '?'} out=${g.modelInfo.outputTokens ?? '?'}`,
    );
  }
  if (g.cardioFatigueShift != null && g.cardioFatigueShift !== 0) {
    const s = g.cardioFatigueSummary;
    lines.push(
      `- Cardio fatigue shift: ${g.cardioFatigueShift}` +
        (s
          ? ` (recent=${Math.round(s.recentWeightedMin)} weighted-min vs baseline=${Math.round(s.baselineWeightedMin)}/wk, delta ${s.deltaPct != null ? `${Math.round(s.deltaPct * 100)}%` : 'n/a'})`
          : ''),
    );
  }
  if (g.pickCount != null) lines.push(`- Picks applied: ${g.pickCount} across ${g.dayCount ?? '?'} days`);
  lines.push(`- Outcome: ${g.outcome}${g.outcomeAt && g.outcomeAt !== g.createdAt ? ` (at ${g.outcomeAt})` : ''}`);
  if (g.userAnnotation) lines.push(`- User annotation: ${g.userAnnotation}`);
  lines.push('');
  lines.push('**System prompt:**');
  lines.push('```');
  lines.push(g.systemPrompt);
  lines.push('```');
  lines.push('');
  lines.push('**User prompt:**');
  lines.push('```');
  lines.push(g.userPrompt);
  lines.push('```');
  lines.push('');
  lines.push('**Raw response:**');
  lines.push('```');
  lines.push(g.rawResponse);
  lines.push('```');
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}
