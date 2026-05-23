// Eval harness — entrypoint.
//
// Walks every fixture under eval/fixtures/<agent>/, looks up the matching
// golden assertions, replays or refreshes the cassette, parses the model
// response, runs assertions, and prints a colored report.
//
// Modes (env-driven):
//   default          replay cassettes; if a fixture has no cassette, ERROR.
//   EVAL_STRICT=1    additionally fail if any cassette's promptHash doesn't
//                    match the current systemPrompt+userPrompt hash.
//   EVAL_REFRESH=1   capture cassettes live from Anthropic (needs API key).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { AGENTS, type AgentName } from './agents.ts';
import { hashPrompt, readCassette, writeCassette, type Cassette } from './cassette.ts';
import { callLive } from './transport.ts';
import {
  assertResponseShape,
  assertElementRules,
  assertOrdering,
  type AssertResult,
  type ResponseShapeRules,
  type ElementRule,
  type OrderingRule,
} from './assert.ts';

// EVAL_ROOT is the eval/ directory (where this file lives at src/run.ts).
const EVAL_ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

interface Fixture {
  name: string;
  description?: string;
  input: {
    userPrompt: string;
    // Allow overrides per fixture if a case needs e.g. higher token budget.
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

interface Golden {
  responseShape?: ResponseShapeRules;
  elementRules?: ElementRule[];
  orderingRules?: OrderingRule[];
  /** Optional: assert the parse step itself succeeds (default: true). */
  expectParse?: 'ok' | 'fail';
}

interface CaseReport {
  agent: AgentName;
  fixture: string;
  results: AssertResult[];
  parseOk: boolean;
  parseErrors?: string[];
  cassetteStatus: 'replayed' | 'refreshed' | 'stale' | 'missing';
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: EVAL_ROOT }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function listFixtures(agent: AgentName): Fixture[] {
  const dir = join(EVAL_ROOT, 'fixtures', agent);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture);
}

function readGolden(agent: AgentName, name: string): Golden {
  const path = join(EVAL_ROOT, 'golden', agent, `${name}.assertions.json`);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as Golden;
}

function cassettePath(agent: AgentName, name: string): string {
  return join(EVAL_ROOT, 'cassettes', agent, `${name}.cassette.json`);
}

async function callOrReplay(
  agent: AgentName,
  fixture: Fixture,
): Promise<{ raw: string; status: CaseReport['cassetteStatus'] }> {
  const def = AGENTS[agent];
  const path = cassettePath(agent, fixture.name);
  const hash = hashPrompt(def.systemPrompt, fixture.input.userPrompt);
  const existing = readCassette(path);

  const refresh = process.env.EVAL_REFRESH === '1';
  const strict = process.env.EVAL_STRICT === '1';

  if (!refresh && existing) {
    if (existing.promptHash !== hash) {
      if (strict) {
        return { raw: existing.rawResponse, status: 'stale' };
      }
      console.warn(`  ⚠ cassette stale (prompt hash drift) — ${fixture.name}`);
    }
    return { raw: existing.rawResponse, status: 'replayed' };
  }

  if (!refresh && !existing) {
    return { raw: '', status: 'missing' };
  }

  // refresh path
  const raw = await callLive({
    model: fixture.input.model ?? def.defaultModel,
    systemPrompt: def.systemPrompt,
    userPrompt: fixture.input.userPrompt,
    maxTokens: fixture.input.maxTokens ?? def.defaultMaxTokens,
    temperature: fixture.input.temperature ?? def.defaultTemperature,
  });
  const cassette: Cassette = {
    modelId: fixture.input.model ?? def.defaultModel,
    promptHash: hash,
    rawResponse: raw,
    capturedAt: new Date().toISOString(),
    capturedFromVersion: gitSha(),
  };
  writeCassette(path, cassette);
  return { raw, status: 'refreshed' };
}

async function runCase(
  agent: AgentName,
  fixture: Fixture,
): Promise<CaseReport> {
  const def = AGENTS[agent];
  const { raw, status } = await callOrReplay(agent, fixture);

  if (status === 'missing') {
    return {
      agent,
      fixture: fixture.name,
      results: [],
      parseOk: false,
      parseErrors: ['No cassette found. Run with EVAL_REFRESH=1 to capture.'],
      cassetteStatus: status,
    };
  }
  if (status === 'stale') {
    return {
      agent,
      fixture: fixture.name,
      results: [],
      parseOk: false,
      parseErrors: ['Cassette is stale (prompt hash drift). EVAL_STRICT=1 mode. Run EVAL_REFRESH=1.'],
      cassetteStatus: status,
    };
  }

  const golden = readGolden(agent, fixture.name);
  const expectParse = golden.expectParse ?? 'ok';
  const parsed = def.parse(raw);

  if (!parsed.ok) {
    if (expectParse === 'fail') {
      return {
        agent,
        fixture: fixture.name,
        results: [{ ok: true, ruleName: 'expectParse:fail' }],
        parseOk: true,
        cassetteStatus: status,
      };
    }
    return {
      agent,
      fixture: fixture.name,
      results: [],
      parseOk: false,
      parseErrors: parsed.errors,
      cassetteStatus: status,
    };
  }

  if (expectParse === 'fail') {
    return {
      agent,
      fixture: fixture.name,
      results: [{ ok: false, ruleName: 'expectParse:fail', reason: 'parse succeeded but golden expected failure' }],
      parseOk: true,
      cassetteStatus: status,
    };
  }

  const results: AssertResult[] = [
    ...(golden.responseShape ? assertResponseShape(parsed.data, golden.responseShape) : []),
    ...(golden.elementRules ? assertElementRules(parsed.data, golden.elementRules) : []),
    ...(golden.orderingRules ? assertOrdering(parsed.data, golden.orderingRules) : []),
  ];

  return {
    agent,
    fixture: fixture.name,
    results,
    parseOk: true,
    cassetteStatus: status,
  };
}

function printCase(report: CaseReport): void {
  const passed = report.results.filter((r) => r.ok).length;
  const failed = report.results.filter((r) => !r.ok);
  const tag = !report.parseOk
    ? '✗ PARSE FAIL'
    : failed.length === 0
      ? '✓'
      : `✗ ${failed.length} fail`;
  const cassetteTag = report.cassetteStatus === 'refreshed' ? ' [refreshed]' : '';
  console.log(`  ${tag.padEnd(14)} ${report.agent}/${report.fixture}${cassetteTag}  (${passed}/${report.results.length} assertions)`);

  if (!report.parseOk && report.parseErrors) {
    for (const err of report.parseErrors) {
      console.log(`      → ${err}`);
    }
  }
  for (const f of failed) {
    console.log(`      ✗ ${f.ruleName}: ${f.reason ?? '(no reason)'}`);
  }
}

async function main(): Promise<void> {
  console.log('Wendler eval harness');
  console.log(`  mode: ${process.env.EVAL_REFRESH === '1' ? 'refresh' : process.env.EVAL_STRICT === '1' ? 'strict' : 'replay'}`);
  console.log('');

  const reports: CaseReport[] = [];
  for (const agentName of Object.keys(AGENTS) as AgentName[]) {
    const fixtures = listFixtures(agentName);
    if (fixtures.length === 0) {
      console.log(`(no fixtures for ${agentName})`);
      continue;
    }
    console.log(`${agentName} (${fixtures.length} cases):`);
    for (const fixture of fixtures) {
      const report = await runCase(agentName, fixture);
      reports.push(report);
      printCase(report);
    }
    console.log('');
  }

  const totalCases = reports.length;
  const passedCases = reports.filter((r) => r.parseOk && r.results.every((x) => x.ok)).length;
  const failedCases = totalCases - passedCases;
  console.log('Summary:');
  console.log(`  cases: ${passedCases}/${totalCases} passed`);
  if (failedCases > 0) {
    console.log(`  ${failedCases} case(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Eval harness error:', err);
  process.exit(2);
});
