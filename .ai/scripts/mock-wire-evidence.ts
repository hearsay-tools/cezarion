/** Explicit wire recipes for hearsay-tools/cezarion#2768. No normalized events are injected. */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { RUNNER_IDS, type AgentEvent, type AgentSession, type RunnerId } from '../../packages/cezar/src/core/agent-runner.ts';
import { createRunner } from '../../packages/cezar/src/core/runner-factory.ts';
import { HARNESS_ADAPTERS, PINNED_SESSION_ID, waitFor } from '../../packages/cezar/src/core/harness-parity.testkit.ts';

const output = resolve(process.env.MOCK_WIRE_OUTPUT_DIR!);
const AUTONOMOUS = 'Continue working autonomously until the task is fully complete.';
const FINAL = 'Your turn ended without a wait or done. Give the final message.';
const encoded = Buffer.from(JSON.stringify(['First evidence message.', 'Second evidence message.'])).toString('base64');
const shared = [
  'untokened', 'agent-echo', 'autonomous', 'autonomous-cap', 'autonomous-cezar-ask-cap',
  'cezar-ask', 'cezar-done', 'cezar-tool', 'ci-wait',
  'crash-stderr', 'crash-stderr-single', 'crash-stderr-pre-ack', 'crash-stderr-held-pipe', 'crash-stderr-clean',
  'deferred-turn-start', 'hold', 'hold-cezar-ask', 'hold-cezar-done', 'hold-gated',
  'multi-pr-refs', 'no-progress', 'no-progress-ignore-term', 'no-progress-held-pipe',
  'no-progress-ack-only', 'no-progress-leftover', 'no-progress-input-closed', 'no-progress-gated-ack',
  'silent-tail', 'silent-tail-again', 'silent-tail-ack-delay', 'silent-tail-no-reply',
  'silent-tail-late-reply', 'silent-tail-late-turn-start', 'silent-tail-slow-done',
  'tool-tail', 'turn-messages', 'ack-only', 'busy-progress', 'provider-error',
  'resume-cezar-done', 'steer-tool', 'steer-late', 'subagent-after-park',
] as const;
const gaps: Array<{ runner: RunnerId; scenario: string; reason: string }> = [];
const counts: Partial<Record<RunnerId, number>> = {};

function gap(runner: RunnerId, scenario: string): string | undefined {
  if (runner === 'cursor' && ['ack-only', 'resume-cezar-done', 'steer-tool', 'steer-late', 'subagent-after-park', 'no-progress-input-closed', 'silent-tail-late-turn-start'].includes(scenario)) return 'Cursor print has no persistent input, steering or child wire for this recipe.';
  if (scenario === 'no-progress-gated-ack' && runner !== 'pi' && runner !== 'omp') return 'This baseline wire has no direct mock:gate-prompt-ack gate.';
  if (runner === 'pi' && scenario === 'subagent-after-park') return 'Pi has no child wire for this recipe.';
  if (runner === 'claude' && scenario === 'steer-late') return 'Claude has no direct mock:steer-late token.';
  if (scenario === 'silent-tail-ack-delay' && runner !== 'opencode') return 'f7-delay-ack is an OpenCode HTTP acknowledgement recipe.';
  return undefined;
}

function prompt(scenario: string, runner: RunnerId, park: string): string {
  if (['untokened', 'deferred-turn-start', 'silent-tail-ack-delay'].includes(scenario)) return 'Inspect the working tree.';
  if (scenario === 'no-progress-gated-ack') return 'mock:no-progress mock:gate-prompt-ack';
  if (scenario === 'turn-messages') return `mock:turn-messages:${encoded}`;
  if (scenario === 'resume-cezar-done') return `${runner === 'codex' ? 'mock:native-codex-ask' : runner === 'opencode' ? 'mock:ask' : 'mock:cezar-ask'} mock:resume-cezar-done`;
  if (scenario === 'subagent-after-park') return `mock:subagent-after-park parity-release=${park}`;
  if (scenario === 'provider-error') return runner === 'claude' ? 'mock:auth-error' : 'mock:provider-error';
  if (scenario === 'cezar-tool') return `mock:cezar-tool cezar_done ${Buffer.from('{}').toString('base64')}`;
    return `mock:${scenario}`;
}

const turns = (events: AgentEvent[]) => events.filter(event => event.type === 'turn-end').length;
const failed = (events: AgentEvent[]) => events.some(event => event.type === 'error');

function acknowledged(runner: RunnerId, file: string, offset = 0): boolean {
  return readFileSync(file, 'utf8').slice(offset).trim().split('\n').some(line => {
    if (!line) return false;
    const record = JSON.parse(line) as { channel: string; path?: string; data: string };
    if (runner === 'opencode') return record.channel === 'http-response' && /prompt_async|message/.test(record.path ?? '');
    try {
      const frame = JSON.parse(record.data);
      if (runner === 'claude') return frame.isReplay === true;
      if (runner === 'cursor') return frame.type === 'system' && frame.subtype === 'init';
      if (runner === 'codex') return frame.result?.turn !== undefined;
      return frame.type === 'response' && frame.command === 'prompt';
    } catch { return false; }
  });
}

