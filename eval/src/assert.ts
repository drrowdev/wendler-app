// Eval harness — custom assertion matchers.
//
// Three matchers cover ~80% of regression cases:
//   - assertResponseShape — required fields, counts, simple property checks
//   - assertElementRules — per-element appearance / non-appearance / field constraints
//   - assertOrdering     — ordering invariants across an array
//
// All matchers return AssertResult shape so the runner can render
// pass/fail with a useful reason on each rule.

export interface AssertResult {
  ok: boolean;
  reason?: string;
  ruleName: string;
}

// ---------- response shape ----------

export interface ResponseShapeRules {
  hasField?: string[];
  fieldEquals?: Record<string, unknown>;
  fieldOneOf?: Record<string, readonly unknown[]>;
  stringFieldMentions?: Record<string, string[]>;
  arrayLengthRange?: Record<string, { min?: number; max?: number }>;
  booleanField?: Record<string, boolean>;
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function assertResponseShape(
  response: unknown,
  rules: ResponseShapeRules,
): AssertResult[] {
  const results: AssertResult[] = [];

  for (const field of rules.hasField ?? []) {
    const value = getPath(response, field);
    results.push({
      ok: value !== undefined && value !== null,
      reason: value === undefined || value === null ? `field '${field}' is missing` : undefined,
      ruleName: `hasField:${field}`,
    });
  }

  for (const [field, expected] of Object.entries(rules.fieldEquals ?? {})) {
    const value = getPath(response, field);
    results.push({
      ok: value === expected,
      reason: value !== expected ? `field '${field}' expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}` : undefined,
      ruleName: `fieldEquals:${field}`,
    });
  }

  for (const [field, allowed] of Object.entries(rules.fieldOneOf ?? {})) {
    const value = getPath(response, field);
    const ok = allowed.includes(value as never);
    results.push({
      ok,
      reason: !ok ? `field '${field}' expected one of [${allowed.join(', ')}], got ${JSON.stringify(value)}` : undefined,
      ruleName: `fieldOneOf:${field}`,
    });
  }

  for (const [field, phrases] of Object.entries(rules.stringFieldMentions ?? {})) {
    const value = getPath(response, field);
    if (typeof value !== 'string') {
      results.push({ ok: false, reason: `field '${field}' is not a string`, ruleName: `stringFieldMentions:${field}` });
      continue;
    }
    const lower = value.toLowerCase();
    const missing = phrases.filter((p) => !lower.includes(p.toLowerCase()));
    results.push({
      ok: missing.length === 0,
      reason: missing.length > 0 ? `field '${field}' missing mentions: [${missing.join(', ')}]` : undefined,
      ruleName: `stringFieldMentions:${field}`,
    });
  }

  for (const [field, range] of Object.entries(rules.arrayLengthRange ?? {})) {
    const value = getPath(response, field);
    if (!Array.isArray(value)) {
      results.push({ ok: false, reason: `field '${field}' is not an array`, ruleName: `arrayLengthRange:${field}` });
      continue;
    }
    const len = value.length;
    const tooLow = range.min !== undefined && len < range.min;
    const tooHigh = range.max !== undefined && len > range.max;
    results.push({
      ok: !tooLow && !tooHigh,
      reason:
        tooLow ? `field '${field}' length ${len} < min ${range.min}` :
        tooHigh ? `field '${field}' length ${len} > max ${range.max}` :
        undefined,
      ruleName: `arrayLengthRange:${field}`,
    });
  }

  for (const [field, expected] of Object.entries(rules.booleanField ?? {})) {
    const value = getPath(response, field);
    const actual = Boolean(value);
    results.push({
      ok: actual === expected,
      reason: actual !== expected ? `field '${field}' expected ${expected}, got ${actual}` : undefined,
      ruleName: `booleanField:${field}`,
    });
  }

  return results;
}

// ---------- element rules ----------

export interface ElementRule {
  /** Where to find the collection in the response (dotted path). */
  collectionPath: string;
  /** Field on each element to match against (dotted path). */
  matchField: string;
  /** Value to match. */
  matchValue: string;
  /** Optional human-readable label for diagnostics. */
  label?: string;
  /** Element must exist. */
  mustAppear?: boolean;
  /** Element must NOT exist. */
  mustNotAppear?: boolean;
  /** When the element exists, this field must be one of these values. */
  fieldOneOf?: { field: string; allowed: readonly string[] };
}

export function assertElementRules(
  response: unknown,
  rules: ElementRule[],
): AssertResult[] {
  const results: AssertResult[] = [];
  for (const rule of rules) {
    const collection = getPath(response, rule.collectionPath);
    if (!Array.isArray(collection)) {
      results.push({
        ok: false,
        reason: `collection '${rule.collectionPath}' is not an array`,
        ruleName: `element:${rule.label ?? rule.matchValue}`,
      });
      continue;
    }
    const match = (collection as unknown[]).find(
      (el) => getPath(el, rule.matchField) === rule.matchValue,
    );
    const label = rule.label ?? `${rule.matchField}=${rule.matchValue}`;

    if (rule.mustAppear === true && !match) {
      results.push({
        ok: false,
        reason: `expected element with ${rule.matchField}=${rule.matchValue} but none found`,
        ruleName: `element:${label}`,
      });
      continue;
    }
    if (rule.mustNotAppear === true && match) {
      results.push({
        ok: false,
        reason: `expected NO element with ${rule.matchField}=${rule.matchValue} but found one`,
        ruleName: `element:${label}`,
      });
      continue;
    }
    if (rule.fieldOneOf && match) {
      const value = getPath(match, rule.fieldOneOf.field);
      const ok = rule.fieldOneOf.allowed.includes(value as string);
      results.push({
        ok,
        reason: !ok
          ? `element ${label}: field '${rule.fieldOneOf.field}' expected one of [${rule.fieldOneOf.allowed.join(', ')}], got ${JSON.stringify(value)}`
          : undefined,
        ruleName: `element:${label}`,
      });
      continue;
    }
    results.push({ ok: true, ruleName: `element:${label}` });
  }
  return results;
}

// ---------- ordering ----------

export type OrderingRule =
  | { type: 'matching-first'; collectionPath: string; matchField: string; matchValues: string[]; label?: string }
  | { type: 'descending-by-field'; collectionPath: string; field: string; label?: string };

export function assertOrdering(
  response: unknown,
  rules: OrderingRule[],
): AssertResult[] {
  const results: AssertResult[] = [];
  for (const rule of rules) {
    const collection = getPath(response, rule.collectionPath);
    if (!Array.isArray(collection)) {
      results.push({
        ok: false,
        reason: `collection '${rule.collectionPath}' is not an array`,
        ruleName: `ordering:${rule.type}`,
      });
      continue;
    }
    if (rule.type === 'matching-first') {
      const items = collection as unknown[];
      const idx = items.findIndex((el) => rule.matchValues.includes(getPath(el, rule.matchField) as string));
      const firstNonMatchIdx = items.findIndex((el) => !rule.matchValues.includes(getPath(el, rule.matchField) as string));
      // Valid if EITHER no matching elements exist OR all matching come before all non-matching.
      let ok = true;
      let reason: string | undefined;
      if (idx === -1) {
        // No matches at all — vacuously true.
      } else {
        // Every matching element index must be < every non-matching element index.
        for (let i = 0; i < items.length; i++) {
          const isMatch = rule.matchValues.includes(getPath(items[i], rule.matchField) as string);
          if (!isMatch) {
            // From this index on, NO matching may appear.
            for (let j = i + 1; j < items.length; j++) {
              if (rule.matchValues.includes(getPath(items[j], rule.matchField) as string)) {
                ok = false;
                reason = `expected all matching elements first, but found non-match at ${i} followed by match at ${j}`;
                break;
              }
            }
            break;
          }
        }
      }
      results.push({ ok, reason, ruleName: `ordering:matching-first:${rule.label ?? rule.matchField}` });
    } else if (rule.type === 'descending-by-field') {
      const items = collection as unknown[];
      let ok = true;
      let reason: string | undefined;
      for (let i = 1; i < items.length; i++) {
        const prev = getPath(items[i - 1], rule.field) as number;
        const curr = getPath(items[i], rule.field) as number;
        if (typeof prev !== 'number' || typeof curr !== 'number') continue;
        if (curr > prev) {
          ok = false;
          reason = `expected descending by '${rule.field}', but item ${i} (${curr}) > item ${i - 1} (${prev})`;
          break;
        }
      }
      results.push({ ok, reason, ruleName: `ordering:descending:${rule.field}` });
    }
  }
  return results;
}
