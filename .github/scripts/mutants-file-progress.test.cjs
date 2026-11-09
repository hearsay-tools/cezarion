'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProgressReporter, startProgress, progressConfig } = require('./mutants-file-progress.cjs');
function clock() {
  let now = 0;
  const timers = new Set();
  const logs = [];
  return { logs, now: () => now, log: line => logs.push(line), setInterval: callback => { timers.add(callback); return callback; }, clearInterval: timer => timers.delete(timer), tick: () => { now += 30000; for (const cb of timers) cb(); }, timers };
}
test('progress reports unknown preparation, then completed/total and elapsed with a fixed cadence', () => {
  const c = clock();
  const r = new ProgressReporter(c);
  assert.match(c.logs[0], /unknown/);
  r.onMutationTestingPlanReady({ mutantPlans: [{ mutant: { id: '1' } }, { mutant: { id: '2' } }] });
  r.onMutantTested({ id: '1' });
  r.onMutantTested({ id: '1' });
  c.tick();
  assert.match(c.logs.at(-1), /1\/2.*30s/);
  r.onMutantTested({ id: '2' });
  r.onMutationTestReportReady();
  assert.match(c.logs.at(-1), /2\/2/);
  assert.equal(c.timers.size, 0);
  r.wrapUp();
});
test('preparation and reporter cleanup stop timers on failure or cancellation too', () => {
  const c = clock();
  const finish = startProgress('Preparing committed HEAD', c);
  c.tick();
  assert.match(c.logs.at(-1), /Preparing.*unknown.*30s/);
  finish();
  assert.equal(c.timers.size, 0);
  const r = new ProgressReporter(c);
  r.wrapUp();
  const count = c.logs.length;
  c.tick();
  assert.equal(c.logs.length, count);
});
test('whole-file config preserves configured plugins and reporters', () => {
  const config = progressConfig({ plugins: ['vitest'], reporters: ['json'] });
  assert.deepEqual(config.plugins, ['vitest', './cezar-mutation-progress.cjs']);
  assert.deepEqual(config.reporters, ['json', 'cezar-progress']);
});

test('Stryker loads the copied reporter as a CommonJS plugin', async t => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutants-plugin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const plugin = path.join(dir, 'cezar-mutation-progress.cjs');
  fs.copyFileSync(path.join(__dirname, 'mutants-file-progress.cjs'), plugin);
  const core = path.dirname(require.resolve('@stryker-mutator/core'));
  const { PluginLoader } = await import(pathToFileURL(path.join(core, 'di/plugin-loader.js')).href);
  const warnings = [];
  const loader = new PluginLoader({ debug() {}, warn: message => warnings.push(message) });
  const loaded = await loader.load([plugin]);
  assert.deepEqual(warnings, []);
  const [definition] = loaded.pluginsByKind.get('Reporter');
  assert.equal(definition.name, 'cezar-progress');
  const c = clock();
  const reporter = new definition.injectableClass(c);
  reporter.onMutationTestingPlanReady({ mutantPlans: [] });
  reporter.onMutationTestReportReady();
  assert.match(c.logs.at(-1), /0\/0/);
  assert.equal(c.timers.size, 0);
});