function stallFramesRecorded(runner: RunnerId, file: string): boolean {
  const wire = readFileSync(file, 'utf8');
  if (runner === 'pi') return acknowledged(runner, file) && wire.includes('turn_start');
  if (runner === 'omp') return acknowledged(runner, file) && wire.includes('message_end');
  return acknowledged(runner, file);
}

function stopFixture(session: AgentSession, scenario: string, cwd: string) {
  const stalledPid = scenario.startsWith('no-progress') && session.open ? session.pid : undefined;
  session.end();
  if (stalledPid) {
    try { process.kill(stalledPid, 'SIGKILL'); } catch { /* already exited */ }
  }
  for (const name of ['leftover-group.pid', 'leftover-session.pid']) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const pid = Number(readFileSync(path, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
}

/** Observe OS exit directly; do not infer it from a runner error or turn-end. */
function observeExits(file: string) {
  const spawn = childProcess.spawn;
  const exits: Array<{ code: number | null; signal: NodeJS.Signals | null }> = [];
  const spy = vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    const options = args[2];
    if (options?.env?.CEZ_MOCK_WIRE_FILE === file) child.once('exit', (code, signal) => {
      exits.push({ code, signal });
    });
    return child;
  });
  syncBuiltinESMExports();
  return { exits, restore() { spy.mockRestore(); syncBuiltinESMExports(); } };
}

async function send(session: AgentSession, text: string) {
  // bound: native startup/previous HTTP acknowledgement must admit this human input.
  await waitFor(() => session.sendMessage([{ type: 'text', text }]), 5_000);
}

async function followTurn(session: AgentSession, events: AgentEvent[], text: string) {
  const before = turns(events);
  await send(session, text);
  // bound: the longest scripted follow-up delays its native start by 800 ms.
  await waitFor(() => turns(events) > before || failed(events), 5_000);
}

async function driveRecipe(scenario: string, runner: RunnerId, session: AgentSession, events: AgentEvent[], activity: () => number, cwd: string, file: string, exits: ReturnType<typeof observeExits>['exits'], asked: () => boolean) {
  if (scenario.startsWith('crash-stderr') && scenario !== 'crash-stderr-clean') {
    // bound: the held-pipe recipe starts its leader exit only after child readiness.
    await waitFor(() => exits.length > 0, 5_000);
    appendFileSync(file, `${JSON.stringify({ channel: 'process-exit', ...exits[0] })}\n`);
    return;
  }
  if (scenario.startsWith('no-progress')) {
    // bound: the fixture publishes its pid after admitting the opening prompt.
    await waitFor(() => existsSync(join(cwd, scenario.endsWith('input-closed') ? 'input-closed.pid' : 'watchdog.pid')), 5_000);
    writeFileSync(join(cwd, 'input-ack.release'), 'release');
    // bound: gated Pi/OMP publish their pid before the native ACK and opening frames.
    await waitFor(() => stallFramesRecorded(runner, file), 5_000);
    return;
  }
  if (scenario === 'ack-only') {
    // bound: wait for this prompt's native ACK/replay, not an arbitrary elapsed duration.
    await waitFor(() => acknowledged(runner, file), 5_000);
    return;
  }
  if (scenario === 'steer-tool' || scenario === 'steer-late') {
    // bound: inject only after the tool starts or the last assistant message arrives.
    await waitFor(() => events.some(event => event.type === (scenario === 'steer-tool' ? 'tool-call' : 'text')), 5_000);
    await send(session, 'Evidence steer.');
  }
  if (scenario === 'resume-cezar-done' && (runner === 'codex' || runner === 'opencode')) {
    // bound: native questions hold their turn open until the human answer.
    await waitFor(() => asked(), 5_000);
    await send(session, 'Library: Vitest');
  }
  // bound: native output proves the opening prompt was handled before releasing gates.
  await waitFor(() => activity() > 0, 5_000);
  writeFileSync(join(cwd, 'release'), 'release');
  writeFileSync(join(cwd, 'release.content'), 'release');
  if (scenario === 'subagent-after-park') {
    // bound: the parent must park before the script releases its child.
    await waitFor(() => turns(events) > 0, 5_000);
    writeFileSync(join(cwd, 'park'), 'release');
    // bound: consume the late child frame before closing its native transport.
    await waitFor(() => /Post-park child update processed|Late child text/.test(readFileSync(file, 'utf8')), 5_000);
  }
  // bound: normal recipe turns include at most the mock's 3-second progress fixture.
  await waitFor(() => turns(events) > 0 || failed(events), 8_000);
  await driveFollowups(scenario, runner, session, events, activity, file);
}

