#!/usr/bin/env node
// Opt-in vendor probe. It saves only a small allowlisted summary, never a transcript.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  model: { type: 'string' },
  'output-dir': { type: 'string' },
  case: { type: 'string' },
} });
if (!values.model || !values['output-dir'] || values.case !== 'native-question') {
  process.stderr.write('Usage: probe-cursor-print.mjs --model <discovered-id> --output-dir <path> --case native-question\n');
  process.exit(1);
}

const bin = process.env.CEZ_CURSOR_BIN || 'agent';
const scratch = mkdtempSync(join(tmpdir(), 'cez-cursor-print-probe-'));
const checkout = join(scratch, 'checkout');
const outputDir = resolve(values['output-dir']);

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', timeout: 15_000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

function runAgent(args, cwd, timeoutMs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(bin, args, { cwd, env: process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const append = (current, chunk) => {
      if (current.length + chunk.length > 1_048_576) { truncated = true; return current; }
      return current + chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const signalGroup = signal => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal); } catch { /* already gone */ }
    };
    const groupAlive = () => {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0); return true; } catch { return false; }
    };
    const timer = setTimeout(() => { timedOut = true; signalGroup('SIGTERM'); }, timeoutMs);
    const escalation = setTimeout(() => signalGroup('SIGKILL'), timeoutMs + 2_000);
    child.on('error', error => { clearTimeout(timer); clearTimeout(escalation); rejectRun(error); });
    child.on('close', async code => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signalGroup('SIGTERM');
      await new Promise(done => setTimeout(done, 500));
      if (groupAlive()) signalGroup('SIGKILL');
      resolveRun({ code, stdout, stderr, truncated, timedOut });
    });
  });
}

let added = false;
let cleaned = true;
try {
  const version = await runAgent(['--version'], process.cwd(), 10_000);
  if (version.code !== 0 || version.timedOut) throw new Error('Cursor version check failed');
  git(['worktree', 'add', '--quiet', '--detach', checkout, 'HEAD']);
  added = true;

  const run = await runAgent([
    '-p', '--force', '--trust', '--output-format', 'stream-json',
    '--model', values.model, '--exclude-tools', 'taskToolCall',
    'Use the native AskQuestion tool now. Ask me to choose Alpha or Beta. Do not answer it yourself and do not use any other tool.',
  ], checkout, 45_000);

  const frames = run.stdout.split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const request = frames.find(frame => frame.type === 'interaction_query' && frame.subtype === 'request' && frame.query_type === 'askQuestionInteractionQuery');
  const response = frames.find(frame => frame.type === 'interaction_query' && frame.subtype === 'response' && frame.query_type === 'askQuestionInteractionQuery');
  const rejection = response?.response?.askQuestionInteractionResponse?.result?.rejected?.reason;
  const summary = {
    schema: 1,
    case: 'native-question',
    cliVersion: version.stdout.trim(),
    model: values.model,
    invocation: ['-p', '--force', '--trust', '--output-format stream-json', '--exclude-tools taskToolCall'],
    exitCode: run.code,
    timedOut: run.timedOut,
    outputTruncated: run.truncated,
    nativeQuestionRequested: Boolean(request),
    nativeQuestionAnswered: Boolean(response),
    responseKind: rejection ? 'rejected' : response ? 'other' : 'none',
    rejectionKind: typeof rejection === 'string' && rejection.includes('skipped') ? 'skipped' : rejection ? 'other' : 'none',
    sameSession: Boolean(request && response && request.session_id === response.session_id),
    responseDelayMs: request && response ? response.timestamp_ms - request.timestamp_ms : null,
    outcome: run.code === 0 && !run.timedOut && !run.truncated && request && response && request.session_id === response.session_id && rejection?.includes('skipped')
      ? 'blocked' : request && response ? 'unqualified' : 'inconclusive',
  };
  mkdirSync(outputDir, { recursive: true });
  const output = join(outputDir, 'print-native-question.json');
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${output}\n`);
  process.exitCode = summary.outcome === 'blocked' ? 2 : 1;
} catch (error) {
  process.stderr.write(`Probe failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
} finally {
  if (added) {
    const removed = spawnSync('git', ['worktree', 'remove', '--force', checkout], { encoding: 'utf8', timeout: 15_000 });
    if (removed.status !== 0) {
      process.stderr.write(`Probe cleanup failed; inspect ${checkout}\n`);
      process.exitCode = 1;
      cleaned = false;
    }
  }
  if (cleaned) rmSync(scratch, { recursive: true, force: true });
}
