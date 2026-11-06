import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { describe, expect, it } from 'vitest';

interface Frame {
  type: string;
  command?: string;
  status?: string;
  agentInvoked?: boolean;
}

async function nativePrompt(prompt: string, gatedFailure: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'omp-dispatch-'));
  const control = join(dir, 'failure.json');
  if (gatedFailure) writeFileSync(control, JSON.stringify({ mode: 'gated-once' }));
  const env = { ...process.env };
  delete env.CEZ_MOCK_FAILURE_CONTROL;
  delete env.CEZ_MOCK_DELIVERY_CONTROL;
  if (gatedFailure) env.CEZ_MOCK_FAILURE_CONTROL = control;
  const child = spawn(process.execPath, [new URL('../../scripts/mock-omp-rpc.mjs', import.meta.url).pathname], {
    cwd: dir,
    env,
    // bound: reap a mock that never admits the prompt and cannot release its failure gate.
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames: Frame[] = [];
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const frame = JSON.parse(line) as Frame;
    frames.push(frame);
    // Admission is the product signal that releases the native failure, never a timer.
    if (gatedFailure && frame.type === 'turn_start') writeFileSync(`${control}.released`, '');
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += String(data); });
  try {
    const closed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    child.stdin.end(`${JSON.stringify({ type: 'prompt', id: 'dispatch', message: prompt })}\n`);
    const code = await closed;
    return { code, stderr, frames: frames.slice(frames.findIndex(frame => frame.type === 'response' && frame.command === 'prompt')) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('OMP shared and native prompt dispatch', () => {
  it.each(['hold', 'hold-gated'])('admits %s before a native approval-denied handler', async token => {
    const result = await nativePrompt(`mock:${token} mock:approval-denied`, false);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.frames.slice(0, 3).map(frame => frame.type)).toEqual(['response', 'agent_start', 'turn_start']);
    expect(result.frames).toContainEqual(expect.objectContaining({ type: 'prompt_result', agentInvoked: true, status: 'completed' }));
  });

  it('admits a shared hold before a provider failure that waits for admission', async () => {
    const result = await nativePrompt('mock:hold mock:provider-error', true);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.frames.slice(0, 3).map(frame => frame.type)).toEqual(['response', 'agent_start', 'turn_start']);
    expect(result.frames).toContainEqual(expect.objectContaining({ type: 'prompt_result', agentInvoked: true, status: 'error' }));
  }, 15_000); // bound: exceeds the child hang guard so a missing admission yields assertions.
});
