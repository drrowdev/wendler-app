// Programmer agent — find-substitution helper.
//
// Used by Phase 2's analyzeInjury workflow to ground Coach's proposed
// substitutions against the user's actual library. Given:
//   - the original movementId the Coach wants to modify/skip
//   - a constraint note (e.g. "avoid adductor stretch under load")
//   - the user's library
//   - the action (skip/reduce-load/etc.)
// Returns 1-3 viable same-family alternatives with one-line rationales.
//
// Implementation strategy (Phase 2 minimum):
//   - Local heuristic only (no LLM call). Match by `pattern` + primary muscles
//     overlap, prefer same equipment family, exclude the original.
//   - Returns alternatives without rationales beyond the heuristic match.
//
// Future enhancement (Phase 3+):
//   - Optionally call the Programmer LLM with a tightly-scoped sub-prompt
//     for richer alternatives + rationales. The LLM call is gated on a flag
//     so workflows can choose deterministic-only for cost/latency reasons.

interface MovementShape {
  id: string;
  name: string;
  equipment: string;
  pattern: string;
  primaryMuscles: string[];
  secondaryMuscles?: string[];
  externallyLoadable?: boolean;
  isCompound?: boolean;
}

export interface SubstitutionAlternative {
  movementId: string;
  movementName: string;
  rationale: string;
}

export interface FindSubstitutionInput {
  /** The movement we're trying to substitute around. */
  originalMovementId: string;
  /** Coach's reasoning + action — informs what kind of substitute to look for. */
  constraintNote: string;
  /** What the Coach is asking to do. Drives substitution strategy. */
  action: 'skip' | 'reduce-load' | 'reduce-range' | 'modify-execution' | 'monitor';
  /** Full movement library to choose from. */
  library: MovementShape[];
  /** Equipment available to the user (filter). */
  availableEquipment?: readonly string[];
  /** Cap on alternatives returned. Default 3. */
  maxAlternatives?: number;
}

export function findSubstitution(input: FindSubstitutionInput): SubstitutionAlternative[] {
  const original = input.library.find((m) => m.id === input.originalMovementId);
  if (!original) return [];

  // Some actions don't need substitution at all:
  //   - reduce-load on a loadable bodyweight movement: same movement,
  //     just lighter (the modification text says so)
  //   - reduce-range: same movement, partial ROM
  //   - modify-execution: same movement, different cue
  //   - monitor: same movement, watch for symptoms
  // Only `skip` and `reduce-load` on a non-bodyweight original genuinely
  // need a different movementId.
  if (
    input.action === 'reduce-range' ||
    input.action === 'modify-execution' ||
    input.action === 'monitor'
  ) {
    return [];
  }
  if (input.action === 'reduce-load' && original.equipment === 'bodyweight') {
    return [];
  }

  const max = input.maxAlternatives ?? 3;
  const eq = input.availableEquipment;
  const allowed = eq && eq.length > 0 ? new Set(eq) : null;

  // Score candidates by similarity to the original.
  const scored: { candidate: MovementShape; score: number; why: string[] }[] = [];
  for (const cand of input.library) {
    if (cand.id === original.id) continue;
    if (allowed && !allowed.has(cand.equipment) && cand.equipment !== 'bodyweight') {
      continue;
    }
    if (cand.pattern !== original.pattern) continue;

    const why: string[] = [];
    let score = 0;

    // Same movement family (pattern match).
    score += 5;
    why.push(`same ${cand.pattern} pattern`);

    // Primary-muscle overlap.
    const primOverlap = cand.primaryMuscles.filter((m) =>
      original.primaryMuscles.includes(m),
    );
    if (primOverlap.length > 0) {
      score += primOverlap.length * 3;
      why.push(`shares ${primOverlap.join('/')}`);
    }

    // Same compound vs isolation classification.
    if (!!cand.isCompound === !!original.isCompound) {
      score += 1;
    }

    // For reduce-load: prefer bodyweight or lighter equipment as substitute.
    if (input.action === 'reduce-load') {
      if (cand.equipment === 'bodyweight') {
        score += 3;
        why.push('bodyweight');
      }
    }

    scored.push({ candidate: cand, score, why });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ candidate, why }) => ({
    movementId: candidate.id,
    movementName: candidate.name,
    rationale: why.join(' · '),
  }));
}
