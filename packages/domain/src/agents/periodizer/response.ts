// Periodizer response validator. Parses + validates the model's JSON
// against the schema documented in the system prompt. Defense-in-depth: a
// strict validator on the response side makes the chat orchestrator's
// retry-on-validation-failure path actually trip when the model improvises.

const VALID_VERDICTS = [
  'deload-now',
  'deload-soon',
  'continue',
  'taper-now',
  'ramp-up',
  'tm-test',
  'extend-block',
  'switch-template',
] as const;
export type PeriodizerVerdict = (typeof VALID_VERDICTS)[number];
const VERDICT_SET = new Set<string>(VALID_VERDICTS);

export interface PeriodizerEvidence {
  label: string;
  value: string;
  interpretation: string;
}

export interface PeriodizerAlternativeVerdict {
  verdict: PeriodizerVerdict;
  rationale: string;
}

export interface PeriodizerResponse {
  verdict: PeriodizerVerdict;
  headline: string;
  explanation: string;
  evidence: PeriodizerEvidence[];
  nextSteps: string[];
  alternativeVerdicts: PeriodizerAlternativeVerdict[];
  shortReply: string;
}

export type ParsePeriodizerResult =
  | { ok: true; data: PeriodizerResponse }
  | { ok: false; errors: string[] };

function stripCodeFence(raw: string): string {
  let s = raw.trim().replace(/^\uFEFF/, '');
  if (s.startsWith('```')) {
    s = s.replace(/^```[a-zA-Z]*\s*\n?/, '');
    s = s.replace(/\n?```\s*$/, '');
    s = s.trim();
  }
  return s;
}

export function parsePeriodizerResponse(raw: string): ParsePeriodizerResult {
  const errors: string[] = [];
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (e) {
    return { ok: false, errors: [`Response is not valid JSON: ${(e as Error).message}`] };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['Response must be a JSON object.'] };
  }
  const obj = json as Record<string, unknown>;

  if (typeof obj.verdict !== 'string' || !VERDICT_SET.has(obj.verdict)) {
    errors.push(
      `verdict must be one of ${VALID_VERDICTS.join(', ')}. Got: ${JSON.stringify(obj.verdict)}.`,
    );
  }
  if (typeof obj.headline !== 'string' || obj.headline.trim().length === 0) {
    errors.push('headline must be a non-empty string.');
  } else if (obj.headline.length > 200) {
    errors.push(`headline must be ≤ 200 characters (was ${obj.headline.length}).`);
  }
  if (typeof obj.explanation !== 'string' || obj.explanation.trim().length === 0) {
    errors.push('explanation must be a non-empty string.');
  }
  if (typeof obj.shortReply !== 'string' || obj.shortReply.trim().length === 0) {
    errors.push('shortReply must be a non-empty string.');
  }

  const evidence: PeriodizerEvidence[] = [];
  if (!Array.isArray(obj.evidence) || obj.evidence.length === 0) {
    errors.push('evidence must be a non-empty array.');
  } else {
    obj.evidence.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`evidence[${i}] must be an object.`);
        return;
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.label !== 'string' || e.label.trim().length === 0) {
        errors.push(`evidence[${i}].label must be a non-empty string.`);
        return;
      }
      if (typeof e.value !== 'string' || e.value.length === 0) {
        errors.push(`evidence[${i}].value must be a non-empty string.`);
        return;
      }
      if (typeof e.interpretation !== 'string' || e.interpretation.trim().length === 0) {
        errors.push(`evidence[${i}].interpretation must be a non-empty string.`);
        return;
      }
      evidence.push({
        label: e.label.trim(),
        value: e.value,
        interpretation: e.interpretation.trim(),
      });
    });
  }

  const nextSteps: string[] = [];
  if (obj.nextSteps != null) {
    if (!Array.isArray(obj.nextSteps)) {
      errors.push('nextSteps must be an array of strings.');
    } else {
      obj.nextSteps.forEach((s, i) => {
        if (typeof s !== 'string' || s.trim().length === 0) {
          errors.push(`nextSteps[${i}] must be a non-empty string.`);
          return;
        }
        nextSteps.push(s.trim());
      });
    }
  }

  const alternativeVerdicts: PeriodizerAlternativeVerdict[] = [];
  if (obj.alternativeVerdicts != null) {
    if (!Array.isArray(obj.alternativeVerdicts)) {
      errors.push('alternativeVerdicts must be an array of {verdict, rationale}.');
    } else {
      obj.alternativeVerdicts.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object') {
          errors.push(`alternativeVerdicts[${i}] must be an object.`);
          return;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.verdict !== 'string' || !VERDICT_SET.has(e.verdict)) {
          errors.push(
            `alternativeVerdicts[${i}].verdict must be one of ${VALID_VERDICTS.join(', ')}.`,
          );
          return;
        }
        if (typeof e.rationale !== 'string' || e.rationale.trim().length === 0) {
          errors.push(`alternativeVerdicts[${i}].rationale must be a non-empty string.`);
          return;
        }
        alternativeVerdicts.push({
          verdict: e.verdict as PeriodizerVerdict,
          rationale: e.rationale.trim(),
        });
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      verdict: obj.verdict as PeriodizerVerdict,
      headline: (obj.headline as string).trim(),
      explanation: (obj.explanation as string).trim(),
      evidence,
      nextSteps,
      alternativeVerdicts,
      shortReply: (obj.shortReply as string).trim(),
    },
  };
}
