'use client';

// AI suggester history — chronological log of every generation, with
// inputs/outputs and the "Copy as AI prompt" export that's the whole
// point of this page (user pastes the blob into Claude/ChatGPT for
// pattern analysis: "why is the model picking X? what should change?").

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useAiGenerations } from '@/lib/hooks';
import {
  annotateAiGeneration,
  exportAiGenerationsForReview,
} from '@/lib/aiGenerations';
import { deleteWithTombstones } from '@/lib/delete';
import { fmtDate } from '@/lib/format';

export default function AiHistoryPage() {
  const all = useAiGenerations();
  const [filter, setFilter] = useState<'all' | 'applied' | 'undone'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exportLimit, setExportLimit] = useState<number>(10);
  const [exportBlob, setExportBlob] = useState<string>('');
  const [copyStatus, setCopyStatus] = useState<string>('');

  const filtered = useMemo(() => {
    if (!all) return [];
    if (filter === 'all') return all;
    return all.filter((g) => g.outcome === filter);
  }, [all, filter]);

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const generateExport = async () => {
    const blob = await exportAiGenerationsForReview(exportLimit);
    setExportBlob(blob);
  };

  const copyExport = async () => {
    if (!exportBlob) return;
    try {
      await navigator.clipboard.writeText(exportBlob);
      setCopyStatus('Copied!');
      setTimeout(() => setCopyStatus(''), 1500);
    } catch {
      setCopyStatus('Copy failed');
      setTimeout(() => setCopyStatus(''), 1500);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-4 md:py-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">AI suggester history</h1>
        <p className="text-xs text-muted">
          Every AI generation is logged with full prompt, response, and outcome.
          Use the export below to paste into any LLM for pattern analysis.
        </p>
      </header>

      <section className="rounded-xl border border-border bg-card p-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
          Export for AI review
        </h2>
        <p className="mt-1 text-xs text-muted">
          Builds a single text blob with the N most recent generations
          (newest first) including system prompt, user prompt, raw response,
          context, and outcome. Designed to be pasted into Claude / ChatGPT
          / etc. to diagnose patterns (&ldquo;why does it keep picking X?&rdquo;).
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="text-xs text-muted">
            Last
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              value={exportLimit}
              onChange={(e) => setExportLimit(parseInt(e.target.value, 10) || 10)}
              className="mx-1.5 w-16 rounded border border-border bg-bg px-1.5 py-0.5 text-xs tabular-nums text-fg"
            />
            generations
          </label>
          <button
            type="button"
            onClick={() => void generateExport()}
            className="rounded-md border border-accent/60 bg-accent/15 px-3 py-1 text-xs font-medium text-accent"
          >
            Generate blob
          </button>
          {exportBlob && (
            <>
              <button
                type="button"
                onClick={() => void copyExport()}
                className="rounded-md border border-border bg-bg px-3 py-1 text-xs font-medium text-fg hover:bg-bg/60"
              >
                {copyStatus || 'Copy to clipboard'}
              </button>
              <span className="text-[10px] text-muted">
                {(exportBlob.length / 1024).toFixed(1)} KB
              </span>
            </>
          )}
        </div>
        {exportBlob && (
          <pre className="mt-2 max-h-72 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 text-[11px] leading-snug text-fg/90">
            {exportBlob}
          </pre>
        )}
      </section>

      <div className="-mx-1 flex flex-wrap gap-1.5 overflow-x-auto px-1">
        <FilterChip
          label={`All (${all?.length ?? '…'})`}
          active={filter === 'all'}
          onClick={() => setFilter('all')}
        />
        <FilterChip
          label={`Applied (${(all ?? []).filter((g) => g.outcome === 'applied').length})`}
          active={filter === 'applied'}
          onClick={() => setFilter('applied')}
        />
        <FilterChip
          label={`Undone (${(all ?? []).filter((g) => g.outcome === 'undone').length})`}
          active={filter === 'undone'}
          onClick={() => setFilter('undone')}
        />
      </div>

      {!all && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          Loading…
        </div>
      )}
      {all && filtered.length === 0 && (
        <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted">
          {all.length === 0
            ? 'No AI generations yet. Hit Suggest on a block to start the log.'
            : 'No generations in this filter.'}
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((g) => {
          const isOpen = expanded.has(g.id);
          const outcomeColor =
            g.outcome === 'applied'
              ? 'text-emerald-300 ring-emerald-500/30'
              : g.outcome === 'undone'
                ? 'text-amber-300 ring-amber-500/30'
                : 'text-rose-300 ring-rose-500/30';
          return (
            <article
              key={g.id}
              className="rounded-xl border border-border bg-card p-3"
            >
              <header className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span
                      className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ring-1 ${outcomeColor}`}
                    >
                      {g.outcome}
                    </span>
                    {g.source === 'fallback' && (
                      <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-500/30">
                        fallback
                      </span>
                    )}
                    <span className="text-[11px] text-muted">
                      {fmtDateTime(g.createdAt)}
                    </span>
                  </div>
                  <h3 className="mt-1 text-sm font-medium text-fg">
                    {g.blockName ?? g.blockId} · {labelForWeek(g.weekScope)}
                    {g.phase && g.phase !== 'normal' ? ` · ${g.phase}` : ''}
                  </h3>
                  <div className="mt-0.5 flex flex-wrap gap-2 text-[11px] text-muted">
                    {g.pickCount != null && (
                      <span>
                        {g.pickCount} pick{g.pickCount === 1 ? '' : 's'} ·{' '}
                        {g.dayCount ?? '?'} day{g.dayCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {g.cardioFatigueShift != null && g.cardioFatigueShift !== 0 && (
                      <span>cardio shift {g.cardioFatigueShift}</span>
                    )}
                    {g.modelInfo && (
                      <span>
                        {g.modelInfo.model} · {g.modelInfo.elapsedMs}ms
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-baseline gap-2">
                  <Link
                    href={`/program/block?id=${g.blockId}`}
                    className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    Open block
                  </Link>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(g.id)}
                    className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline"
                  >
                    {isOpen ? 'Collapse' : 'Expand'}
                  </button>
                </div>
              </header>

              {isOpen && (
                <div className="mt-3 space-y-2 text-[11px]">
                  <Annotation
                    initial={g.userAnnotation}
                    onSave={(val) => void annotateAiGeneration(g.id, val)}
                  />
                  <details>
                    <summary className="cursor-pointer text-muted hover:text-fg">
                      System prompt ({(g.systemPrompt.length / 1024).toFixed(1)} KB)
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 leading-snug text-fg/90">
                      {g.systemPrompt}
                    </pre>
                  </details>
                  <details open>
                    <summary className="cursor-pointer text-muted hover:text-fg">
                      User prompt ({(g.userPrompt.length / 1024).toFixed(1)} KB)
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 leading-snug text-fg/90">
                      {g.userPrompt}
                    </pre>
                  </details>
                  <details open>
                    <summary className="cursor-pointer text-muted hover:text-fg">
                      Raw response ({(g.rawResponse.length / 1024).toFixed(1)} KB)
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border/60 bg-black/40 p-2 leading-snug text-fg/90">
                      {prettyJsonIfPossible(g.rawResponse)}
                    </pre>
                  </details>
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm('Delete this generation? This cannot be undone.')) {
                          void deleteWithTombstones('aiGeneration', [g.id]);
                        }
                      }}
                      className="text-[11px] text-muted/70 underline-offset-2 hover:text-rose-300 hover:underline"
                    >
                      Delete from history
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium ring-1 transition-colors ${
        active ? 'bg-accent text-bg ring-accent' : 'bg-bg text-muted ring-border hover:text-fg'
      }`}
    >
      {label}
    </button>
  );
}

function Annotation({
  initial,
  onSave,
}: {
  initial?: string;
  onSave: (val: string) => void;
}) {
  const [val, setVal] = useState(initial ?? '');
  const [status, setStatus] = useState('');
  const dirty = (initial ?? '') !== val;
  return (
    <div className="rounded-md border border-border/60 bg-bg/40 p-2">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted">
        Note (optional, e.g. &ldquo;good picks&rdquo;, &ldquo;trimmed wrong movement&rdquo;)
      </label>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Add a note for future review…"
        className="mt-1 w-full resize-y rounded border border-border bg-bg px-2 py-1 text-[11px] text-fg focus:border-accent focus:outline-none"
        rows={2}
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        {status && <span className="text-[10px] text-muted">{status}</span>}
        <button
          type="button"
          disabled={!dirty}
          onClick={() => {
            onSave(val);
            setStatus('Saved');
            setTimeout(() => setStatus(''), 1500);
          }}
          className="rounded border border-accent/60 bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent disabled:opacity-40"
        >
          Save note
        </button>
      </div>
    </div>
  );
}

function labelForWeek(weekScope: number | string): string {
  if (weekScope === 'deload') return 'Deload';
  if (weekScope === '7w') return '7th week';
  return `Week ${weekScope}`;
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  const date = fmtDate(iso);
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${date} ${time}`;
}

function prettyJsonIfPossible(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
