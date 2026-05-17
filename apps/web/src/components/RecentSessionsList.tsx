'use client';

import Link from 'next/link';
import { CARDIO_EMOJI, CARDIO_SHORT, cardioMetric } from '@/lib/cardio-display';
import type { CardioSession, StrengthHrEnrichment } from '@wendler/db-schema';
import {
  importedStrengthLabel,
  partitionStrengthHr,
  strengthHrDayKey,
} from '@wendler/domain';
import type { RecentWorkoutDay } from '@/lib/hooks';

interface Props {
  days: RecentWorkoutDay[];
  cardio?: CardioSession[];
  importedStrength?: StrengthHrEnrichment[];
}

function hrefFor(d: RecentWorkoutDay): string {
  if (d.blockId && d.week != null && d.dayIndex != null) {
    return `/day?blockId=${d.blockId}&week=${d.week}&day=${d.dayIndex}`;
  }
  if (d.sessions[0]) return `/session?id=${d.sessions[0].id}`;
  return '/';
}

type Item =
  | { kind: 'strength'; at: string; day: RecentWorkoutDay }
  | { kind: 'cardio'; at: string; cardio: CardioSession }
  | { kind: 'imported-strength'; at: string; hr: StrengthHrEnrichment };

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function ymdOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtPlannedDateBadge(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const date = new Date(y, m - 1, d, 12, 0, 0);
  const wd = date.toLocaleDateString('fi-FI', { weekday: 'short' });
  return `${wd} ${d} ${MONTHS_FI[m - 1] ?? ''}`.trim();
}

const MONTHS_FI = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dayHeader(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const dm = `${d.getDate()} ${MONTHS_FI[d.getMonth()]}`;
  if (sameDay(d, today)) return `Today · ${dm}`;
  if (sameDay(d, yesterday)) return `Yesterday · ${dm}`;
  const weekday = WEEKDAYS[d.getDay()];
  // For older entries, also show year if not current year — keeps history
  // unambiguous when scrolling past a year boundary.
  if (d.getFullYear() !== today.getFullYear()) return `${weekday} · ${dm} ${d.getFullYear()}`;
  return `${weekday} · ${dm}`;
}

/**
 * Recent-sessions list for the Today page. Distinguishes in-progress vs
 * completed workouts visually:
 *   - in progress: amber background, progress bar, dedicated Resume button
 *   - completed strength: violet-tinted card, dot, set count, chevron
 *   - cardio:            sky-tinted card, modality emoji + metric, chevron
 *
 * Strength and cardio entries are interleaved by date so the Today page
 * always reflects everything that's happened recently — no need to switch
 * between pages to see "did I run yesterday?". Items are grouped under
 * day headers ("Today · 5 May", "Yesterday · 4 May", "2 May") so the
 * feed reads as a timeline rather than a flat list with per-row dates.
 *
 * No inline trash icon — destructive deletes are reachable from the session
 * detail view, where they're harder to hit by accident.
 */
