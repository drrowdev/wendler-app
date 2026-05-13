'use client';

import { useEffect, useState } from 'react';
import { getDb } from '@/lib/db';
import { authFetch } from '@/lib/auth';
import { applyPlanMatchToBatch, rematchAllCardioAgainstPlan } from '@/lib/runPlan';
import { useSettings } from '@/lib/hooks';
import { notify } from '@/lib/notify';
import type { CardioSession, StrengthHrEnrichment } from '@wendler/db-schema';

interface StravaStatus {
  configured: boolean;
  connected: boolean;
  athleteName?: string;
  hrZones?: number[] | null;
  lastSyncAt?: string | null;
  connectedAt?: string;
}

interface SyncResponse {
  imported: CardioSession[];
  strengthHr?: StrengthHrEnrichment[];
  count: number;
  strengthHrCount?: number;
  since: string;
  lastSyncAt: string;
}

function fmtDateTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Garmin's default 5-zone %LTHR percentages for running. Z5 is open-ended
 * above Z4 so we only need four upper-bound percentages here. Source:
 * Garmin support — "Setting Heart Rate Zones" (LTHR method).
 */
const DEFAULT_LTHR_UPPER_PCT = [0.81, 0.89, 0.93, 0.99] as const;
const LTHR_PCT_KEY = 'wendler.lthrZonePct';
const ZONE_NAMES = ['warmup', 'easy', 'aerobic', 'threshold', 'maximum'] as const;

function loadLthrPct(): number[] {
  if (typeof window === 'undefined') return [...DEFAULT_LTHR_UPPER_PCT];
  try {
    const raw = window.localStorage.getItem(LTHR_PCT_KEY);
    if (!raw) return [...DEFAULT_LTHR_UPPER_PCT];
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 4 &&
      parsed.every((v) => typeof v === 'number' && isFinite(v) && v > 0 && v <= 1.5)
    ) {
      return parsed as number[];
    }
  } catch {
    // fall through to defaults
  }
  return [...DEFAULT_LTHR_UPPER_PCT];
}

