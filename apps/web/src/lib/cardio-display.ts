/**
 * Shared display helpers for cardio sessions. Used by /calendar, the Today
 * page (ThisWeekCard, RecentSessionsList) and anywhere else that needs a
 * compact rendering of a cardio activity.
 *
 * Single source of truth so the same modality always renders with the same
 * emoji, label and metric, regardless of which page is showing it.
 */

import type { CardioSession } from '@wendler/db-schema';

export const CARDIO_EMOJI: Record<CardioSession['modality'], string> = {
  run: '🏃',
  bike: '🚴',
  swim: '🏊',
  row: '🚣',
  walk: '🚶',
  padel: '🎾',
  other: '⚡',
};

export const CARDIO_SHORT: Record<CardioSession['modality'], string> = {
  run: 'Run',
  bike: 'Bike',
  swim: 'Swim',
  row: 'Row',
  walk: 'Walk',
  padel: 'Padel',
  other: 'Cardio',
};

export function cardioMetric(c: CardioSession): string {
  if (c.distanceKm && c.distanceKm > 0) {
    const km = c.distanceKm;
    return km < 10 ? `${km.toFixed(1)}k` : `${Math.round(km)}k`;
  }
  const min = Math.round(c.durationSec / 60);
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m ? `${h}h${m}` : `${h}h`;
  }
  return `${min}m`;
}

export function cardioFullTitle(c: CardioSession): string {
  const metric = cardioMetric(c);
  const label = CARDIO_SHORT[c.modality];
  const time = new Date(c.performedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${label} · ${metric}${c.avgHrBpm ? ` · ${c.avgHrBpm} bpm` : ''} · ${time}`;
}
