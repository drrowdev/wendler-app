'use client';

// AboutYouCard — single source for user demographics + training background.
// Persists to the `userProfile` singleton (v17 schema). Bodyweight on this
// card is the canonical entry point for current bw — saving writes a fresh
// RecoveryEntry for today so historical e1RM calculations stay correct
// (effectiveLoadKg reads bw from recovery, not user profile).
//
// All fields are optional. Demographics feed Coach + Programmer + Periodizer
// + Summarizer agent prompts as dynamic context.

import { useEffect, useState } from 'react';
import type { UserProfile } from '@wendler/db-schema';
import { getDb } from '@/lib/db';
import { useUserProfile } from '@/lib/hooks';
import { upsertRecoveryEntry, getLatestBodyweightOnOrBefore } from '@/lib/recovery';
import { kickSync } from '@/lib/sync';

const EXPERIENCE_OPTIONS: { id: NonNullable<UserProfile['trainingExperience']>; label: string; help: string }[] = [
  { id: 'novice', label: 'Novice', help: '< 2 years consistent training' },
  { id: 'intermediate', label: 'Intermediate', help: '2–5 years' },
  { id: 'advanced', label: 'Advanced', help: '5–10 years, has pushed near-maximal loads' },
  { id: 'elite', label: 'Elite', help: '10+ years, competitive background' },
];