async function driveFollowups(scenario: string, runner: RunnerId, session: AgentSession, events: AgentEvent[], activity: () => number, file: string) {
  if (scenario === 'silent-tail-ack-delay') await followTurn(session, events, 'mock:silent-tail f7-delay-ack');
  if (scenario === 'untokened') await followTurn(session, events, 'Describe the result.');
  if (scenario === 'deferred-turn-start') await followTurn(session, events, 'mock:deferred-turn-start');
  if (scenario.startsWith('autonomous')) await followTurn(session, events, AUTONOMOUS);
  if (scenario === 'resume-cezar-done' && runner !== 'codex' && runner !== 'opencode') await followTurn(session, events, 'Library: Vitest');
  if (scenario.startsWith('silent-tail')) {
    if (scenario === 'silent-tail-no-reply') {
      const offset = readFileSync(file, 'utf8').length;
      await send(session, FINAL);
      // This wire deliberately never emits a turn. Stop after ACK/activity, not a turn-end.
      // bound: no-reply ACK arrives on its native wire; Cursor print has only process startup.
      await waitFor(() => acknowledged(runner, file, offset), 5_000);
    } else await followTurn(session, events, FINAL);
  }
  if (runner === 'opencode' && (scenario === 'autonomous-cap' || scenario === 'silent-tail-ack-delay')) {
    // bound: preserve the delayed HTTP ACK (100/250 ms) after SSE turn-end before teardown.
    await waitFor(() => readFileSync(file, 'utf8').split('\n').filter(line => line.includes('http-response') && line.includes('POST') && (line.includes('/message') || line.includes('/prompt_async'))).length >= (scenario === 'autonomous-cap' ? 2 : 3), 5_000);
  }
}

async function recordRecipe(runner: RunnerId, scenario: string) {
  const adapter = HARNESS_ADAPTERS[runner];
  const dir = join(output, runner);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${scenario}.ndjson`);
  writeFileSync(file, '');
  const cwd = mkdtempSync(join(tmpdir(), 'wire-evidence-'));
  const saved = process.env[adapter.binEnv];
  process.env[adapter.binEnv] = adapter.mockBin;
  const observed = observeExits(file);
  const events: AgentEvent[] = [];
  let activity = 0;
  let asked = false;
  let session: AgentSession | undefined;
  try {
    session = createRunner(runner, runner === 'cursor' ? { sessionTransport: 'cursor-print' } : {}).startSession({
      cwd, userPrompt: prompt(scenario, runner, join(cwd, 'park')), toolGrant: { kind: 'unset' },
      sessionId: PINNED_SESSION_ID, timeoutMs: 0,
      // The real tool transport returns a stable unavailable receipt without a controller.
      cezarTools: { name: 'cezar_ci_evidence', command: process.execPath, args: [new URL('../../packages/cezar/scripts/mock-wire-tools.mjs', import.meta.url).pathname] },
      env: { CEZ_MOCK_WIRE_FILE: file, CEZ_MOCK_NOTES: '0', CEZ_MOCK_RELEASE_FILE: join(cwd, 'release'),
        CEZ_MOCK_STEER_LINES: scenario === 'steer-tool' ? '1' : '0',
        CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_TOOL_SOCKET: '', CEZ_TOOL_TOKEN: '',
        NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE ?? '' },
    }, event => events.push(event), { onActivity: () => { activity += 1; }, onUiEvent: event => { if (event.type === 'ask.requested') asked = true; } });
    const settled = session.result.catch(() => undefined);
    await driveRecipe(scenario, runner, session, events, () => activity, cwd, file, observed.exits, () => asked);
    stopFixture(session, scenario, cwd);
    // bound: end uses a 10-second SIGTERM escalation; evidence must never hang on a fixture.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([settled, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Mock teardown exceeded 12 seconds')), 12_000);
    })]); } finally { clearTimeout(timer); }
    expect(readFileSync(file, 'utf8').length).toBeGreaterThan(0);
    counts[runner] = (counts[runner] ?? 0) + 1;
  } finally {
    if (session) { stopFixture(session, scenario, cwd); session.interrupt(); }
    observed.restore();
    if (saved === undefined) delete process.env[adapter.binEnv]; else process.env[adapter.binEnv] = saved;
    rmSync(cwd, { recursive: true, force: true });
  }
}

for (const runner of RUNNER_IDS) {
  if (process.env.MOCK_WIRE_RUNNER && process.env.MOCK_WIRE_RUNNER !== runner) continue;
  for (const scenario of shared) {
    if (process.env.MOCK_WIRE_SCENARIO && process.env.MOCK_WIRE_SCENARIO !== scenario) continue;
    const reason = gap(runner, scenario);
    if (reason) { gaps.push({ runner, scenario, reason }); continue; }
    // bound: recipe admission, native turn and bounded teardown each have separate guards.
    test(`${runner}/${scenario}`, () => recordRecipe(runner, scenario), 30_000);
  }
}
afterAll(() => {
  writeFileSync(join(output, 'summary.json'), JSON.stringify({ counts, gaps }, null, 2) + '\n');
  console.log(JSON.stringify({ counts, gaps }));
});
