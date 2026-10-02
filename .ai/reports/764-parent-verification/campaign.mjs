import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, loadavg, freemem } from 'node:os';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const { createLane, removeLane } = await import(pathToFileURL(join(repo, '.ai/scripts/e2e-lanes.mjs')));
const phase = process.argv[2];
if (!['idle', 'load'].includes(phase)) throw Error('expected idle or load');
const count = phase === 'idle' ? 1 : 8;
const output = join(repo, '.ai/qa/764-final', `${phase}-${Date.now()}`);
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'cez764-'));
const baseRef = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const filters = ['progressive-history.e2e.ts', 'github-layout.e2e.ts', 'github-states.e2e.ts', 'task-views-layout.e2e.ts', 'skills-update.e2e.ts', '-t', 'loads exactly one page|consumes one upward intent|hands focus on.*1440|handoff fields usable at 1440.*light|refresh then settle as .*ready.*1440.*light|without cached boards.*long names.*1440.*light|renders GitHub.*loading.*light|persists column choices|shows the inherited global preference', '--reporter=verbose'];
const active = new Set();
const results = [];
let interrupted = false;
function stop() { interrupted = true; for (const c of active) { try { process.kill(-c.pid, 'SIGTERM'); } catch {} } }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
async function run(command, args, cwd, env, log) {
  const fd = openSync(log, 'w');
  const start = Date.now();
  try {
    const code = await new Promise((done, reject) => {
      const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
      active.add(child);
      child.on('error', e => { active.delete(child); reject(e); });
      child.on('close', (code, signal) => { active.delete(child); done(signal ? 1 : code ?? 1); });
    });
    return { code, elapsedMs: Date.now() - start };
  } finally { closeSync(fd); }
}
function sample(lanes, round) {
  let browserRoots = 0, browserProcesses = 0, nodes = 0, ownedRoots = 0;
  for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (name === 'node') nodes++;
      if (/chrome|chromium/.test(name)) {
        browserProcesses++;
        const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (args.some(a => a.startsWith('--remote-debugging-')) && !args.some(a => a.startsWith('--type='))) {
          browserRoots++;
          if (lanes.some(l => args.some(a => a.includes(l.namespace)))) ownedRoots++;
        }
      }
    } catch {}
  }
  const sessions = lanes.map(l => {
    try {
      const result = JSON.parse(execFileSync(l.descriptor.browser.command, ['--namespace', l.namespace, 'session', 'list', '--json'], { env: { ...l.env, ...l.descriptor.browser.runtimeEnv }, encoding: 'utf8', timeout: 2000 }));
      return { lane: l.index, namespace: l.namespace, sessions: result.data?.sessions ?? [], success: result.success };
    } catch (e) { return { lane: l.index, error: String(e) }; }
  });
  appendFileSync(join(output, 'host-samples.ndjson'), JSON.stringify({ sessions, at: new Date().toISOString(), round, runningCommands: active.size, lanes: lanes.length, browserRoots, browserProcesses, ownedRootsByNamespace: ownedRoots, nodes, loadavg: loadavg(), freeBytes: freemem() }) + '\n');
}
writeFileSync(join(output, 'setup.json'), JSON.stringify({ phase, count, rounds: 10, baseRef, filters, scratch, note: 'One serial Vitest invocation per simulated task. Eight-task load is eight concurrent isolated selected test invocations, not eight full four-lane suites. Global process counts include unrelated host work; namespace matching can undercount Chrome roots if profile paths omit namespace.' }, null, 2));
console.log(output);
for (let round = 1; round <= 10 && !interrupted; round++) {
  const lanes = [];
  let timer;
  try {
    for (let i = 1; i <= count; i++) {
      const index = (round - 1) * count + i;
      const root = createLane({ repoRoot: repo, scratchRoot: scratch, index, baseRef });
      const namespace = `x${(process.pid * 100 + index).toString(36)}`;
      const env = { ...process.env, E2E_PREBUILT_ASSETS: '1', E2E_BROWSER_NAMESPACE: namespace };
      delete env.CEZ_AUTOMATIONS;
      const logRoot = join(output, `round-${round}-lane-${i}`); mkdirSync(logRoot);
      const lane = { root, namespace, env, logRoot, index: i }; lanes.push(lane);
      const boot = await run('sh', ['.ai/scripts/test-env-up.sh'], root, env, join(logRoot, 'boot.log'));
      if (boot.code !== 0) throw Error(`boot failed ${logRoot}`);
      lane.descriptor = JSON.parse(readFileSync(join(root, '.ai/qa/test-env.json')));
      if (!lane.descriptor.browser?.installed) throw Error(`browser skipped ${logRoot}`);
    }
    sample(lanes, round); timer = setInterval(() => sample(lanes, round), 1000);
    const batch = await Promise.all(lanes.map(async l => {
      const result = await run('sh', ['.ai/scripts/e2e.sh', ...filters], l.root, l.env, join(l.logRoot, 'tests.log'));
      const log = readFileSync(join(l.logRoot, 'tests.log'), 'utf8');
      return { round, lane: l.index, namespace: l.namespace, baseUrl: l.descriptor.baseUrl, ...result, passed: result.code === 0 && /TEST_E2E_STATUS=passed/.test(log) };
    }));
    results.push(...batch);
    writeFileSync(join(output, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`round ${round}: ${batch.filter(r => r.passed).length}/${count} passed`);
    if (batch.some(r => !r.passed)) { process.exitCode = 1; break; }
  } finally {
    clearInterval(timer);
    for (const l of lanes.reverse()) {
      for (const path of ['failures', 'test-env.json', 'test-env-app.log', 'artifacts_e2e']) {
        const source = join(l.root, '.ai/qa', path);
        if (existsSync(source)) cpSync(source, join(l.logRoot, path), { recursive: true });
      }
      const b = l.descriptor?.browser;
      if (b?.installed) await run(b.command, ['--namespace', l.namespace, 'close', '--all'], l.root, { ...l.env, ...b.runtimeEnv }, join(l.logRoot, 'browser-down.log'));
      const down = await run('sh', ['.ai/scripts/test-env-down.sh'], l.root, l.env, join(l.logRoot, 'down.log'));
      if (down.code === 0) removeLane({ repoRoot: repo, laneRoot: l.root });
      else { console.error(`retained lane after teardown failure: ${l.root}`); process.exitCode = 1; }
    }
  }
}
console.log(`CAMPAIGN_${phase.toUpperCase()}=${results.length === count * 10 && results.every(r => r.passed) && !process.exitCode ? 'passed' : 'failed'}`);
