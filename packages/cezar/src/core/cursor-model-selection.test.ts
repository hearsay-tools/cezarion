import { spawn } from 'node:child_process';
import { buildChildEnv } from './agent-env.ts';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { discoverCursorModels } from './cursor-model-catalog.ts';
import { CursorRunner } from './cursor-runner.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// Native shapes from Cursor 2026.10.01-e373342. Grok's print alias has a different
// prefix; canonical IDs and parameter keys come from ACP, not suffix guessing.
const catalog = [
  { value: 'grok-4.6', name: 'Grok 4.6', configOptions: [
    { id: 'effort', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'fast', type: 'select', currentValue: 'true', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'Fast' }] },
  ] },
  { value: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', configOptions: [
    { id: 'reasoning', type: 'select', currentValue: 'medium', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
  ] },
  { value: 'auto-smart', name: 'Auto', configOptions: [] },
  { value: 'opaque[context=1m,effort=low]', name: 'Opaque', configOptions: [
    { id: 'effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
    { id: 'context', type: 'select', currentValue: '200k', options: [{ value: '200k', name: '200k' }, { value: '1m', name: '1M' }] },
  ] },
  { value: 'opaque[context=1m]', name: 'Opaque fixed context', configOptions: [
    { id: 'effort', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  ] },
];
function fixture(rows = catalog) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-cursor-model-selection-')); dirs.push(cwd);
  const bin = join(cwd, 'agent');
  const log = join(cwd, 'turns.ndjson');
  const printMock = fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url));
  writeFileSync(bin, String.raw`#!/usr/bin/env node
// Like both qualified builds, accept the hidden auto-update option ahead of the command.
const a = process.argv.slice(2).filter(arg => arg !== '--disable-auto-update');
if (a[0] === 'acp') {
  const { createInterface } = await import('node:readline');
  createInterface({ input: process.stdin }).on('line', line => {
    const r = JSON.parse(line);
    const result = r.method === 'initialize' ? { protocolVersion: 1 } :
      { models: process.env.CEZ_TEST_ACCOUNT === 'scoped' ? ${JSON.stringify(rows)} : [] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\n');
  });
} else if (a[0] === '--list-models') {
  console.log('Available models\nauto - Auto (default)\ncursor-grok-4.6-high - Grok 4.6\ngpt-5.4-mini-high - GPT-5.4 Mini High');
} else { await import(${JSON.stringify(pathToFileURL(printMock).href)}); }
`);
  chmodSync(bin, 0o700);
  const env = { CEZ_TEST_ACCOUNT: 'scoped', CEZ_MOCK_CURSOR_PRINT_LOG: log };
  return { cwd, bin, log, env };
}
const turns = (path: string): { args: string[]; id: string; resumeId?: string }[] =>
  readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));

