import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(packageRoot, 'dist/index.js');

test('built worker CLI runs without cez on PATH; headless provision stays local and exits cleanly', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cez-worker's-package-"));
  const cwd = join(root, 'empty working directory');
  await mkdir(cwd);
  const cleanEnv = { ...process.env, CEZ_HOME: join(root, 'home'), CEZ_DELEGATION_URL: '', CEZ_DELEGATION_TOKEN: '' };
  try {
    // The absolute installation entry is sufficient; the shell cannot find any cez executable.
    const command = await execFile(process.execPath, [cli, 'worker', 'inspect', '00000000-0000-4000-8000-000000000000'], {
      cwd, env: { ...cleanEnv, PATH: '' }, timeout: 15_000,
    }).then(result => ({ ...result, code: 0 }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }));
    assert.equal(command.code, 1);
    assert.equal(JSON.parse(command.stdout).code, 'unavailable_transport');
    assert.doesNotMatch(command.stderr, /Unknown option|Cannot find module/);

    // Exercise the instruction's shell quoting from an installation path containing spaces/apostrophes.
    const copied = join(root, "installation's copy"); await mkdir(copied);
    await cp(join(packageRoot, 'dist'), join(copied, 'dist'), { recursive: true });
    await writeFile(join(copied, 'package.json'), '{"type":"module"}');
    await symlink(resolve(packageRoot, '../../node_modules'), join(copied, 'node_modules'), 'dir');
    const provision = await import(pathToFileURL(join(copied, 'dist/delegation/provision.js')).href);
    const invocation: string = provision.bundledWorkerInvocation();
    const shell = await execFile('/bin/sh', ['-c', `${invocation} inspect 00000000-0000-4000-8000-000000000000`], {
      cwd, env: { ...cleanEnv, PATH: '' }, timeout: 15_000,
    }).then(result => ({ ...result, code: 0 }), error => ({ stdout: String(error.stdout), stderr: String(error.stderr), code: error.code }));
    assert.equal(shell.code, 1); assert.equal(JSON.parse(shell.stdout).code, 'unavailable_transport');

    const repo = join(root, 'repo'); await mkdir(repo);
    await execFile('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await execFile('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: repo });
    const run = await execFile(process.execPath, [cli, 'run', 'mock:done', '--repo', repo], {
      cwd, env: { ...cleanEnv, CEZ_DRY_RUN: '1', CEZ_DELEGATION: '1', CEZ_AUTONAME: '0' }, timeout: 60_000,
    });
    assert.match(run.stdout, /run (done|review)/);
    const records = JSON.parse(await readFile(join(repo, '.ai/cezar/runs.json'), 'utf8'));
    assert.equal(records.length, 1); assert.equal(records[0].delegation.role, 'root');
    assert.deepEqual(records[0].delegation.receipts, []);
    assert.doesNotMatch(JSON.stringify(records), /CEZ_DELEGATION_TOKEN|CEZ_DELEGATION_URL/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


// This catches missing installed entry points, lost acceptance receipts, slot-release
// wiring, attribution, and unchecked deletion. The only fake is the external Claude
// process; its stdin/stdout envelopes follow the existing stream-json golden wire.
test('installed CLI completes owned-worker lifecycle with lost spawn reply and one slot', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "cez-installed-workers-"));
  const saved = { ...process.env };
  let manager: import('../../src/workflows/run.ts').RunManager | undefined;
  let store: import('../../src/runs/store.ts').RunStore | undefined;
  let controller: import('../../src/delegation/provision.ts').DelegationController | undefined;
  const executions: Promise<unknown>[] = [];
  const turns: Promise<unknown>[] = [];
  const exists = async (path: string) => access(path).then(() => true, () => false);
  async function until(check: () => boolean | Promise<boolean>, label: string) {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `${label}; runs=${JSON.stringify(store?.listRuns())}`);
      await new Promise(done => setTimeout(done, 20));
    }
  }
  try {
    const pack = join(root, 'pack'); const consumer = join(root, "installation's directory");
    await mkdir(pack); await mkdir(consumer);
    const packed = await execFile('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', pack], { cwd: packageRoot });
    const tarball = JSON.parse(packed.stdout)[0].filename as string;
    await writeFile(join(consumer, 'package.json'), '{"private":true}');
    await execFile('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(pack, tarball)], { cwd: consumer });
    const installed = join(consumer, 'node_modules/@wjarka/cezarion');
    const load = (file: string) => import(pathToFileURL(join(installed, 'dist', file)).href);
    const { RunStore } = await load('runs/store.js') as typeof import('../../src/runs/store.ts');
    const { RunManager } = await load('workflows/run.js') as typeof import('../../src/workflows/run.ts');
    const { DelegationController, bundledWorkerInvocation } = await load('delegation/provision.js') as typeof import('../../src/delegation/provision.ts');
    const { WorkspaceSemaphore } = await load('workspace/semaphore.js') as typeof import('../../src/workspace/semaphore.ts');
    const { QUICK_TASK_WORKFLOW } = await load('workflows/types.js') as typeof import('../../src/workflows/types.ts');
    const repo = join(root, 'repo'); const wire = join(root, 'wire'); const home = join(root, 'claude-home');
    await mkdir(repo); await mkdir(wire); await mkdir(home);
    const git = (...args: string[]) => execFile('git', args, { cwd: repo });
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'test'); await git('config', 'user.email', 'test@local');
    await writeFile(join(repo, 'tracked.txt'), 'committed baseline\n');
    await git('add', 'tracked.txt'); await git('commit', '-qm', 'base');
    const baseline = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(repo, 'tracked.txt'), 'dirty parent only\n');
    await writeFile(join(repo, 'untracked.txt'), 'untracked parent only\n');
    const mock = join(root, 'claude-wire.mjs');
    await writeFile(mock, `#!${process.execPath}
import { createInterface } from 'node:readline';
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const wire = ${JSON.stringify(wire)};
const id = process.env.CEZ_TASK_ID;
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const sleep = ms => new Promise(done => setTimeout(done, ms));
let turn = 0, queue = Promise.resolve();
emit({ type: 'system', subtype: 'init', session_id: id });
const rl = createInterface({ input: process.stdin });
rl.on('line', line => {
  const message = JSON.parse(line);
  if (message.type !== 'user') return;
  queue = queue.then(async () => {
    const text = message.message.content.filter(b => b.type === 'text').map(b => b.text).join('\\n');
    appendFileSync(join(wire, id + '.inputs'), JSON.stringify({ text }) + '\\n');
    turn++;
    const parent = text.includes('package parent');
    if (turn === 1) {
      writeFileSync(join(wire, id + '.started'), JSON.stringify({ cwd: process.cwd(), pid: process.pid }));
      while (!existsSync(join(wire, id + '.release'))) await sleep(20);
      if (!parent) writeFileSync('tracked.txt', 'worker change\\n');
    }
    const reply = !parent && turn > 1 && text.includes('finish worker') ? 'Worker complete\\nCEZ:DONE' : 'Turn yielded';
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }], usage: { input_tokens: 1, output_tokens: 1 } } });
    emit({ type: 'result', subtype: 'success', result: reply, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 });
  });
});
rl.on('close', () => queue.then(() => process.exit(0)));
`, { mode: 0o755 });
    process.env.CEZ_HOME = join(root, 'cez-home'); process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DELEGATION = '1'; process.env.CEZ_AUTONAME = '0'; process.env.CEZ_REVIEW_GATE = '1';
    process.env.CEZ_CLAUDE_BIN = mock; process.env.CLAUDE_CONFIG_DIR = home;
    delete process.env.CEZ_DELEGATION_TOKEN; delete process.env.CEZ_DELEGATION_URL;
    store = RunStore.open(join(repo, '.ai/cezar'), { keepLive: true });
    const semaphore = new WorkspaceSemaphore({ initial: { maxParallel: 1 } });
    manager = new RunManager(store, repo, { semaphore });
    // Observe the real provisioner without replacing its identity, environment,
    // instructions, credential generation, or revocation behavior.
    const environments = new Map<string, Record<string, string>>();
    const setProvisioner = manager.setDelegationProvisioner.bind(manager);
    manager.setDelegationProvisioner = provisioner => setProvisioner(id => {
      const session = provisioner(id); if (session) environments.set(id, session.env); return session;
    });
    const engine = manager as unknown as Record<'execute' | 'runContinuation' | 'recordTurnEnd', (...args: unknown[]) => Promise<unknown>>;
    for (const name of ['execute', 'runContinuation', 'recordTurnEnd'] as const) {
      const real = engine[name].bind(manager);
      engine[name] = (...args) => { const promise = real(...args); (name === 'recordTurnEnd' ? turns : executions).push(promise); return promise; };
    }
    controller = await DelegationController.start();
    controller.attachProject({ id: 'package-project', root: repo, store, manager });
    const parent = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'package parent', runner: 'claude', worktree: false });
    await until(() => exists(join(wire, parent.id + '.started')), 'parent process starts');
    const invocation = bundledWorkerInvocation();
    assert.ok(invocation.includes(installed.replaceAll("'", "'\\''")), 'provisioned invocation points inside installed tarball');
    const command = async (args: string[], discard = false) => {
      const quoted = args.map(arg => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
      const result = await execFile('/bin/sh', ['-c', `${invocation} ${quoted}`], {
        cwd: consumer, env: { ...process.env, ...environments.get(parent.id), PATH: '' }, timeout: 45_000,
      });
      assert.equal(result.stderr, '');
      return discard ? undefined : JSON.parse(result.stdout);
    };
    const request = randomUUID(); const spawn = ['spawn', '--baseline', 'parent-head', '--request-id', request, 'package worker'];
    await command(spawn, true); // Deliberately lose the accepted response before the caller sees its ID.
    const receipt = store.getRun(parent.id)!.delegation;
    assert.equal(receipt?.role, 'root'); if (receipt?.role !== 'root') throw Error('missing root');
    assert.equal(receipt.receipts.length, 1);
    const workerId = receipt.receipts[0]!.workerId;
    assert.equal(store.getRun(workerId)?.status, 'queued'); assert.equal(semaphore.busy(), 1);
    assert.equal(await exists(join(wire, workerId + '.started')), false);
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'dirty parent only\n');
    await git('commit', '--allow-empty', '-qm', 'parent moved after acceptance');
    assert.deepEqual(await command(spawn), { workerId, baselineSha: baseline });
    assert.equal(store.listRuns().length, 2);
    const wait = await command(['wait', workerId]);
    assert.equal(wait.wait.phase, 'registered'); assert.match(wait.instruction, /End your turn/);
    await writeFile(join(wire, parent.id + '.release'), 'yield');
    await until(() => exists(join(wire, workerId + '.started')), 'worker admitted after parent yields');
    const parked = store.getRun(parent.id)?.delegation;
    assert.equal(parked?.role === 'root' && parked.wait?.phase, 'parked'); assert.equal(semaphore.busy(), 1);
    const inspection = await command(['inspect', workerId]);
    assert.equal(inspection.parentRunId, parent.id); assert.equal(inspection.status, 'running');
    const workspace = inspection.workspace;
    assert.equal(workspace.baselineSha, baseline);
    assert.equal(await readFile(join(workspace.path, 'tracked.txt'), 'utf8'), 'committed baseline\n');
    assert.equal(await exists(join(workspace.path, 'untracked.txt')), false);
    const steering = await command(['steer', workerId, 'finish worker']);
    assert.ok(['queued', 'delivered'].includes(steering.state));
    await writeFile(join(wire, workerId + '.release'), 'yield');
    await until(() => store!.getRun(workerId)?.status === 'review', 'worker reaches human review');
    await until(() => store!.getRun(parent.id)?.agentInputs?.some(input => input.source === 'lifecycle' && !!input.deliveredAt) === true, 'terminal worker wakes parent');
    assert.equal(await manager.awaitRunTermination(workerId, 15_000), true);
    assert.equal(store.getRun(workerId)?.agentInputs?.[0]?.source, 'agent');
    assert.equal(store.readEvents(workerId).filter(event => event.type === 'user-message').length, 0);
    const diff = await command(['diff', workerId]);
    assert.match(diff.diff, /worker change/); assert.doesNotMatch(diff.diff, /dirty parent only|untracked parent only/);
    assert.equal(diff.baselineSha, baseline); assert.equal(diff.truncated, false);
    assert.equal((await command(['stop', workerId])).state, 'terminated');
    assert.equal(store.getRun(workerId)?.status, 'review', 'stop never accepts review');
    const destroyed = { workerId, state: 'complete', remaining: [], deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` },
    ] };
    assert.deepEqual(await command(['destroy', workerId]), destroyed);
    assert.deepEqual(await command(['destroy', workerId]), destroyed);
    assert.equal(await exists(workspace.path), false);
    assert.doesNotMatch((await git('worktree', 'list', '--porcelain')).stdout, new RegExp(workerId));
    assert.equal((await git('branch', '--list', workspace.branch)).stdout.trim(), '');
    assert.equal(store.getRun(workerId)?.status, 'review', 'destroy preserves the review history');
    assert.ok(store.readEvents(workerId).length > 0);
    assert.equal(await readFile(join(repo, 'tracked.txt'), 'utf8'), 'dirty parent only\n');
    const publicState = JSON.stringify([store.listRuns(), ...store.listRuns().map(run => store!.readEvents(run.id))]);
    for (const env of environments.values()) assert.equal(publicState.includes(env.CEZ_DELEGATION_TOKEN!), false);
  } finally {
    if (manager && store) {
      for (const run of store.listRuns()) {
        await writeFile(join(root, 'wire', run.id + '.release'), 'teardown');
        manager.cancel(run.id);
      }
      for (const run of store.listRuns()) if (run.delegation?.role === 'worker') assert.equal(await manager.awaitRunTermination(run.id, 15_000), true);
      await Promise.all(executions); await Promise.all(turns);
      manager.dispose(); store.flush();
    }
    await controller?.close();
    process.env = saved;
    await rm(root, { recursive: true, force: true });
  }
});
