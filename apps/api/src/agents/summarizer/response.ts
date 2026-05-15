// Summarizer response validator.

const REQUIRED_HEADINGS = [
  'Training summary',
  'Strength trend',
  'Running + cardio',
  'Load + recovery',
  'Active limitations',
  'Looking ahead',
] as const;
export const SUMMARIZER_SECTION_HEADINGS = REQUIRED_HEADINGS;

export interface SummarizerSection {
  heading: (typeof REQUIRED_HEADINGS)[number];
  markdown: string;
}

export interface SummarizerResponse {
  weekStart: string;
  weekEnd: string;
  sections: SummarizerSection[];
  highlights: string[];
}

export type ParseSummarizerResult =
  | { ok: true; data: SummarizerResponse }
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

export interface ParseSummarizerOptions {
  /** When set, weekStart/weekEnd in the response must match these exactly. */
  expectedWeekStart?: string;
  expectedWeekEnd?: string;
}

export function parseSummarizerResponse(
  raw: string,
  opts: ParseSummarizerOptions = {},
): ParseSummarizerResult {
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

  if (typeof obj.weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.weekStart)) {
    errors.push('weekStart must be a YYYY-MM-DD string.');
  } else if (opts.expectedWeekStart && obj.weekStart !== opts.expectedWeekStart) {
    errors.push(
      `weekStart=${obj.weekStart} does not match the expected week (${opts.expectedWeekStart}).`,
    );
  }
  if (typeof obj.weekEnd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.weekEnd)) {
    errors.push('weekEnd must be a YYYY-MM-DD string.');
  } else if (opts.expectedWeekEnd && obj.weekEnd !== opts.expectedWeekEnd) {
    errors.push(
      `weekEnd=${obj.weekEnd} does not match the expected week (${opts.expectedWeekEnd}).`,
    );
  }

  const sections: SummarizerSection[] = [];
  if (!Array.isArray(obj.sections) || obj.sections.length !== REQUIRED_HEADINGS.length) {
    errors.push(
      `sections must be an array of exactly ${REQUIRED_HEADINGS.length} entries.`,
    );
  } else {
    obj.sections.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') {
        errors.push(`sections[${i}] must be an object.`);
        return;
      }
      const e = entry as Record<string, unknown>;
      const expected = REQUIRED_HEADINGS[i];
      if (typeof e.heading !== 'string' || e.heading !== expected) {
        errors.push(
          `sections[${i}].heading must be "${expected}" (got ${JSON.stringify(e.heading)}).`,
        );
        return;
      }
      if (typeof e.markdown !== 'string') {
        errors.push(`sections[${i}].markdown must be a string.`);
        return;
      }
      if (e.markdown.length > 1500) {
        errors.push(
          `sections[${i}] (${expected}) markdown exceeds 1500 chars (${e.markdown.length}).`,
        );
        return;
      }
      sections.push({ heading: expected, markdown: e.markdown });
    });
  }

  const highlights: string[] = [];
  if (obj.highlights != null) {
    if (!Array.isArray(obj.highlights)) {
      errors.push('highlights must be an array of strings.');
    } else if (obj.highlights.length > 4) {
      errors.push(`highlights must contain at most 4 entries (got ${obj.highlights.length}).`);
    } else {
      obj.highlights.forEach((h, i) => {
        if (typeof h !== 'string') {
          errors.push(`highlights[${i}] must be a string.`);
          return;
        }
        if (h.trim().length === 0) {
          errors.push(`highlights[${i}] must be non-empty.`);
          return;
        }
        if (h.length > 120) {
          errors.push(`highlights[${i}] must be ≤ 120 chars (got ${h.length}).`);
          return;
        }
        highlights.push(h.trim());
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    data: {
      weekStart: obj.weekStart as string,
      weekEnd: obj.weekEnd as string,
      sections,
      highlights,
    },
  };
}