export function RecentSessionsList({ days, cardio, importedStrength }: Props) {
  // Dedup: imported strength HR rows that line up with a logged Wendler
  // workout enrich that day's strength row inline (HR + duration sub-line)
  // instead of rendering a separate "Imported · Strength" item — the user
  // would see the same workout twice. Orphan rows (no matching Wendler
  // session, e.g. Wednesday gymnastics) still surface as standalone items.
  const { matchedByDay: hrByStrengthDay, orphans: orphanImportedStrength } =
    partitionStrengthHr(
      importedStrength ?? [],
      days.map((d) => ({ performedAt: d.latestPerformedAt })),
    );
  const items: Item[] = [
    ...days.map((d) => ({ kind: 'strength' as const, at: d.latestPerformedAt, day: d })),
    ...(cardio ?? []).map((c) => ({ kind: 'cardio' as const, at: c.performedAt, cardio: c })),
    ...orphanImportedStrength.map((h) => ({
      kind: 'imported-strength' as const,
      at: h.performedAt,
      hr: h,
    })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (items.length === 0) return null;
  const groups: { key: string; header: string; items: Item[] }[] = [];
  for (const it of items) {
    const key = dayKey(it.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.items.push(it);
    } else {
      groups.push({ key, header: dayHeader(it.at), items: [it] });
    }
  }
  return (
    <div className="space-y-4">
      {groups.map((g) => (
        <div key={g.key} className="space-y-2">
          <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
            {g.header}
          </h3>
          <ul className="space-y-2">
            {g.items.map((it) => {
              if (it.kind === 'cardio') return <CardioRow key={`c-${it.cardio.id}`} c={it.cardio} />;
              if (it.kind === 'imported-strength')
                return <ImportedStrengthRow key={`i-${it.hr.id}`} h={it.hr} />;
              const hr = hrByStrengthDay.get(strengthHrDayKey(it.day.latestPerformedAt));
              return <StrengthRow key={it.day.key} d={it.day} hr={hr} />;
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function CardioRow({ c }: { c: CardioSession }) {
  const emoji = CARDIO_EMOJI[c.modality];
  const label = CARDIO_SHORT[c.modality];
  const metric = cardioMetric(c);
  return (
    <li className="rounded-xl border border-sky-700/50 bg-sky-900/20 hover:border-sky-500">
      <Link href="/cardio" className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
            <span className="truncate text-sm font-semibold text-sky-100">
              <span aria-hidden className="mr-1">{emoji}</span>
              {label} · {metric}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-sky-300/70">
            Cardio
            {c.avgHrBpm != null && <span> · {c.avgHrBpm} bpm</span>}
            {c.source === 'strava' && <span> · Strava</span>}
          </div>
        </div>
        <span aria-hidden className="text-muted">›</span>
      </Link>
    </li>
  );
}

function StrengthRow({ d, hr }: { d: RecentWorkoutDay; hr?: StrengthHrEnrichment }) {
  const href = hrefFor(d);
  // Prefer the set-level progress when we have a prescribed total — it's
  // a much clearer signal than "5 of 5 movements logged" when the user
  // has only done some of each lift's prescribed sets. Fall back to
  // movement count when the prescribed total isn't resolvable.
  const useSets = d.setsTotal > 0;
  const progressNumerator = useSets ? d.setsLogged : d.movementsLogged;
  const progressDenominator = useSets ? d.setsTotal : d.movementsTotal;
  const progressLabel = useSets ? 'sets' : 'movements';
  const pct =
    progressDenominator > 0
      ? Math.min(100, Math.round((progressNumerator / progressDenominator) * 100))
      : 0;
  if (d.inProgress) {
    return (
      <li className="overflow-hidden rounded-xl border border-amber-500/40 bg-amber-500/10">
        <Link href={href} className="block px-4 pt-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                <span className="truncate text-sm font-semibold">
                  <span aria-hidden className="mr-1">🏋️</span>
                  {d.title}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-amber-200/90">
                Strength · In progress
                {progressDenominator > 0 && (
                  <span className="ml-1 text-muted">
                    · {progressNumerator} of {progressDenominator} {progressLabel} logged
                  </span>
                )}
              </div>
              {d.planScheduledDate &&
                d.planScheduledDate !== ymdOf(d.latestPerformedAt) && (
                  <div className="mt-0.5 text-[11px] text-amber-200/80">
                    ↗ planned {fmtPlannedDateBadge(d.planScheduledDate)}
                  </div>
                )}
            </div>
          </div>
        </Link>
        <div className="mt-2 px-4">
          <div className="h-1 w-full overflow-hidden rounded-full bg-amber-900/30">
            <div
              className="h-full rounded-full bg-amber-400 transition-all"
              style={{ width: `${pct}%` }}
              aria-hidden
            />
          </div>
        </div>
        <div className="flex items-center justify-end px-3 pb-3 pt-2">
          <Link
            href={href}
            className="rounded-md border border-amber-400/50 bg-amber-500/15 px-3 py-1 text-xs font-semibold text-amber-100 hover:bg-amber-500/25"
          >
            Resume
          </Link>
        </div>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-violet-700/50 bg-violet-900/20 hover:border-violet-500">
      <Link href={href} className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400" />
            <span className="truncate text-sm font-semibold text-violet-100">
              <span aria-hidden className="mr-1">🏋️</span>
              {d.title}
            </span>
            {d.weekLabel && (
              <span className="shrink-0 text-xs text-violet-300/70">{d.weekLabel}</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-violet-300/70">
            Strength · Complete
            {progressDenominator > 0 && (
              <span> · {progressNumerator} of {progressDenominator} {progressLabel} logged</span>
            )}
          </div>
          {d.planScheduledDate &&
            d.planScheduledDate !== ymdOf(d.latestPerformedAt) && (
              <div className="mt-0.5 text-[11px] text-violet-300/70">
                ↗ planned {fmtPlannedDateBadge(d.planScheduledDate)}
              </div>
            )}
          {hr && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-violet-300/60">
              <span aria-hidden>📈</span>
              <span>
                Strava · {Math.round(hr.durationSec / 60)} min
                {hr.avgHrBpm != null && <> · {hr.avgHrBpm} bpm</>}
              </span>
            </div>
          )}
        </div>
        <span aria-hidden className="text-muted">›</span>
      </Link>
    </li>
  );
}

function ImportedStrengthRow({ h }: { h: StrengthHrEnrichment }) {
  const sportLabel = importedStrengthLabel(h.sport);
  const minutes = Math.round(h.durationSec / 60);
  // Non-interactive: an imported HR row has no detail page (the Strava
  // activity isn't stored as a CardioSession or SessionRecord), so a
  // clickable card would just bounce to /settings. Render as a static
  // tile instead — duration + bpm is the whole story.
  return (
    <li className="rounded-xl border border-violet-800/40 bg-violet-950/30 px-4 py-3 opacity-80">
      <div className="flex items-center gap-2">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-violet-400/50" />
        <span className="truncate text-sm font-semibold text-violet-100/80">
          <span aria-hidden className="mr-1">🏋️</span>
          {sportLabel}
        </span>
        <span className="shrink-0 rounded-full border border-violet-500/30 bg-violet-500/5 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-violet-200/70">
          Imported
        </span>
      </div>
      <div className="mt-0.5 text-xs text-violet-300/60">
        Strength · From Strava · {minutes} min
        {h.avgHrBpm != null && <span> · {h.avgHrBpm} bpm</span>}
      </div>
    </li>
  );
}
