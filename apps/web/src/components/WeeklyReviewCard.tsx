'use client';

// WeeklyReviewCard — surfaces the latest persisted weekly review on
// /stats with an on-demand "Generate" button. Phase 4 ships only the
// manual trigger; a Sunday-evening cron is parked until we have a worker
// tier (see phase-4 plan).

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLatestWeeklyReview } from '@/lib/hooks';
import { generateWeeklyReview } from '@/lib/weeklyReview-workflow';

const VERDICT_BADGES: Record<string, { label: string; className: string }> = {
  'deload-now': {
    label: 'Deload now',
    className: 'border-amber-500/50 bg-amber-500/15 text-amber-200',
  },
  'deload-soon': {
    label: 'Deload soon',
    className: 'border-amber-500/40 bg-amber-500/10 text-amber-200/90',
  },
  continue: {
    label: 'Continue',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  },
  'taper-now': {
    label: 'Taper',
    className: 'border-violet-500/50 bg-violet-500/15 text-violet-200',
  },
  'ramp-up': {
    label: 'Ramp up',
    className: 'border-sky-500/50 bg-sky-500/15 text-sky-200',
  },
  'tm-test': {
    label: 'TM-test next',
    className: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
  },
  'extend-block': {
    label: 'Extend block',
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  },
};

export function WeeklyReviewCard() {
  const latest = useLatestWeeklyReview();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const onGenerate = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await generateWeeklyReview();
      if (!res.ok) setError(res.errors.join('; '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (latest === undefined) return null; // still loading

  if (latest === null) {
    return (
      <section className="rounded-2xl border border-border bg-card p-5">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Weekly review</h2>
            <p className="mt-1 text-xs text-muted">
              AI digest of last week: load + recovery, strength trend, cardio, and
              what next week looks like. Generated on demand.
            </p>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onGenerate()}
            className="shrink-0 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-bg disabled:opacity-50"
          >
            {busy ? 'Generating…' : 'Generate'}
          </button>
        </header>
        {error && (
          <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
            {error}
          </p>
        )}
      </section>
    );
  }

  const badge = VERDICT_BADGES[latest.verdict] ?? {
    label: latest.verdict,
    className: 'border-border bg-bg/40 text-muted',
  };
  const generatedAgo = relativeTime(latest.generatedAt);

  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="text-lg font-semibold">Weekly review</h2>
            <span className={`shrink-0 rounded border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${badge.className}`}>
              {badge.label}
            </span>
            <span className="text-[11px] text-muted">
              {latest.weekStart} → {latest.weekEnd}
            </span>
          </div>
          <p className="mt-1 text-sm text-fg">{latest.headline}</p>
          <p className="mt-0.5 text-[11px] text-muted">Generated {generatedAgo}.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onGenerate()}
          className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-fg disabled:opacity-50"
        >
          {busy ? 'Regenerating…' : 'Regenerate'}
        </button>
      </header>

      {latest.highlights.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {latest.highlights.map((h, i) => (
            <li
              key={i}
              className="rounded border border-accent/40 bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent"
            >
              {h}
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-3">
        {latest.sections.map((s, i) => {
          if (s.markdown.trim().length === 0) return null;
          return (
            <div key={i} className="rounded-lg border border-border/60 bg-bg/30 p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
                {s.heading}
              </h3>
              <div className="mt-1 text-sm leading-relaxed weekly-review-section">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.markdown}</ReactMarkdown>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
          {error}
        </p>
      )}
    </section>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMin = Math.floor((now - then) / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH} h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return 'yesterday';
  return `${diffD} d ago`;
}
