import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { ACK_WIRES, ATTENTION_GROUPS, attentionRowKey } from './worker-parent-attention.testkit.ts';

it('classifies every RUNNER_IDS delayed-ACK cell without omissions', () => {
  expect(Object.keys(ACK_WIRES).sort()).toEqual([...RUNNER_IDS].sort());
});
it('registers every attention runner/mode/transport row exactly once', () => {
 const expected = RUNNER_IDS.flatMap(backend => { return [
  ...['fresh', 'continuation'].flatMap(mode => { return ['ordinary', ACK_WIRES[backend]].map(transport => `${backend}:progress:${mode}:${transport}`); }),
  ...['fresh', 'continuation'].map(mode => `${backend}:spawn-ask:${mode}`),
  ...['completion', 'timeout', 'restart', 'human-ask'].map(family => `${backend}:${family}`),
 ]; });
 expect(Object.values(ATTENTION_GROUPS).flat().map(attentionRowKey).sort()).toEqual(expected.sort());
 const calls = readdirSync(new URL('.', import.meta.url)).filter(file => /^worker-parent-attention-.*\.test\.ts$/.test(file))
  .flatMap(file => { return [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/registerAttentionGroup\('([^']+)'\)/g)].map(match => match[1]); });
 expect(calls.sort()).toEqual(Object.keys(ATTENTION_GROUPS).sort());
});