export function StravaPanel() {
  const settings = useSettings();
  const strengthHrEnabled = settings?.strengthHrEnrichment ?? true;
  const [status, setStatus] = useState<StravaStatus | null>(null);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'refresh' | 'inspect' | 'disconnect' | 'zones' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [inspect, setInspect] = useState<unknown>(null);
  const [editingZones, setEditingZones] = useState(false);
  const [zoneInputs, setZoneInputs] = useState<string[]>(['', '', '', '']);
  const [lthrInput, setLthrInput] = useState('');
  const [lthrPct, setLthrPct] = useState<number[]>(() => [...DEFAULT_LTHR_UPPER_PCT]);
  const [pctInputs, setPctInputs] = useState<string[]>(() =>
    DEFAULT_LTHR_UPPER_PCT.map((p) => String(Math.round(p * 100))),
  );
  const [editingPct, setEditingPct] = useState(false);

  useEffect(() => {
    const loaded = loadLthrPct();
    setLthrPct(loaded);
    setPctInputs(loaded.map((p) => String(Math.round(p * 100))));
  }, []);

  const pctLabel = lthrPct.map((p) => `${Math.round(p * 100)}%`).join(' / ');
  const isCustomPct = lthrPct.some(
    (p, i) => Math.round(p * 100) !== Math.round((DEFAULT_LTHR_UPPER_PCT[i] ?? 0) * 100),
  );

  function calcZonesFromLthr() {
    const lthr = Number(lthrInput);
    if (!isFinite(lthr) || lthr <= 0) {
      setMsg('Enter a positive LTHR (bpm).');
      return;
    }
    setZoneInputs(lthrPct.map((p) => String(Math.round(p * lthr))));
    setMsg(
      `Filled from LTHR ${lthr} bpm using ${pctLabel} of LTHR — review and Save.`,
    );
  }

  function savePct() {
    const nums = pctInputs.map((s) => Number(s) / 100);
    if (!nums.every((n) => isFinite(n) && n > 0 && n <= 1.5)) {
      setMsg('Each %LTHR threshold must be a positive number ≤ 150.');
      return;
    }
    for (let i = 1; i < nums.length; i++) {
      const cur = nums[i] ?? 0;
      const prev = nums[i - 1] ?? 0;
      if (cur <= prev) {
        setMsg('%LTHR thresholds must be ascending (Z1 < Z2 < Z3 < Z4).');
        return;
      }
    }
    setLthrPct(nums);
    try {
      window.localStorage.setItem(LTHR_PCT_KEY, JSON.stringify(nums));
    } catch {
      // ignore quota errors — value will revert to defaults next mount
    }
    setEditingPct(false);
    setMsg(
      `Saved %LTHR thresholds: ${nums.map((n) => Math.round(n * 100) + '%').join(' / ')}.`,
    );
  }

  function resetPct() {
    const defaults = [...DEFAULT_LTHR_UPPER_PCT];
    setLthrPct(defaults);
    setPctInputs(defaults.map((p) => String(Math.round(p * 100))));
    try {
      window.localStorage.removeItem(LTHR_PCT_KEY);
    } catch {
      // ignore
    }
    setMsg(
      `Reset %LTHR thresholds to Garmin defaults (${defaults.map((p) => Math.round(p * 100) + '%').join(' / ')}).`,
    );
  }

  async function load() {
    try {
      const r = await authFetch('/api/strava/status', { credentials: 'include' });
      if (r.status === 401) {
        setStatus({ configured: false, connected: false });
        setMsg('Sign in with Microsoft first to enable Strava sync.');
        return;
      }
      const j = (await r.json()) as StravaStatus;
      setStatus(j);
    } catch {
      setStatus({ configured: false, connected: false });
    }
  }

  useEffect(() => {
    void load();
    // Reflect ?strava=connected from callback
    const url = new URL(window.location.href);
    const flag = url.searchParams.get('strava');
    if (flag === 'connected') setMsg('✅ Strava connected.');
    else if (flag === 'error') {
      setMsg(`Strava error: ${url.searchParams.get('reason') ?? 'unknown'}`);
    }
    if (flag) {
      url.searchParams.delete('strava');
      url.searchParams.delete('reason');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  async function onConnect() {
    setBusy('connect');
    setMsg(null);
    try {
      const r = await authFetch('/api/strava/connect', { credentials: 'include' });
      if (!r.ok) {
        setMsg(`Connect failed (${r.status}). Check STRAVA_CLIENT_ID app setting.`);
        return;
      }
      const { authorizeUrl } = (await r.json()) as { authorizeUrl: string };
      window.location.href = authorizeUrl;
    } finally {
      setBusy(null);
    }
  }

  async function onSync(opts: { backfillDays?: number; mode: 'sync' | 'refresh' } = { mode: 'sync' }) {
    setBusy(opts.mode);
    setMsg(null);
    try {
      const params = new URLSearchParams();
      if (opts.backfillDays) params.set('backfillDays', String(opts.backfillDays));
      if (!strengthHrEnabled) params.set('includeStrengthHr', 'false');
      const qs = params.toString();
      const path = qs ? `/api/strava/sync?${qs}` : '/api/strava/sync';
      const r = await authFetch(path, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) {
        setMsg(`Sync failed (${r.status}).`);
        return;
      }
      const j = (await r.json()) as SyncResponse;
      // De-dup against existing externalId, then write to Dexie. Each new
      // run is also tagged with its planned-kind / match-confidence against
      // the user's recurring weekly RunPlan template (if one exists).
      const db = getDb();
      const matched = await applyPlanMatchToBatch(j.imported);
      let added = 0;
      let refreshed = 0;
      for (const c of matched) {
        const existing = await db.cardio.where('externalId').equals(c.externalId!).first();
        if (existing) {
          await db.cardio.put({ ...existing, ...c, id: existing.id });
          refreshed += 1;
        } else {
          await db.cardio.put(c);
          added += 1;
        }
      }
      // Persist strength-HR enrichments to their dedicated table. Local-only;
      // not synced. De-dup by externalId so re-syncs don't pile up.
      let strengthHrAdded = 0;
      let strengthHrRefreshed = 0;
      if (strengthHrEnabled && j.strengthHr) {
        for (const h of j.strengthHr) {
          const existing = await db.strengthHr.where('externalId').equals(h.externalId).first();
          if (existing) {
            await db.strengthHr.put({ ...existing, ...h, id: existing.id });
            strengthHrRefreshed += 1;
          } else {
            await db.strengthHr.put(h);
            strengthHrAdded += 1;
          }
        }
      }
      // Also re-run the matcher across older activities — the user may have
      // updated the template since the last sync. Cheap, idempotent.
      await rematchAllCardioAgainstPlan();
      const cardioSummary = opts.mode === 'refresh'
        ? `Refreshed ${refreshed} activities (${added} new) since ${fmtDateTime(j.since)}.`
        : `Imported ${j.count} activities (${added} new) since ${fmtDateTime(j.since)}.`;
      const strengthHrSummary = strengthHrEnabled && (strengthHrAdded + strengthHrRefreshed) > 0
        ? ` Strength HR: +${strengthHrAdded} new, ${strengthHrRefreshed} updated.`
        : '';
      setMsg(cardioSummary + strengthHrSummary);
      // Log to the inbox so cardio import history is durable beyond the
      // transient panel message. Plan-match auto-tag count is included so
      // the user can see at a glance how many runs were auto-linked to a
      // planned slot vs left unmatched.
      const autoMatched = matched.filter(
        (m) => m.modality === 'run' && m.planMatch === 'exact',
      ).length;
      const unmatched = matched.filter(
        (m) => m.modality === 'run' && (!m.planMatch || m.planMatch === 'none'),
      ).length;
      if (added > 0 || strengthHrAdded > 0) {
        const planMatchLine =
          added > 0
            ? `\n${autoMatched} auto-tagged to a planned slot · ${unmatched} unmatched (visible without a plan badge on /cardio).`
            : '';
        await notify.info({
          channel: 'sync',
          title:
            opts.mode === 'refresh'
              ? `Strava refresh: ${refreshed} updated, ${added} new`
              : `Strava sync: ${added} new activit${added === 1 ? 'y' : 'ies'}`,
          body: `${cardioSummary}${strengthHrSummary}${planMatchLine}`,
          deepLink: { href: '/cardio', label: 'Open /cardio' },
          context: {
            mode: opts.mode,
            added,
            refreshed,
            autoMatched,
            unmatched,
            strengthHrAdded,
            strengthHrRefreshed,
            since: j.since,
          },
        });
      }
      // Optimistically reflect the new lastSyncAt from the sync response so
      // the "Last sync:" line updates immediately, even if the follow-up
      // status fetch is briefly stale (e.g. Cosmos read-your-writes lag).
      setStatus((prev) => (prev ? { ...prev, lastSyncAt: j.lastSyncAt } : prev));
      await load();
    } catch (e) {
      setMsg(`Sync error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onInspect() {
    setBusy('inspect');
    setMsg(null);
    setInspect(null);
    try {
      const r = await authFetch('/api/strava/inspect?count=5', {
        credentials: 'include',
      });
      if (!r.ok) {
        setMsg(`Inspect failed (${r.status}).`);
        return;
      }
      setInspect(await r.json());
    } catch (e) {
      setMsg(`Inspect error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect() {
    if (!confirm('Disconnect Strava? Imported activities are kept.')) return;
    setBusy('disconnect');
    try {
      await authFetch('/api/strava/disconnect', { method: 'POST', credentials: 'include' });
      setMsg('Strava disconnected.');
      await load();
    } finally {
      setBusy(null);
    }
  }

  function startEditZones() {
    const z = status?.hrZones ?? [];
    setZoneInputs([
      String(z[0] ?? ''),
      String(z[1] ?? ''),
      String(z[2] ?? ''),
      String(z[3] ?? ''),
    ]);
    setEditingZones(true);
    setMsg(null);
  }

  async function saveZones() {
    const parsed = zoneInputs.map((s) => Number(s));
    if (parsed.some((n) => !isFinite(n) || n <= 0)) {
      setMsg('Each zone must be a positive number (bpm).');
      return;
    }
    for (let i = 1; i < 4; i += 1) {
      if (parsed[i]! < parsed[i - 1]!) {
        setMsg('Zones must be non-decreasing (Z1 ≤ Z2 ≤ Z3 ≤ Z4).');
        return;
      }
    }
    // Persist 5 values; Z5 is open-ended (sentinel 999).
    const z5 = status?.hrZones?.[4] ?? 999;
    const body = { hrZones: [...parsed, z5] };
    setBusy('zones');
    try {
      const r = await authFetch('/api/strava/hr-zones', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        setMsg(`Save failed (${r.status}).`);
        return;
      }
      setStatus((prev) => (prev ? { ...prev, hrZones: body.hrZones } : prev));
      setEditingZones(false);
      setMsg('HR zones saved. New imports will use these; older sessions are unchanged (use "Refresh last 60 days" to recompute).');
    } catch (e) {
      setMsg(`Save error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function refreshZonesFromStrava() {
    setBusy('zones');
    setMsg(null);
    try {
      const r = await authFetch('/api/strava/hr-zones', {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) {
        setMsg(`Refresh from Strava failed (${r.status}).`);
        return;
      }
      const j = (await r.json()) as { hrZones: number[] };
      setStatus((prev) => (prev ? { ...prev, hrZones: j.hrZones } : prev));
      setZoneInputs(j.hrZones.slice(0, 4).map(String));
      setMsg('HR zones refreshed from Strava.');
    } catch (e) {
      setMsg(`Refresh error: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  if (!status) return <p className="text-xs text-muted">Loading Strava status…</p>;
  if (!status.configured) {
    return (
      <p className="text-xs text-muted">
        Strava integration is not configured on the server. Set STRAVA_CLIENT_ID and
        STRAVA_CLIENT_SECRET in app settings.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {!status.connected ? (
        <button
          type="button"
          onClick={onConnect}
          disabled={busy !== null}
          className="rounded-lg bg-[#fc4c02] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {busy === 'connect' ? 'Redirecting…' : 'Connect Strava'}
        </button>
      ) : (
        <>
          <div className="flex items-center justify-between text-sm">
            <div>
              <div className="font-medium">{status.athleteName}</div>
              <div className="text-xs text-muted">
                Last sync: {fmtDateTime(status.lastSyncAt)}
              </div>
              {status.hrZones && !editingZones && (
                <div className="text-xs text-muted">
                  HR zones: {status.hrZones.slice(0, 4).join(' / ')} bpm{' '}
                  <button
                    type="button"
                    onClick={startEditZones}
                    className="ml-1 text-accent hover:underline"
                  >
                    Edit
                  </button>
                </div>
              )}
              {!status.hrZones && !editingZones && (
                <div className="text-xs text-muted">
                  HR zones: not set{' '}
                  <button
                    type="button"
                    onClick={startEditZones}
                    className="ml-1 text-accent hover:underline"
                  >
                    Set
                  </button>
                </div>
              )}
              {editingZones && (
                <div className="mt-2 space-y-2 rounded-lg border border-border bg-bg p-3">
                  <p className="text-[11px] text-muted">
                    Garmin %LTHR uses 5 zones: <strong>Z1 warmup</strong>, <strong>Z2 easy</strong>, <strong>Z3 aerobic</strong>, <strong>Z4 threshold</strong>, <strong>Z5 maximum</strong> (everything above Z4). Set the upper bpm bound for Z1–Z4 below; used for time-in-zone on new imports.
                  </p>
                  <div className="flex flex-wrap items-end gap-2 rounded border border-border/60 bg-card/60 p-2">
                    <label className="flex flex-col gap-1 text-[11px] text-muted">
                      <span>Calc from LTHR (bpm)</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={lthrInput}
                        onChange={(e) => setLthrInput(e.target.value)}
                        placeholder="e.g. 175"
                        className="w-28 rounded border border-border bg-card px-2 py-1 text-sm text-fg"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={calcZonesFromLthr}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                      title={`Current %LTHR thresholds: Z1≤${Math.round((lthrPct[0] ?? 0) * 100)}%, Z2≤${Math.round((lthrPct[1] ?? 0) * 100)}%, Z3≤${Math.round((lthrPct[2] ?? 0) * 100)}%, Z4≤${Math.round((lthrPct[3] ?? 0) * 100)}% of LTHR`}
                    >
                      Calculate
                    </button>
                    <span className="text-[11px] text-muted">
                      Using {pctLabel} of LTHR{isCustomPct ? ' (custom)' : ' (Garmin defaults)'} — fills the four inputs below.{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setPctInputs(lthrPct.map((p) => String(Math.round(p * 100))));
                          setEditingPct((v) => !v);
                        }}
                        className="text-accent hover:underline"
                      >
                        {editingPct ? 'Hide' : 'Edit %'}
                      </button>
                    </span>
                  </div>
                  {editingPct && (
                    <div className="space-y-2 rounded border border-border/60 bg-card/60 p-2">
                      <p className="text-[11px] text-muted">
                        Upper-bound %LTHR for each zone. Must be ascending (Z1 &lt; Z2 &lt; Z3 &lt; Z4). Z5 (maximum) is everything above Z4. Garmin defaults: 81 / 89 / 93 / 99.
                      </p>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                        {pctInputs.map((v, i) => (
                          <label key={i} className="flex flex-col gap-1 text-[11px] text-muted">
                            <span>
                              Z{i + 1} {ZONE_NAMES[i]} ≤ %
                            </span>
                            <input
                              type="number"
                              inputMode="decimal"
                              value={v}
                              onChange={(e) => {
                                const next = [...pctInputs];
                                next[i] = e.target.value;
                                setPctInputs(next);
                              }}
                              className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-fg"
                            />
                          </label>
                        ))}
                        <div className="flex flex-col gap-1 text-[11px] text-muted">
                          <span>
                            Z5 {ZONE_NAMES[4]}
                          </span>
                          <div className="w-full rounded border border-border/40 bg-card/40 px-2 py-1 text-sm text-muted">
                            &gt; {Math.round((lthrPct[3] ?? 0) * 100)}%
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={savePct}
                          className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg"
                        >
                          Save %
                        </button>
                        <button
                          type="button"
                          onClick={resetPct}
                          className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                        >
                          Reset to defaults
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {zoneInputs.map((v, i) => (
                      <label key={i} className="flex flex-col gap-1 text-[11px] text-muted">
                        <span>
                          Z{i + 1} {ZONE_NAMES[i]} ≤ {Math.round((lthrPct[i] ?? 0) * 100)}%
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={v}
                          onChange={(e) => {
                            const next = [...zoneInputs];
                            next[i] = e.target.value;
                            setZoneInputs(next);
                          }}
                          className="w-full rounded border border-border bg-card px-2 py-1 text-sm text-fg"
                        />
                      </label>
                    ))}
                    <div className="flex flex-col gap-1 text-[11px] text-muted">
                      <span>
                        Z5 {ZONE_NAMES[4]} &gt; {Math.round((lthrPct[3] ?? 0) * 100)}%
                      </span>
                      <div className="w-full rounded border border-border/40 bg-card/40 px-2 py-1 text-sm text-muted">
                        {zoneInputs[3] && Number(zoneInputs[3]) > 0
                          ? `> ${zoneInputs[3]} bpm`
                          : '—'}
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={saveZones}
                      disabled={busy !== null}
                      className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg disabled:opacity-50"
                    >
                      {busy === 'zones' ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingZones(false)}
                      disabled={busy !== null}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={refreshZonesFromStrava}
                      disabled={busy !== null}
                      title="Re-fetch zones from your Strava athlete profile"
                      className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
                    >
                      {busy === 'zones' ? '…' : 'Pull from Strava'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onSync({ mode: 'sync' })}
              disabled={busy !== null}
              className="rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-bg disabled:opacity-50"
            >
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button
              type="button"
              onClick={() => onSync({ mode: 'refresh', backfillDays: 60 })}
              disabled={busy !== null}
              title="Re-fetch the last 60 days from Strava (incl. activity descriptions). Use this after Runna writes its workout details into the description."
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"
            >
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh last 60 days'}
            </button>
            <button
              type="button"
              onClick={onInspect}
              disabled={busy !== null}
              title="Show the raw Strava fields (name / description / workout_type) for the last 5 runs so you can see what the matcher has to work with."
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg disabled:opacity-50"
            >
              {busy === 'inspect' ? 'Inspecting…' : 'Inspect last 5 runs'}
            </button>
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy !== null}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted hover:text-fg"
            >
              Disconnect
            </button>
          </div>
        </>
      )}
      {msg && <p className="text-xs text-muted">{msg}</p>}
      {inspect != null && (
        <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-3 text-[11px] leading-snug text-muted">
          {JSON.stringify(inspect, null, 2)}
        </pre>
      )}
    </div>
  );
}
