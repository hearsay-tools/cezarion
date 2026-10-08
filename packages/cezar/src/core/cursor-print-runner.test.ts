import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentRunSpec } from './agent-runner.ts';
import { CursorPrintRunner } from './cursor-print-runner.ts';

const mock = fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url));
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture(mode = 'normal'): { spec: AgentRunSpec; log: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-print-runner-test-'));
  scratch.push(cwd);
  const log = join(cwd, 'turns.jsonl');
  return { log, spec: {
    cwd, userPrompt: 'initial', model: 'gpt-5.4-mini-medium',
    env: { CEZ_MOCK_CURSOR_PRINT_LOG: log, CEZ_MOCK_CURSOR_PRINT_MODE: mode },
  } };
}

const logs = (path: string): { pid: number; id: string; resumeId?: string; args: string[] }[] =>
  readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const turnEnds = (events: AgentEvent[]) => events.filter(event => event.type === 'turn-end').length;

describe('Cursor print logical session', () => {
  it('keeps one native ID across two owned processes and settles only after explicit end', async () => {
    const { spec, log } = fixture();
    const events: AgentEvent[] = [];
    const pids: number[] = [];
    const runner = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } });
    const session = runner.startSession(spec, event => events.push(event), {
      onPidChange: pid => pids.push(pid),
    });
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    expect(session.open).toBe(true);
    let settled = false;
    void session.result.then(() => { settled = true; });
    expect(settled).toBe(false);
    expect(session.sendMessage([{ type: 'text', text: 'followup' }])).toBe(true);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(2);
    const turns = logs(log);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.resumeId).toBe(turns[0]?.id);
    expect(turns[1]?.args).toContain('--resume');
    expect(new Set(turns.map(turn => turn.pid)).size).toBe(2);
    expect(pids).toEqual([turns[1]?.pid]);
    expect(events.filter(event => event.type === 'session')).toHaveLength(1);
    session.end();
    const result = await session.result;
    expect(result.sessionId).toBe(turns[0]?.id);
    expect(result.text).toContain('turn 2: followup');
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('fails a resumed turn that reports a different native ID', async () => {
    const { spec } = fixture('mismatch-on-resume');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event));
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    session.sendMessage([{ type: 'text', text: 'followup' }]);
    await session.result;
    expect(events.some(event => event.type === 'error' && /session id/i.test(event.message))).toBe(true);
    expect(events.filter(event => event.type === 'session')).toHaveLength(1);
  });

  it('uses a recorded native ID for a separate Continue session', async () => {
    const { spec, log } = fixture();
    const first = await new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } }).run(spec);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/i);
    const resumed = await new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .run({ ...spec, resume: true, sessionId: first.sessionId, userPrompt: 'continue' });
    expect(resumed.sessionId).toBe(first.sessionId);
    expect(logs(log)[1]?.resumeId).toBe(first.sessionId);
  });

  it('rejects an invalid resume ID before launching a print process', async () => {
    const { spec, log } = fixture();
    const events: AgentEvent[] = [];
    await new CursorPrintRunner({ bin: mock }).run({ ...spec, resume: true,
      sessionId: 'not-a-recorded-native-id',
    }, event => events.push(event));
    expect(events.some(event => event.type === 'error' && /session id/i.test(event.message))).toBe(true);
    expect(() => readFileSync(log)).toThrow();
  });

  it('fails a clean process exit without a native result frame', async () => {
    const { spec } = fixture('no-result');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event));
    await session.result;
    expect(turnEnds(events)).toBe(0);
    expect(events.some(event => event.type === 'error' && /result/i.test(event.message))).toBe(true);
  });

  it('waits for process exit before it emits the v1 turn boundary', async () => {
    const { spec } = fixture('result-before-exit');
    const events: AgentEvent[] = [];
    const ui: string[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), { onUiEvent: event => ui.push(event.type) });
    await expect.poll(() => ui.includes('turn.completed'), { timeout: 3_000 }).toBe(true);
    expect(turnEnds(events)).toBe(0);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    session.end();
    await session.result;
  });

  it('preserves a successful turn boundary when end arrives after its result frame', async () => {
    const { spec } = fixture('result-before-exit');
    const events: AgentEvent[] = [];
    let session: ReturnType<CursorPrintRunner['startSession']>;
    session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), {
        onUiEvent: event => { if (event.type === 'turn.completed') session.end(); },
      });
    await session.result;
    expect(turnEnds(events)).toBe(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('interrupts a process before its opening init without reviving the session', async () => {
    const { spec } = fixture('delay-init');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20, killGraceMs: 50 } })
      .startSession(spec, event => events.push(event));
    session.interrupt();
    await session.result;
    expect(session.open).toBe(false);
    expect(turnEnds(events)).toBe(0);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('allows Cancel to escalate a prior graceful end', async () => {
    const { spec } = fixture('delay-init');
    const session = new CursorPrintRunner({ bin: mock,
      processOptions: { drainMs: 20, termGraceMs: 5_000, killGraceMs: 50 },
    }).startSession(spec);
    const started = Date.now();
    session.end();
    session.interrupt();
    await session.result;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('ignores frames after the native result', async () => {
    const { spec } = fixture('late-frame');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), { autoEndAfterFirstTurn: true });
    const result = await session.result;
    expect(result.text).not.toContain('LATE_FRAME');
    expect(events.filter(event => event.type === 'text' && event.text.includes('LATE_FRAME'))).toEqual([]);
    expect(turnEnds(events)).toBe(1);
  });

  it('does not replay a prompt after a provider error that may have been admitted', async () => {
    const { spec, log } = fixture('provider-error');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event));
    await session.result;
    expect(logs(log)).toHaveLength(1);
    expect(events.some(event => event.type === 'error' && /provider unavailable/i.test(event.message))).toBe(true);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('fails after model work without a result, without replaying possible side effects', async () => {
    const { spec, log } = fixture('crash-after-work');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event));
    await session.result;
    expect(logs(log)).toHaveLength(1);
    expect(turnEnds(events)).toBe(0);
    expect(events.some(event => event.type === 'error' && /result frame/i.test(event.message))).toBe(true);
  });

  it('emits one turn boundary for duplicate terminal frames', async () => {
    const { spec } = fixture('duplicate-result');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), { autoEndAfterFirstTurn: true });
    await session.result;
    expect(turnEnds(events)).toBe(1);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('enforces one logical deadline across the opening process', async () => {
    const { spec } = fixture('delay-init');
    spec.timeoutMs = 30;
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20, killGraceMs: 50 } })
      .startSession(spec, event => events.push(event));
    await session.result;
    expect(events.some(event => event.type === 'error' && /timed out/i.test(event.message))).toBe(true);
    expect(session.open).toBe(false);
  });

  it('ends an open turn after a bounded period without native activity', async () => {
    const { spec } = fixture('delay-init');
    spec.timeoutMs = 0;
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock,
      noProgressTimeoutMs: 40, processOptions: { drainMs: 20, killGraceMs: 50 },
    }).startSession(spec, event => events.push(event));
    await expect.poll(() => events.some(event => event.type === 'done'), { timeout: 2_000 }).toBe(true);
    expect(events.some(event => event.type === 'error' && /no progress/i.test(event.message))).toBe(true);
    await session.result;
  });

  it('parks a trailing CEZ:ASK until explicit human input and drops premature follow-ups', async () => {
    const { spec, log } = fixture('portable-ask');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), { autoEndAfterFirstTurn: true });
    expect(session.sendMessage([{ type: 'text', text: 'premature' }])).toBe(true);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(session.open).toBe(true);
    expect(session.heldHumanInputCount?.()).toBe(0);
    expect(session.sendAgentMessage([{ type: 'text', text: 'worker cannot answer' }])).toBe(false);
    expect(logs(log)).toHaveLength(1);
    expect(session.sendMessage([{ type: 'text', text: 'Library: Vitest' }])).toBe(true);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(2);
    expect(logs(log)).toHaveLength(2);
    expect(logs(log)[1]?.resumeId).toBe(logs(log)[0]?.id);
    expect(logs(log)[1]?.args.at(-1)).toContain('Library: Vitest');
    session.end();
    await session.result;
  });

  it.each(['Library: Vitest', 'I prefer a different library', 'Library: decline'])(
    'sends the human reply %s as its own exact-resume turn', async reply => {
      const { spec, log } = fixture('portable-ask');
      const events: AgentEvent[] = [];
      const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
        .startSession(spec, event => events.push(event));
      await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
      session.sendMessage([{ type: 'text', text: reply }]);
      await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(2);
      session.end();
      await session.result;
      expect(logs(log)[1]?.resumeId).toBe(logs(log)[0]?.id);
      expect(logs(log)[1]?.args.at(-1)).toContain(reply);
    },
  );

  it('refuses busy worker input and admits it only after model output on a new turn', async () => {
    const { spec, log } = fixture('delay-work');
    const events: AgentEvent[] = [];
    const consumed: string[][] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event), { onAgentInputConsumed: ids => consumed.push([...ids]) });
    expect(session.sendAgentMessage([{ type: 'text', text: 'busy' }], ['busy-id'])).toBe(false);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    const delivery = session.sendAgentMessage([{ type: 'text', text: 'worker follow-up' }], ['worker-id']);
    expect(delivery).not.toBe(false);
    let admitted = false;
    void (delivery as Promise<void>).then(() => { admitted = true; });
    await expect.poll(() => logs(log).length, { timeout: 3_000 }).toBe(2);
    expect(admitted).toBe(false);
    await delivery;
    expect(admitted).toBe(true);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(2);
    expect(consumed).toEqual([]);
    session.end();
    await session.result;
  });

  it('counts and discards queued human messages without opening new turns', async () => {
    const { spec, log } = fixture('result-before-exit');
    const events: AgentEvent[] = [];
    const session = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 } })
      .startSession(spec, event => events.push(event));
    session.sendMessage([{ type: 'text', text: 'one' }]);
    session.sendMessage([{ type: 'text', text: 'two' }]);
    expect(session.holdsHumanInput()).toBe(true);
    expect(session.heldHumanInputCount?.()).toBe(2);
    session.discardQueuedMessages();
    expect(session.heldHumanInputCount?.()).toBe(0);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    expect(logs(log)).toHaveLength(1);
    session.end();
    await session.result;
  });

  it('passes qualified delegation, MCP, image, root and advertised effort fields on each turn', async () => {
    const { spec, log } = fixture();
    const extraRoot = mkdtempSync(join(tmpdir(), 'cez-print-extra-root-'));
    scratch.push(extraRoot);
    const syntheticToken = 'synthetic-tool-token-590';
    spec.restrictNativeDelegation = true;
    spec.cezarTools = { name: 'cezar', command: 'node', args: ['/safe/mock-mcp.mjs'] };
    spec.env = { ...spec.env, CEZ_TOOL_TOKEN: syntheticToken, CEZ_TOOL_SOCKET: '/tmp/synthetic-tool-socket' };
    spec.additionalDirectories = [extraRoot];
    spec.effort = 'low';
    spec.images = [{ type: 'image', source: { type: 'base64', media_type: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/R1cAAAAASUVORK5CYII=',
    } }];
    let descriptor = '';
    const events: AgentEvent[] = [];
    const runner = new CursorPrintRunner({ bin: mock, processOptions: { drainMs: 20 }, models: [
      { id: 'gpt-5.4-mini-medium', label: 'Mini Medium', description: '' },
      { id: 'gpt-5.4-mini-low', label: 'Mini Low', description: '' },
    ] });
    const session = runner.startSession(spec, event => events.push(event), {
      onUiEvent: event => {
        if (event.type !== 'session.started') return;
        const args = logs(log)[0]?.args ?? [];
        const pluginDir = args[args.indexOf('--plugin-dir') + 1];
        if (pluginDir && existsSync(join(pluginDir, 'mcp.json'))) {
          descriptor = readFileSync(join(pluginDir, 'mcp.json'), 'utf8');
        }
      },
    });
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(1);
    session.sendMessage([{ type: 'text', text: 'followup' }]);
    await expect.poll(() => turnEnds(events), { timeout: 3_000 }).toBe(2);
    session.end();
    await session.result;
    const turns = logs(log);
    expect(turns).toHaveLength(2);
    for (const turn of turns) {
      expect(turn.args).toContain('--add-dir');
      expect(turn.args[turn.args.indexOf('--add-dir') + 1]).toBe(extraRoot);
      expect(turn.args[turn.args.indexOf('--model') + 1]).toBe('gpt-5.4-mini-low');
      const allowed = turn.args[turn.args.indexOf('--allowed-tools') + 1] ?? '';
      expect(allowed).toContain('read_tool_call');
      expect(allowed).not.toContain('task_tool_call');
      expect(allowed).not.toContain('create_agent_tool_call');
      expect(turn.args).toContain('--plugin-dir');
      expect(JSON.stringify(turn.args)).not.toContain(syntheticToken);
    }
    expect(turns[0]?.args).toContain('--image');
    expect(turns[1]?.args).not.toContain('--image');
    expect(descriptor).toContain('${CEZ_TOOL_TOKEN}');
    expect(descriptor).toContain('${CEZ_TOOL_SOCKET}');
    expect(descriptor).not.toContain(syntheticToken);
    const pluginDir = turns[0]?.args[(turns[0]?.args.indexOf('--plugin-dir') ?? -1) + 1];
    const imagePath = turns[0]?.args[(turns[0]?.args.indexOf('--image') ?? -1) + 1];
    expect(existsSync(pluginDir!)).toBe(false);
    expect(existsSync(imagePath!)).toBe(false);
  });

  it('rejects unknown model and effort pins before the first process', async () => {
    const { spec, log } = fixture();
    const models = [{ id: 'gpt-5.4-mini-medium', label: 'Mini Medium', description: '' }];
    const missingModel: AgentEvent[] = [];
    await new CursorPrintRunner({ bin: mock, models }).run({ ...spec, model: 'unknown-model' },
      event => missingModel.push(event));
    expect(missingModel.some(event => event.type === 'error' && /model/i.test(event.message))).toBe(true);
    const missingEffort: AgentEvent[] = [];
    await new CursorPrintRunner({ bin: mock, models }).run({ ...spec, effort: 'low' },
      event => missingEffort.push(event));
    expect(missingEffort.some(event => event.type === 'error' && /effort/i.test(event.message))).toBe(true);
    expect(existsSync(log)).toBe(false);
  });
});
