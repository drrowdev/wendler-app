'use client';

// Training Profile page — extracted from /goals in v310. This route owns the
// four-axis Training Profile (Primary/Secondary movement, Phase, Filters,
// LLM notes) so the /goals page can return to its core scope: PR targets,
// race times, habits. The underlying state still lives in
// `settings.trainingProfile` so the suggester and `effectiveTrainingPhase`
// pick it up regardless of which URL the user edited it from.

import Link from 'next/link';
import { TrainingGoalsSection } from '@/components/TrainingGoalsSection';

export default function ProfilePage() {
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">Training Profile</h1>
        <p className="text-xs text-muted">
          Shapes the AI assistance suggester: primary and secondary movement focus,
          training phase, hard constraints (filters), and free-form notes the LLM
          reads as nuance. Targets and PRs live on the{' '}
          <Link href="/goals" className="underline-offset-2 hover:underline">
            Goals
          </Link>{' '}
          page.
        </p>
      </header>

      <TrainingGoalsSection />
    </div>
  );
}
