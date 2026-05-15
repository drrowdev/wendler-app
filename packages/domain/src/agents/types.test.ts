import { describe, expect, it } from 'vitest';
import {
  agentError,
  agentSuccess,
  type AgentErrorCode,
  type AgentResponse,
} from './types';

describe('agentSuccess / agentError', () => {
  it('constructs a success response with required fields only', () => {
    const r = agentSuccess({ value: 42 });
    expect(r).toEqual({ ok: true, data: { value: 42 } });
  });

  it('attaches optional metadata when provided', () => {
    const r = agentSuccess(
      { value: 'foo' },
      {
        rawResponse: '{"value":"foo"}',
        usage: { inputTokens: 100, outputTokens: 20, latencyMs: 1234 },
        warnings: [{ code: 'retry', message: 'recovered after one retry' }],
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('narrowing');
    expect(r.rawResponse).toBe('{"value":"foo"}');
    expect(r.usage?.inputTokens).toBe(100);
    expect(r.warnings).toHaveLength(1);
  });

  it('omits undefined-valued optional fields entirely', () => {
    const r = agentSuccess('payload');
    expect('rawResponse' in r).toBe(false);
    expect('usage' in r).toBe(false);
    expect('warnings' in r).toBe(false);
  });

  it('constructs an error response with the given code + messages', () => {
    const r = agentError('validation-failed', ['missing field foo', 'invalid bar']);
    expect(r).toEqual({
      ok: false,
      errorCode: 'validation-failed',
      errors: ['missing field foo', 'invalid bar'],
    });
  });

  it('back-fills a default message if an empty errors array is passed', () => {
    const r = agentError('llm-timeout', []);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('narrowing');
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain('llm-timeout');
  });

  it('error response carries raw text + usage when provided', () => {
    const r = agentError('validation-failed', ['bad json'], {
      rawResponse: '{ this is not json',
      usage: { inputTokens: 50, outputTokens: 5, latencyMs: 100 },
    });
    if (r.ok) throw new Error('narrowing');
    expect(r.rawResponse).toBe('{ this is not json');
    expect(r.usage?.outputTokens).toBe(5);
  });
});

describe('AgentResponse discriminated-union narrowing', () => {
  function process<T>(r: AgentResponse<T>): string {
    if (r.ok) {
      // Inside this branch, r.data is typed as T (no `?`).
      return `success:${String(r.data)}`;
    } else {
      // Inside this branch, r.errors is required.
      return `error:${r.errorCode}:${r.errors.join('|')}`;
    }
  }

  it('discriminates on ok', () => {
    expect(process(agentSuccess('a'))).toBe('success:a');
    expect(process(agentError('rate-limited', ['429']))).toBe('error:rate-limited:429');
  });
});

describe('AgentErrorCode coverage', () => {
  // This lives at the type level. The test exists so a new AgentErrorCode
  // value added without a matching case here would surface as a typecheck
  // failure on the exhaustive switch.
  it('exhaustively covers every documented code', () => {
    const codes: AgentErrorCode[] = [
      'validation-failed',
      'llm-unreachable',
      'llm-timeout',
      'llm-refused',
      'rate-limited',
      'bad-input',
      'unknown',
    ];
    for (const code of codes) {
      const r = agentError(code, ['x']);
      // Exhaustive switch — TS will error if a new code is added without a case.
      // The body is just a smoke check; the value is the typecheck itself.
      const label = ((): string => {
        switch (code) {
          case 'validation-failed':
            return 'val';
          case 'llm-unreachable':
            return 'net';
          case 'llm-timeout':
            return 'timeout';
          case 'llm-refused':
            return 'refuse';
          case 'rate-limited':
            return 'rate';
          case 'bad-input':
            return 'input';
          case 'unknown':
            return 'unk';
          default: {
            const _exhaustive: never = code;
            return _exhaustive;
          }
        }
      })();
      expect(label.length).toBeGreaterThan(0);
      expect(r.errorCode).toBe(code);
    }
  });
});
