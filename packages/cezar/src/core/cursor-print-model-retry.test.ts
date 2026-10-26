import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunSpec } from './agent-runner.ts';
import { CursorPrintRunner } from './cursor-print-runner.ts';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

const mock = fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(mode: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-print-model-retry-')); dirs.push(cwd);
  const log = join(cwd, 'attempts.ndjson');
  const spec: AgentRunSpec = { cwd, toolGrant: UNSET_TOOL_GRANT, model: 'grok-4.6[effort=high,fast=true]', userPrompt: 'first',
    env: { CEZ_MOCK_CURSOR_PRINT_MODE: mode, CEZ_MOCK_CURSOR_PRINT_LOG: log } };
  const runner = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } });
  return { spec, runner, log };
}
const attempts = (log: string): { args: string[]; prompt: string; resumeId?: string; id: string }[] =>
  readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));

describe('Cursor pre-inference model rejection retry', () => {
  it('retries one identical invocation including prepared images and prompt', async () => {
    const { spec, runner, log } = fixture('model-rejection-once');
    spec.systemPrompt = 'Keep the exact selection';
    spec.images = [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }];
    spec.restrictNativeDelegation = true;
    const events: AgentEvent[] = [];
    const result = await runner.run(spec, event => events.push(event));
    expect(result.text).toContain('first');
    expect(events.filter(event => event.type === 'error')).toEqual([]);
    const rows = attempts(log);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.args).toEqual(rows[0]!.args);
    expect(rows[1]!.prompt).toBe(rows[0]!.prompt);
    expect(events.filter(event => event.type === 'session')).toHaveLength(1);
    expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1);
  });

  it('keeps the exact resume and input receipt pending through a rejected attempt', async () => {
    const { spec, runner, log } = fixture('model-rejection-on-resume');
    const events: AgentEvent[] = [];
    let accepted = false;
    const session = runner.startSession(spec, event => {
      events.push(event);
      if (event.type === 'note' && event.message.includes('Retrying')) expect(accepted).toBe(false);
    });
    try {
      await expect.poll(() => events.filter(event => event.type === 'turn-end').length, { timeout: 5000 }).toBe(1);
      const receipt = session.sendAgentMessage([{ type: 'text', text: 'CI observation' }]);
      expect(receipt).not.toBe(false);
      await Promise.resolve(receipt).then(() => { accepted = true; });
      await expect.poll(() => events.filter(event => event.type === 'turn-end').length, { timeout: 5000 }).toBe(2);
      const rows = attempts(log);
      expect(rows).toHaveLength(3);
      expect(rows[1]!.resumeId).toBe(rows[0]!.id);
      expect(rows[2]!.args).toEqual(rows[1]!.args);
      expect(rows[2]!.prompt).toBe(rows[1]!.prompt);
      expect(events.filter(event => event.type === 'error')).toEqual([]);
    } finally { session.end(); await session.result; }
  });

  it('stops after two rejections and preserves the actionable leading error', async () => {
    const { spec, runner, log } = fixture('model-rejection-always');
    const events: AgentEvent[] = [];
    await runner.run(spec, event => events.push(event));
    expect(attempts(log)).toHaveLength(2);
    const errors = events.filter(event => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Cannot use this model: grok-4.6[effort=high,fast=true]');
    expect(errors[0]!.message.length).toBeLessThan(600);
  });

  it('preserves an opening Continue resume id through model admission retry', async () => {
    const { spec, runner, log } = fixture('model-rejection-once');
    spec.sessionId = '3b8f98c5-0148-4f20-a11c-553ce9c52e93';
    spec.resume = true;
    await runner.run(spec);
    const rows = attempts(log);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.resumeId)).toEqual([spec.sessionId, spec.sessionId]);
    expect(rows[1]!.args).toEqual(rows[0]!.args);
  });

  it('honors interruption while the retry note is delivered', async () => {
    const { spec, runner, log } = fixture('model-rejection-once');
    const session = runner.startSession(spec, event => {
      if (event.type === 'note' && event.message.includes('Retrying')) session.interrupt();
    });
    await session.result;
    expect(attempts(log)).toHaveLength(1);
  });

  it.each(['model-rejection-after-init', 'model-rejection-after-work', 'unrelated-startup-error'])
    ('never replays %s', async mode => {
      const { spec, runner, log } = fixture(mode);
      const events: AgentEvent[] = [];
      await runner.run(spec, event => events.push(event));
      expect(attempts(log)).toHaveLength(1);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    });

  it('does not retry a rejected invocation after interruption', async () => {
    const { spec, runner, log } = fixture('model-rejection-held');
    const session = runner.startSession(spec);
    await expect.poll(() => { try { return attempts(log).length; } catch { return 0; } }, { timeout: 5000 }).toBe(1);
    session.interrupt(); await session.result;
    expect(attempts(log)).toHaveLength(1);
  });
});
