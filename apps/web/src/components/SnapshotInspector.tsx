'use client';

// SnapshotInspector — debug UI that dumps the EXACT context blob the
// chat orchestrator receives on every send, plus the active exclusion
// list, plus the raw active block row from Dexie.
//
// Purpose: answer "what does the AI see?" with no inference, no
// summarising, no transformation. If the chat AI claims your block
// contains X, the inspector shows whether the snapshot it received
// actually contains X. That isolates whether a hallucination is a
// model failure (snapshot was right, AI made stuff up) or a data
// freshness bug (snapshot was wrong).
//
// Shown on /chat when `?debug=snapshot` is present in the URL. Hidden
// otherwise to keep the surface clean for normal use.

import { useEffect, useState } from 'react';
import { resolveDayAssistance } from '@wendler/domain';
import { buildContextBlob, readActiveExclusions } from '@/lib/useChat';
import { getDb } from '@/lib/db';
import type { ProgramBlock } from '@wendler/db-schema';

interface State {
  loading: boolean;
  generatedAt?: string;
  snapshot?: string;
  exclusions?: string[];
  activeBlock?: ProgramBlock;
  allBlocks?: Array<{ id: string; name: string; completedAt?: string; updatedAt?: string }>;
  error?: string;
}

export function SnapshotInspector() {
  const [state, setState] = useState<State>({ loading: false });
  const [expanded, setExpanded] = useState(false);

  const refresh = async () => {
    setState({ loading: true });
    try {
      const [snapshot, exclusions, allBlocks] = await Promise.all([
        buildContextBlob(),
        readActiveExclusions(),
        getDb().blocks.toArray(),
      ]);
      const active = allBlocks.find((b) => !b.completedAt);
      setState({
        loading: false,
        generatedAt: new Date().toISOString(),
        snapshot,
        exclusions,
        ...(active ? { activeBlock: active as ProgramBlock } : {}),
        allBlocks: allBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          ...(b.completedAt ? { completedAt: b.completedAt } : {}),
          ...(b.updatedAt ? { updatedAt: b.updatedAt } : {}),
        })),
      });
    } catch (err) {
      setState({ loading: false, error: (err as Error).message });
    }
  };

  // Auto-fetch on mount so the inspector is useful immediately when
  // the user navigates to ?debug=snapshot.
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] p-3 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold text-amber-200">Snapshot inspector (debug)</h2>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={state.loading}
            className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {state.loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded border border-border bg-bg/30 px-2 py-0.5 font-semibold hover:bg-bg/50"
          >
            {expanded ? 'Collapse' : 'Expand'}
          </button>
        </div>
      </div>

      {state.error && (
        <p className="mt-2 rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-rose-100">
          {state.error}
        </p>
      )}

      {state.generatedAt && (
        <p className="mt-2 text-muted">
          Captured at {new Date(state.generatedAt).toLocaleTimeString()} · This is the EXACT
          string the API receives on next send.
        </p>
      )}

      {state.allBlocks && (
        <div className="mt-2">
          <p className="font-semibold text-fg/80">All blocks in local Dexie (oldest → newest):</p>
          <ul className="mt-1 space-y-0.5">
            {state.allBlocks.map((b) => (
              <li
                key={b.id}
                className={`font-mono ${
                  state.activeBlock?.id === b.id ? 'text-emerald-100' : 'text-muted'
                }`}
              >
                {state.activeBlock?.id === b.id ? '▶ ACTIVE  ' : '           '}
                {b.id.slice(0, 12)}… · {b.name}
                {b.completedAt ? ` · completed ${b.completedAt.slice(0, 10)}` : ''}
                {b.updatedAt ? ` · updated ${b.updatedAt.slice(0, 19)}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] italic text-muted/80">
            If the row marked ACTIVE is not the block you&apos;ve been editing in /program/block,
            you have a sync conflict — the chat is reading a different block than the editor.
          </p>
        </div>
      )}

      {state.exclusions && state.exclusions.length > 0 && (
        <div className="mt-2">
          <p className="font-semibold text-fg/80">Active exclusion filters sent to API:</p>
          <ul className="mt-1 ml-4 list-disc">
            {state.exclusions.map((e) => (
              <li key={e} className="text-fg/80">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}

      {state.activeBlock?.plan && (
        <div className="mt-2">
          <p className="font-semibold text-fg/80">
            Active block · per-week assistance (canonical store, v21+):
          </p>
          <ul className="mt-1 ml-4 list-disc">
            {state.activeBlock.plan.days.map((d, i) => (
              <li key={d.id} className="text-fg/80">
                Day {i + 1}
                {d.label ? ` "${d.label}"` : ''} · main:{' '}
                {d.mainLifts.length > 0 ? d.mainLifts.join(', ') : '—'}
                <ul className="ml-4 mt-0.5">
                  {(['1', '2', '3', 'deload'] as const).map((wk) => {
                    const wendlerWk =
                      wk === 'deload' ? 'deload' : (Number(wk) as 1 | 2 | 3);
                    const entries = resolveDayAssistance(
                      state.activeBlock!.plan!,
                      wendlerWk,
                      d.id,
                    );
                    const label = wk === 'deload' ? 'Deload' : `Wk ${wk}`;
                    return (
                      <li key={wk} className="text-fg/70">
                        {label} ({entries.length}):{' '}
                        {entries.length > 0
                          ? entries.map((e) => e.movementName).join(', ')
                          : '(none)'}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] italic text-muted/80">
            Each (week, day) cell is independent storage in
            BlockPlan.assistanceOverrides. v21+ writes flow here from BOTH the editor and
            propose_edit ops. If any week diverges from what /program/block shows for that
            week, the editor and chat are out of sync.
          </p>
        </div>
      )}

      {state.snapshot && (
        <div className="mt-2">
          <p className="font-semibold text-fg/80">
            Full snapshot text ({state.snapshot.length.toLocaleString()} chars):
          </p>
          {expanded ? (
            <pre className="mt-1 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg/40 p-2 font-mono text-[11px] text-fg/80">
              {state.snapshot}
            </pre>
          ) : (
            <pre className="mt-1 max-h-32 overflow-hidden whitespace-pre-wrap rounded border border-border bg-bg/40 p-2 font-mono text-[11px] text-fg/80">
              {state.snapshot.slice(0, 800)}
              {state.snapshot.length > 800 ? '\n…' : ''}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