// The regressions must fail if fresh-session admission still checks only the
// legacy print listing, or if print does not receive the complete native selection.
describe('Cursor discovered models through print admission', () => {
  it.each([
    { model: 'grok-4.6', effort: 'high' as const, native: 'grok-4.6[effort=high,fast=true]' },
    { model: 'gpt-5.4-mini', effort: 'high' as const, native: 'gpt-5.4-mini[reasoning=high]' },
    { model: 'auto-smart', effort: undefined, native: 'auto-smart' },
    { model: 'opaque[context=1m,effort=low]', effort: 'high' as const, native: 'opaque[context=1m,effort=high]' },
    { model: 'opaque[context=1m]', effort: 'high' as const, native: 'opaque[context=1m,effort=high]' },
  ])('launches discovered $model with its native parameter selection', async ({ model, effort, native }) => {
    const f = fixture();
    const discovered = await discoverCursorModels({ cwd: f.cwd, bin: f.bin,
      spawn: (bin, args, cwd) => {
        // Discovery is scoped to the same account as admission.
        return spawn(bin, [...args], { cwd, env: buildChildEnv({ backend: 'cursor', extraEnv: f.env }) });
      },
    });
    expect(discovered.some(option => option.id === model)).toBe(true);
    const events: AgentEvent[] = [];
    const result = await new CursorRunner({ bin: f.bin }).run({ toolGrant: UNSET_TOOL_GRANT,
      cwd: f.cwd, userPrompt: 'first', model, effort, env: f.env,
    }, event => events.push(event));
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    expect(result.text).toContain('first');
    const first = turns(f.log)[0]!;
    expect(first.args[first.args.indexOf('--model') + 1]).toBe(native);
    expect(events).toContainEqual(expect.objectContaining({ type: 'session', sessionTransport: 'cursor-print' }));
  });

  it('keeps the native model selection on follow-up and exact print Continue', async () => {
    const f = fixture();
    const spec = { cwd: f.cwd, userPrompt: 'first', toolGrant: UNSET_TOOL_GRANT, model: 'grok-4.6', effort: 'high' as const, env: f.env };
    const events: AgentEvent[] = [];
    const session = new CursorRunner({ bin: f.bin }).startSession(spec, event => events.push(event));
    try {
      await expect.poll(() => events.filter(event => event.type === 'turn-end').length, { timeout: 10_000 }).toBe(1);
      expect(session.sendMessage([{ type: 'text', text: 'followup' }])).toBe(true);
      await expect.poll(() => events.filter(event => event.type === 'turn-end').length, { timeout: 10_000 }).toBe(2);
    } finally { session.end(); await session.result; }
    const id = turns(f.log)[0]!.id;
    const result = await new CursorRunner({ bin: f.bin, sessionTransport: 'cursor-print' }).run({
      ...spec, userPrompt: 'continue', resume: true, sessionId: id,
    });
    expect(result.sessionId).toBe(id);
    const recorded = turns(f.log);
    expect(recorded).toHaveLength(3);
    for (const turn of recorded) expect(turn.args[turn.args.indexOf('--model') + 1]).toBe('grok-4.6[effort=high,fast=true]');
    expect(recorded.slice(1).map(turn => turn.resumeId)).toEqual([id, id]);
  }, 20_000);

  it('rejects incomplete native defaults before inference', async () => {
    const f = fixture([{ ...catalog[0]!, configOptions: [
      catalog[0]!.configOptions[0]!, { ...catalog[0]!.configOptions[1]!, currentValue: 'unlisted' },
    ] }]);
    const events: AgentEvent[] = [];
    await new CursorRunner({ bin: f.bin }).run({ toolGrant: UNSET_TOOL_GRANT, cwd: f.cwd, userPrompt: 'unused', model: 'grok-4.6',
      effort: 'high', env: f.env }, event => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('verify') }));
    expect(existsSync(f.log)).toBe(false);
  });

  it.each(['opaque[context=1m][fast=true]', 'opaque[context=1m,context=200k]',
    'opaque[context=]', 'opaque[context=unlisted]'])('rejects unverifiable embedded parameters: %s', async model => {
    const f = fixture([{ ...catalog[3]!, value: model }]);
    const events: AgentEvent[] = [];
    await new CursorRunner({ bin: f.bin }).run({ toolGrant: UNSET_TOOL_GRANT, cwd: f.cwd, userPrompt: 'unused', model,
      effort: 'high', env: f.env }, event => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringContaining('verify') }));
    expect(existsSync(f.log)).toBe(false);
  });

  it.each([
    { model: 'unknown', effort: undefined, account: 'scoped' },
    { model: 'grok-4.6', effort: 'max' as const, account: 'scoped' },
    { model: 'auto-smart', effort: 'high' as const, account: 'scoped' },
    { model: 'grok-4.6', effort: 'high' as const, account: 'other' },
  ])('rejects an unadvertised selection before inference: $model/$effort/$account', async ({ model, effort, account }) => {
    const f = fixture(); const events: AgentEvent[] = [];
    await new CursorRunner({ bin: f.bin }).run({ toolGrant: UNSET_TOOL_GRANT, cwd: f.cwd, userPrompt: 'unused', model, effort,
      env: { ...f.env, CEZ_TEST_ACCOUNT: account } }, event => events.push(event));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', message: expect.stringMatching(/advertis|verify/) }));
    expect(existsSync(f.log)).toBe(false);
  });
});