export function AboutYouCard() {
  const profile = useUserProfile();
  const [dob, setDob] = useState('');
  const [sex, setSex] = useState<'' | 'male' | 'female'>('');
  const [heightCm, setHeightCm] = useState('');
  const [bw, setBw] = useState('');
  const [bwCurrent, setBwCurrent] = useState<number | undefined>();
  const [experience, setExperience] =
    useState<'' | 'novice' | 'intermediate' | 'advanced' | 'elite'>('');
  const [yearsLifting, setYearsLifting] = useState('');
  const [yearsRunning, setYearsRunning] = useState('');
  const [backgroundNotes, setBackgroundNotes] = useState('');
  const [savedMsg, setSavedMsg] = useState('');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the form on first profile load + grab the current bodyweight
  // from the recovery log (single source for current bw).
  useEffect(() => {
    if (hydrated) return;
    if (profile === undefined) return; // still loading
    setDob(profile?.dateOfBirth ?? '');
    setSex((profile?.sex ?? '') as '' | 'male' | 'female');
    setHeightCm(profile?.heightCm ? String(profile.heightCm) : '');
    setExperience((profile?.trainingExperience ?? '') as typeof experience);
    setYearsLifting(profile?.yearsLifting ? String(profile.yearsLifting) : '');
    setYearsRunning(profile?.yearsRunning ? String(profile.yearsRunning) : '');
    setBackgroundNotes(profile?.backgroundNotes ?? '');
    void getLatestBodyweightOnOrBefore().then((latest) => {
      setBwCurrent(latest);
    });
    setHydrated(true);
  }, [profile, hydrated]);

  const ageFromDob = (() => {
    if (!dob) return undefined;
    const [y, m, d] = dob.split('-').map(Number);
    if (!y || !m || !d) return undefined;
    const now = new Date();
    let age = now.getFullYear() - y;
    const beforeBirthday =
      now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d);
    if (beforeBirthday) age -= 1;
    return age >= 0 && age < 120 ? age : undefined;
  })();

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date().toISOString();
    const patch: Partial<UserProfile> = {};
    if (dob.trim()) patch.dateOfBirth = dob.trim();
    if (sex) patch.sex = sex;
    const h = parseFloat(heightCm);
    if (Number.isFinite(h) && h >= 100 && h <= 250) patch.heightCm = h;
    if (experience) patch.trainingExperience = experience;
    const yl = parseFloat(yearsLifting);
    if (Number.isFinite(yl) && yl >= 0 && yl <= 80) patch.yearsLifting = yl;
    const yr = parseFloat(yearsRunning);
    if (Number.isFinite(yr) && yr >= 0 && yr <= 80) patch.yearsRunning = yr;
    if (backgroundNotes.trim()) patch.backgroundNotes = backgroundNotes.trim();

    const db = getDb();
    const existing = await db.userProfile.get('singleton');
    await db.userProfile.put({
      id: 'singleton',
      ...existing,
      ...patch,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    } as UserProfile);

    // Bodyweight goes to the recovery log (preserves per-day history for
    // e1RM calculations on bodyweight movements). One write here updates
    // both the current-bw display and the historical time-series.
    const newBw = parseFloat(bw.replace(',', '.'));
    if (Number.isFinite(newBw) && newBw > 0 && newBw < 500) {
      await upsertRecoveryEntry({ bodyweightKg: newBw });
      setBwCurrent(newBw);
      setBw('');
    }

    kickSync();
    setSavedMsg('Saved');
    setTimeout(() => setSavedMsg(''), 1500);
  };

  return (
    <section className="rounded-2xl border border-border bg-card p-4">
      <header className="mb-3">
        <h2 className="text-lg font-semibold">About you</h2>
        <p className="text-xs text-muted">
          Optional, helps the AI tailor advice. All fields private; stored locally + synced to your own devices only.
        </p>
      </header>

      <form className="space-y-4" onSubmit={onSave}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs text-muted">Date of birth</span>
            <input
              type="date"
              value={dob}
              max={new Date().toISOString().slice(0, 10)}
              min="1900-01-01"
              onChange={(e) => setDob(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
            />
            {ageFromDob !== undefined && (
              <span className="mt-0.5 block text-[11px] text-muted">{ageFromDob} years old</span>
            )}
          </label>

          <label className="block">
            <span className="text-xs text-muted">Sex</span>
            <div className="mt-1 flex gap-2">
              {(['male', 'female'] as const).map((s) => (
                <button
                  type="button"
                  key={s}
                  onClick={() => setSex(s)}
                  className={`flex-1 rounded-lg border px-2 py-2 text-sm capitalize ${
                    sex === s
                      ? 'border-accent bg-accent text-bg'
                      : 'border-border bg-bg text-fg'
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </label>

          <label className="block">
            <span className="text-xs text-muted">Height (cm)</span>
            <input
              type="number"
              inputMode="decimal"
              min={100}
              max={250}
              step={0.5}
              value={heightCm}
              onChange={(e) => setHeightCm(e.target.value)}
              placeholder="178"
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted">Bodyweight (kg)</span>
            <input
              type="number"
              inputMode="decimal"
              min={20}
              max={500}
              step={0.1}
              value={bw}
              onChange={(e) => setBw(e.target.value)}
              placeholder={bwCurrent ? `current: ${bwCurrent}` : '—'}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
            />
            {bwCurrent !== undefined && (
              <span className="mt-0.5 block text-[11px] text-muted">
                Current: {bwCurrent} kg. New value logs today.
              </span>
            )}
          </label>
        </div>

        <div className="space-y-2">
          <span className="text-xs text-muted">Training experience</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {EXPERIENCE_OPTIONS.map((opt) => (
              <button
                type="button"
                key={opt.id}
                onClick={() => setExperience(opt.id)}
                title={opt.help}
                className={`rounded-lg border px-2 py-2 text-sm ${
                  experience === opt.id
                    ? 'border-accent bg-accent text-bg'
                    : 'border-border bg-bg text-fg'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs text-muted">Years lifting</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={80}
              step={0.5}
              value={yearsLifting}
              onChange={(e) => setYearsLifting(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted">Years running</span>
            <input
              type="number"
              inputMode="decimal"
              min={0}
              max={80}
              step={0.5}
              value={yearsRunning}
              onChange={(e) => setYearsRunning(e.target.value)}
              className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2"
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs text-muted">
            Background notes
            <span className="ml-1 text-muted/70">(injury history, sports background, sensitivities)</span>
          </span>
          <textarea
            rows={3}
            value={backgroundNotes}
            onChange={(e) => setBackgroundNotes(e.target.value)}
            placeholder="e.g. Former rugby player. Left ACL reconstruction 2018, fully recovered. Recurring lower-back tightness; PT-cleared but a sensitivity."
            className="mt-1 w-full rounded-lg border border-border bg-bg px-2 py-2 leading-snug"
          />
        </label>

        <div className="flex items-center justify-end gap-2">
          {savedMsg && <span className="text-xs text-emerald-300">{savedMsg}</span>}
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg"
          >
            Save
          </button>
        </div>
      </form>
    </section>
  );
}
