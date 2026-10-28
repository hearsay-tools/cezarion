// CI-only entry point. Python owns namespaces, pidfds, process lifetime and deletion.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { auditSignal, parseRequest, verdict, WIRE_LIMIT } from './linux-reaper-protocol.mjs';
import { assertFixtureEvidence, assertProcess, guard, processState } from './linux-reaper-native-guard.mjs';

const started = performance.now();
let request;
const signals = [];
let finished = false;
let timedOut = false;
function finish(value, exitCode) {
  if (finished) return;
  finished = true;
  const result = { version: 1, case: request?.case, action: request?.action, resourceKind: request?.resourceKind,
    allowDelete: false, elapsedMs: Math.round(performance.now() - started), ...value };
  const line = JSON.stringify(result);
  assert(Buffer.byteLength(line) < WIRE_LIMIT, 'result exceeds byte limit');
  process.stdout.write(line + '\n', () => { process.exitCode = exitCode; });
}
const deadline = setTimeout(() => {
  timedOut = true;
  finish({ status: 'failed', code: 'driver-timeout', error: 'native driver exceeded 12 seconds' }, 1);
  // No signal or fixture deletion. Namespace init owns teardown on EOF/error.
  process.stdin.destroy();
}, 12_000);

async function input() {
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('request timed out')), 5_000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      assert(bytes <= WIRE_LIMIT, 'request exceeds byte limit');
      chunks.push(chunk);
    }
    return parseRequest(Buffer.concat(chunks).toString('utf8'));
  } finally { clearTimeout(timer); }
}

async function checkpoint(request, assertCurrent) {
  // These stable exports exist at the proof base. New alias modules are loaded
  // by the candidate reaper itself; a baseline stop cannot fail on their absence.
  const { readPrivateWorkerFile, replacePrivateWorkerFile } = await import('../../packages/cezar/src/runs/private-worker-file.ts');
  const { workerExecutionSchema } = await import('../../packages/cezar/src/runs/worker-execution.ts');
  const path = `${request.fixtureRoot}/execution.json`;
  if (!existsSync(path)) {
    assert(!['retain', 'release'].includes(request.action), 'restart checkpoint is missing');
    replacePrivateWorkerFile(path, JSON.stringify({ generation: request.generation, phase: 'complete' }), true);
  }
  const read = () => {
    const value = workerExecutionSchema.parse(JSON.parse(readPrivateWorkerFile(path, 16384)));
    assert.equal(value.generation, request.generation, 'checkpoint generation changed');
    assert.equal(value.phase, 'complete');
    if (value.aliasRetention) assert.equal(value.aliasRetention.resourceId, request.resourceId);
    return value;
  };
  const retained = () => {
    const proof = read();
    return !!proof.aliasRetention?.processes.some(item =>
      item.pid === request.target.pid && `${proof.aliasRetention.bootId}:${item.start}` === request.target.startToken);
  };
  read();
  if (['retain', 'release'].includes(request.action)) assert(retained(), 'restart lost target retention');
  if (request.action === 'seed') assert(!read().aliasRetention, 'seed must start without retained evidence');
  return { retained, adapter: {
    resourceId: request.resourceId, read,
    write(value) {
      assertCurrent();
      const { aliasRetention: _old, ...proof } = read();
      const next = workerExecutionSchema.parse({ ...proof, ...(value ? { aliasRetention: value } : {}) });
      assert(Buffer.byteLength(JSON.stringify(next)) <= 16384);
      replacePrivateWorkerFile(path, JSON.stringify(next));
      assertCurrent();
    },
  } };
}

async function observe(request) {
  const { AliasWorkBudget } = await import('../../packages/cezar/src/delegation/linux-alias-model.ts');
  const { prepareAliasScan, scanAliases, verifyAliasScan } = await import('../../packages/cezar/src/delegation/linux-alias-scan.ts');
  const { mappedHolder } = await import('../../packages/cezar/src/delegation/linux-mapped-holders.ts');
  const budget = new AliasWorkBudget();
  const attempt = prepareAliasScan([request.resourceRoot], budget);
  const oldMapped = mappedHolder(request.target.pid, [request.resourceRoot], budget);
  const result = scanAliases(request.target.pid, request.target.startToken, attempt);
  verifyAliasScan(attempt);
  assert.equal(result.outcome, 'held', 'current alias scan did not identify fixture');
  return { oldMapped, current: result.outcome, scoped: !!result.scoped };
}

async function run() {
  request = await input();
  const currentFixture = guard(request);
  const assertCurrent = () => {
    assert(!timedOut, 'native driver deadline expired');
    currentFixture();
  };
  const evidence = assertFixtureEvidence(request);
  const state = await checkpoint(request, assertCurrent);
  const kill = process.kill;
  let error, observation;
  // This audit forwards every permitted signal to the real OS. It is a last
  // fixture guard, not namespace isolation and not a replacement reaper.
  process.kill = (pid, signal) => auditSignal(request, signals, pid, signal,
    () => { assertCurrent(); assertProcess(request.target); }, (target, name) => kill.call(process, target, name));
  try {
    if (request.action === 'observe') observation = await observe(request);
    else {
      const { reapDestroyHolders } = await import('../../packages/cezar/src/delegation/destroy-holders.ts');
      const current = () => {
        assertCurrent(); state.adapter.read();
        if (request.action === 'seed' && state.retained()) throw new Error('fixture-seeded-before-signal');
      };
      await reapDestroyHolders([request.resourceRoot], current, undefined, state.adapter);
    }
  } catch (failure) { error = failure; }
  finally { process.kill = kill; }
  assertCurrent();
  assertProcess(request.sibling);
  const target = processState(request.target), sibling = processState(request.sibling);
  const checkpointRetained = state.retained();
  if (request.action === 'retain' && error) {
    assert(error.message.endsWith(` ${request.target.pid}`), 'retention failure names a different process');
  }
  const { exitCode, ...decision } = verdict(request.action, {
    error, targetAlive: target.alive, siblingAlive: sibling.alive, retained: checkpointRetained, signals: signals.length,
  });
  finish({ ...decision, target, sibling, checkpointRetained, evidence, signals, ...(observation ? { observation } : {}) }, exitCode);
}

try { await run(); }
catch (error) {
  finish({ status: 'failed', code: 'fixture-or-reaper-failure', error: String(error).slice(0, 4096), signals }, 1);
} finally { clearTimeout(deadline); }
