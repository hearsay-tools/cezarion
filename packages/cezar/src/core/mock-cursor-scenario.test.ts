import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mock = fileURLToPath(new URL('../../scripts/mock-cursor-print.mjs', import.meta.url));
function run(prompt: string, mode = 'normal', failure = false, resumeId?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'cursor-scenario-'));
  try {
    const control = join(cwd, 'failure.json');
    if (failure) writeFileSync(control, JSON.stringify({ mode: 'persistent', opening: 'mock:', failure: 'provider' }));
    const env: NodeJS.ProcessEnv = { ...process.env, CEZ_MOCK_CURSOR_PRINT_MODE: mode };
    delete env.CEZ_MOCK_CI_PR;
    delete env.CEZ_MOCK_FAILURE_CONTROL;
    delete env.CEZ_MOCK_DELIVERY_CONTROL;
    if (failure) env.CEZ_MOCK_FAILURE_CONTROL = control;
    const child = spawnSync(process.execPath, [mock, ...(resumeId ? ['--resume', resumeId] : [])], {
      cwd, input: prompt, encoding: 'utf8', env,
      timeout: 10_000, // bound: kill a broken mock instead of hanging this direct wire probe.
    });
    expect(child.error).toBeUndefined();
    const frames = child.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    return { frames, status: child.status };
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}

describe('Cursor scenario wire and native dispatch', () => {
  it.each(['mock:autonomous', 'mock:hold-cezar-done', 'mock:agent-echo'])('keeps provider failure before %s', prompt => {
    const { frames } = run(prompt, 'normal', true);
    expect(frames.map(frame => frame.type)).toEqual(['system', 'result']);
    expect(frames[1]).toMatchObject({ is_error: true, result: 'ConnectError: [invalid_argument] HTTP 400 Bad Request: invalid_request_error: messages must be non-empty' });
  });
  it.each(['mock:autonomous', 'mock:cezar-done', 'mock:agent-echo'])('keeps after-init modes before %s', prompt => {
    const { frames } = run(prompt, 'no-result');
    expect(frames.map(frame => frame.type)).toEqual(['system']);
  });
  it('keeps native ask rejection before a shared reply', () => {
    const { frames } = run('mock:agent-echo mock:baseline', 'native-question');
    expect(frames.map(frame => frame.type)).toEqual(['system', 'tool_call', 'tool_call', 'assistant', 'result']);
    expect(frames.at(-1).result).toBe('I could not ask the question.');
  });
  it.each([
    ['followup', 'turn 2: followup'],
    ['mock:cezar-done', 'Done.'],
    ['Library: Vitest', 'Done.'],
    ['inspect the working tree', 'Cursor inspected the workspace.'],
  ])('keeps a resumed autonomous-cap origin from overriding %s', (prompt, expected) => {
    const id = run('mock:autonomous-cap').frames[0].session_id;
    expect(run(prompt, 'normal', false, id).frames.at(-1).result).toContain(expected);
  });
  it('keeps an autonomous ask origin from intercepting a Library answer', () => {
    const id = run('mock:autonomous-cezar-ask-cap').frames[0].session_id;
    expect(run('Library: Vitest', 'normal', false, id).frames.at(-1).result).toMatch(/^Done\./);
  });
  it.each([
    ['followup', 'turn 2: followup'],
    ['mock:cezar-done', 'Done.'],
    ['inspect the working tree', 'Cursor inspected the workspace.'],
  ])('keeps a silent-tail origin from overriding %s', (prompt, expected) => {
    const id = run('mock:silent-tail').frames[0].session_id;
    expect(run(prompt, 'normal', false, id).frames.at(-1).result).toContain(expected);
  });
  it('keeps the native resume-done origin unconditional on a resumed turn', () => {
    const id = run('mock:cezar-ask mock:resume-cezar-done').frames[0].session_id;
    expect(run('followup', 'normal', false, id).frames.at(-1).result).toContain('Resumed work finished.');
  });
  it('keeps the native baseline before agent echo', () => {
    const { frames } = run('mock:agent-echo mock:baseline');
    expect(frames.at(-1).result).toBe('Cursor inspected the workspace.');
    expect(frames[1].tool_call.readToolCall.args.path).toBe('README.md');
  });
  it('keeps malformed asks before shared completion', () => {
    expect(run('mock:cezar-done mock:ask-bad').frames.at(-1).result).toBe('Malformed question skipped.');
  });
  it('keeps an untokened reply byte for byte', () => {
    const { frames } = run('Describe the result.');
    expect(frames.map(frame => frame.type)).toEqual(['system', 'assistant', 'result']);
    expect(frames[1].message.content).toEqual([{ type: 'text', text: 'turn 1: Describe the result.' }]);
    expect(frames[2].result).toBe('turn 1: Describe the result.');
  });
  it('keeps the F3 reasoning in the native read result and the nudge silent', () => {
    const { frames } = run('mock:silent-tail-again');
    expect(frames[3].tool_call.readToolCall.result.success.content).toContain('cezar_done');
    expect(frames.some(frame => frame.message?.content?.some((part: { type: string }) => part.type === 'thinking'))).toBe(false);
    const resumed = run('Your turn ended without a wait or done.', 'normal', false, frames[0].session_id).frames;
    expect(resumed.map(frame => frame.type)).toEqual(['system', 'result']);
    expect(resumed[1].result).toBe('');
  });
  it('encodes the shared tool-tail call on the native shell wire', () => {
    const { frames } = run('mock:tool-tail');
    expect(frames[2]).toMatchObject({ type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { args: { command: 'git status --short' } } } });
    expect(frames[3]).toMatchObject({ subtype: 'completed', tool_call: { shellToolCall: { result: { success: { exitCode: 0, stdout: ' M src/example.ts' } } } } });
    expect(frames.at(-1).result).toBe('');
  });
  it('encodes shared read results and reasoning separately from assistant text', () => {
    const { frames } = run('mock:multi-pr-refs');
    expect(frames[1].tool_call.readToolCall.args.path).toBe('other.txt');
    expect(frames[2].tool_call.readToolCall.result.success.content).toContain('other/repo');
    expect(frames[3].message.content[0]).toMatchObject({ type: 'thinking', thinking: expect.stringContaining('other/repo') });
    expect(frames.at(-1).result).toContain('CEZ:PR=812');
  });
  it('uses the shared hold text when hold wins over echo', () => {
    const { frames } = run('mock:hold mock:agent-echo');
    expect(frames.at(-1).result).toBe('parity hold: content after the pause');
  });
  it('keeps the package-pinned Cursor completion text', () => {
    expect(run('mock:cezar-done').frames.at(-1).result).toMatch(/^Done\./);
  });
});
