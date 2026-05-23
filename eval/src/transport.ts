// Eval harness — Anthropic transport wrapper.
//
// Wraps the SDK so the runner can call live OR replay cassettes through the
// same surface. In replay mode the API key is not consulted. In refresh
// mode it must be set.

import Anthropic from '@anthropic-ai/sdk';

export interface CallSpec {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  temperature?: number;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY is required for live calls (EVAL_REFRESH=1). ' +
          'Use cassettes (omit EVAL_REFRESH) for offline runs.',
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export async function callLive(spec: CallSpec): Promise<string> {
  const response = await client().messages.create({
    model: spec.model,
    max_tokens: spec.maxTokens ?? 4000,
    temperature: spec.temperature ?? 0.2,
    system: spec.systemPrompt,
    messages: [{ role: 'user', content: spec.userPrompt }],
  });
  const blocks = response.content.filter(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  return blocks.map((b) => b.text).join('\n');
}
