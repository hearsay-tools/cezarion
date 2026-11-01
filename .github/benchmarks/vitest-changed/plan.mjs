import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chooseFiles, mandatoryFiles } from './policy.mjs';

export async function plan(root, base) {
  const start = performance.now();
  const require = createRequire(join(root, 'package.json'));
  const { createVitest } = await import(pathToFileURL(require.resolve('vitest/node')).href);
  const vitest = await createVitest('test', { root, watch: false, reporters: [],
    project: ['server', 'contract', 'api-client', 'web'] });
  try {
    const specs = await vitest.globTestSpecifications();
    const inventory = specs.map(spec => ({ file: relative(root, spec.moduleId), project: spec.project.name }));
    const paths = inventory.map(spec => spec.file);
    const inputs = JSON.parse(readFileSync(join(root, 'squeal.config.json'), 'utf8')).inputs;
    const mandatory = mandatoryFiles(paths, inputs);
    if (!mandatory.includes('packages/cezar/src/contract-import-boundaries.test.ts')) {
      throw new Error('The reproduced scanner must be a mandatory test');
    }
    let local = { mode: 'full', reason: 'Selector unavailable' };
    let related = [];
    let graphError;
    try {
      local = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts/test-changed.mjs'),
        `--base=${base}`, '--plan'], { cwd: root, encoding: 'utf8' }));
      if (local.mode === 'changed') {
        vitest.config.changed = false;
        vitest.config.related = local.files.map(file => join(root, file));
        related = (await vitest.getRelevantTestSpecifications()).map(spec => relative(root, spec.moduleId));
      }
    } catch (error) { graphError = error.message; }
    return { ...chooseFiles({ inventory: paths, related, mandatory, localMode: local.mode,
      localReason: local.reason, graphError }), inventory, mandatory, related, local,
      selectionMs: performance.now() - start };
  } finally { await vitest.close(); }
}

/** Use the application snapshot's exact sequencer, including its project-prefixed tie breaks. */
export async function shardFiles(root, inventory, selected, shard) {
  const { assignShards } = await import(pathToFileURL(join(root, '.github/scripts/ci-test-sequencer.mjs')).href);
  const durations = JSON.parse(readFileSync(join(root, '.github/test-durations.json'), 'utf8')).durationsMs;
  const specs = inventory.filter(spec => selected.includes(spec.file));
  const keys = specs.map(spec => `${spec.project}\0${spec.file}`);
  const weights = Object.fromEntries(specs.map((spec, index) => [keys[index], durations[spec.file]]));
  return assignShards(keys, weights, 4)[shard - 1].map(key => key.split('\0')[1]).sort();
}
