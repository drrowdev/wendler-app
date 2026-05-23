// Eval harness — cassette persistence.
//
// A "cassette" is the raw model text returned for a given (prompt, input)
// pair. We cache it on disk so CI runs replay it instead of hitting the
// Anthropic API on every commit. The cache key is sha256 of
// (systemPrompt + userPrompt) — any prompt edit invalidates all
// cassettes that referenced it.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Cassette {
  modelId: string;
  promptHash: string;
  rawResponse: string;
  capturedAt: string;
  capturedFromVersion: string;
}

export function hashPrompt(systemPrompt: string, userPrompt: string): string {
  return createHash('sha256')
    .update(systemPrompt)
    .update('\n---\n')
    .update(userPrompt)
    .digest('hex')
    .slice(0, 16);
}

export function readCassette(path: string): Cassette | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cassette;
  } catch {
    return null;
  }
}

export function writeCassette(path: string, cassette: Cassette): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cassette, null, 2) + '\n', 'utf8');
}
